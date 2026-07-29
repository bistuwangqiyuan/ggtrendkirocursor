import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The collector's storage half: dedupe, the collection timestamp it writes, and
 * what happens to a harvest when Postgres is unavailable.
 *
 * db/client is mocked (there is no database in a unit test) but the Blobs layer is
 * not: the intake queue is the mechanism under test, so it runs against the real
 * filesystem backend.
 */
const queryMock = vi.fn(async (_sql: string, _params?: any[]) => [] as any[]);
const clientQuery = vi.fn(async (_sql: string, _params?: any[]) => ({ rowCount: 0 }) as any);
const release = vi.fn();
let dbDown = false;

vi.mock('../../src/lib/db/client', () => ({
  query: (sql: string, params?: any[]) => queryMock(sql, params),
  getClient: async () => ({ query: clientQuery, release }),
  getTrendsTableName: async () => 'google_trends',
  getTimestampColumnName: async () => 'trend_timestamp',
  trendsTableHasColumn: async () => true,
  isDbDown: () => dbDown,
}));

const { TrendsCollector } = await import('../../src/lib/services/trendsCollector');
const { listSnapshotKeys, readSnapshot, resetSnapshotStore } = await import('../../src/lib/cache/snapshot');

let dir: string;

function feed(...keywords: string[]): string {
  const items = keywords
    .map((k) => `<item><title>${k}</title><ht:approx_traffic>100,000+</ht:approx_traffic></item>`)
    .join('');
  return `<?xml version="1.0"?><rss xmlns:ht="x"><channel>${items}</channel></rss>`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collector-store-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  resetSnapshotStore();
  vi.clearAllMocks();
  dbDown = false;
  queryMock.mockResolvedValue([]);
  clientQuery.mockImplementation(async () => ({ rowCount: 0 }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => feed('alpha', 'beta') })));
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  resetSnapshotStore();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('harvest', () => {
  it('reads the feed without touching the database', async () => {
    const harvest = await new TrendsCollector().harvest(['US']);

    expect(harvest.rows).toHaveLength(2);
    expect(queryMock).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
    // Every row carries an id from the start, so a plan can reference it before
    // it reaches Postgres.
    expect(harvest.rows.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  it('records a per-geo fetch failure without losing the other geos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('GB')
          ? { ok: false, status: 429, text: async () => '' }
          : { ok: true, status: 200, text: async () => feed('alpha') }
      )
    );

    const harvest = await new TrendsCollector().harvest(['US', 'GB']);

    expect(harvest.rows).toHaveLength(1);
    expect(harvest.errors).toEqual(['GB: fetch failed']);
  });
});

describe('persist', () => {
  it('writes the harvest time it was given, not the moment of the insert', async () => {
    const collectedAt = new Date('2026-07-20T10:00:00.000Z');
    const rows = (await new TrendsCollector().harvest(['US'])).rows;

    await new TrendsCollector().persist(rows, collectedAt);

    const [sql, params] = clientQuery.mock.calls[0];
    expect(sql).toContain('trend_timestamp');
    // A replayed row must age from when it was observed, or /trends would
    // present a two-day-old spike as breaking news.
    expect(params).toContain(collectedAt);
  });

  it('skips keywords already stored for the same region', async () => {
    queryMock.mockResolvedValue([{ region: 'US', keyword: 'Alpha' }]);
    const rows = (await new TrendsCollector().harvest(['US'])).rows;

    const result = await new TrendsCollector().persist(rows);

    expect(result.skipped).toBe(1);
    const inserted = clientQuery.mock.calls[0][1] as any[];
    expect(inserted).toContain('beta');
    expect(inserted).not.toContain('alpha');
  });

  it('asks for every region in the batch in one dedupe query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => feed('alpha') })));
    const rows = (await new TrendsCollector().harvest(['US', 'GB'])).rows;

    await new TrendsCollector().persist(rows);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]?.[0]).toEqual(['US', 'GB']);
    // Dedupe is per region, so the same keyword in two regions is two rows.
    expect(clientQuery.mock.calls[0][1]).toHaveLength(18);
  });

  it('refuses to run while the breaker is open, rather than deduping against an empty result', async () => {
    dbDown = true;
    const rows = (await new TrendsCollector().harvest(['US'])).rows;

    await expect(new TrendsCollector().persist(rows)).rejects.toThrow(/unavailable/i);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('does nothing for an empty batch', async () => {
    const result = await new TrendsCollector().persist([]);
    expect(result.inserted).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('collect', () => {
  it('stores the harvest when the database is available', async () => {
    clientQuery.mockResolvedValue({ rowCount: 2 });

    const summary = await new TrendsCollector().collect(['US']);

    expect(summary.inserted).toBe(2);
    expect(summary.deferred).toBe(0);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(0);
  });

  it('queues the harvest instead of losing it when the database is down', async () => {
    dbDown = true;

    const summary = await new TrendsCollector().collect(['US']);

    expect(summary.inserted).toBe(0);
    expect(summary.deferred).toBe(2);
    expect(summary.errors[0]).toMatch(/queued 2 row/);
    const keys = await listSnapshotKeys('trends/pending/');
    expect(keys).toHaveLength(1);
    const queued = await readSnapshot<any>(keys[0]);
    expect(queued?.data.rows.map((r: any) => r.keyword)).toEqual(['alpha', 'beta']);
  });

  it('reports a feed that returned nothing without queuing an empty batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));

    const summary = await new TrendsCollector().collect(['US']);

    expect(summary.inserted).toBe(0);
    expect(summary.deferred).toBe(0);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(0);
  });
});

describe('drainPending', () => {
  it('lands hotwords queued during an outage once the database returns', async () => {
    dbDown = true;
    await new TrendsCollector().collect(['US']);

    dbDown = false;
    clientQuery.mockResolvedValue({ rowCount: 2 });
    const drained = await new TrendsCollector().drainPending();

    expect(drained.inserted).toBe(2);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(0);
  });

  it('leaves the queue intact while the database is still down', async () => {
    dbDown = true;
    await new TrendsCollector().collect(['US']);

    const drained = await new TrendsCollector().drainPending();

    expect(drained.inserted).toBe(0);
    expect(drained.remaining).toBe(1);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(1);
  });
});
