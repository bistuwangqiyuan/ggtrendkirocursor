import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const query = vi.fn();
const queryOne = vi.fn();

vi.mock('../../src/lib/db/client', () => ({
  query,
  queryOne,
  getTrendsTableName: vi.fn(async () => 'google_trends'),
  getTimestampColumnName: vi.fn(async () => 'trend_timestamp'),
}));

vi.mock('../../src/lib/services/bp', () => ({ bpService: { getById: vi.fn() } }));
vi.mock('../../src/lib/services/siteMonitor', () => ({
  siteMonitorService: { listSitesWithLatestCheck: vi.fn(async () => []) },
}));
vi.mock('../../src/lib/services/trends', () => ({
  trendsService: { getCategories: vi.fn(async () => ({ success: true, data: ['trending'] })) },
}));

const { rebuildAllSnapshots } = await import('../../src/lib/cache/snapshotBuilder');
const { readSnapshot, listSnapshotKeys, resetSnapshotStore } = await import('../../src/lib/cache/snapshot');

let dir: string;

/** `count` keywords, each with one history row, as the aggregate query returns them. */
function keywordAggregates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    keyword: `keyword ${i}`,
    search_volume: 1000 + i,
    growth_rate: 80,
    region: 'US',
    last_seen: new Date('2026-07-26T00:00:00Z'),
    appearances: 1,
  }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapbuild-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  resetSnapshotStore();
  vi.clearAllMocks();
  queryOne.mockResolvedValue({ total: '0' });
  query.mockResolvedValue([]);
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.LANDING_DETAIL_WRITES_PER_RUN;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('time budget', () => {
  it('stops writing landing details at the deadline and reports the section as truncated', async () => {
    // The aggregate query returns the keyword list; history and BP lookups are
    // irrelevant to this test, so an empty result is fine for both.
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('GROUP BY keyword')) return keywordAggregates(50);
      return [];
    });

    // A budget of zero means the deadline has already passed by the time the
    // detail loop starts: the index must still be written, no detail may be.
    const report = await rebuildAllSnapshots({ only: ['landing'], budgetMs: 0 });

    expect(report.ok).toBe(true);
    expect(report.truncated).toContain('landing');
    const index = await readSnapshot<{ keywords: unknown[] }>('landing/index');
    expect(index?.data.keywords).toHaveLength(50);
    expect(await listSnapshotKeys('landing/detail/')).toHaveLength(0);
  });

  it('finishes the leftover details on the next run', async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('GROUP BY keyword')) return keywordAggregates(5);
      return [];
    });

    const interrupted = await rebuildAllSnapshots({ only: ['landing'], budgetMs: 0 });
    expect(interrupted.truncated).toContain('landing');
    expect(await listSnapshotKeys('landing/detail/')).toHaveLength(0);

    const resumed = await rebuildAllSnapshots({ only: ['landing'] });
    expect(resumed.truncated).not.toContain('landing');
    expect(await listSnapshotKeys('landing/detail/')).toHaveLength(5);
    expect(resumed.written.landing).toBe(6); // index + 5 details

    // A third run has nothing left to do, which is what keeps the cron cheap.
    const steady = await rebuildAllSnapshots({ only: ['landing'] });
    expect(steady.written.landing).toBe(1);
  });

  it('skips sections it never reached and leaves the rest untouched', async () => {
    const report = await rebuildAllSnapshots({ only: ['trends', 'bp', 'monitor'], budgetMs: -1 });
    expect(report.skipped).toEqual(['trends', 'bp', 'monitor']);
    expect(report.written).toEqual({});
  });

  it('records a failing section without aborting the others', async () => {
    queryOne.mockRejectedValueOnce(new Error('compute quota exceeded'));
    const report = await rebuildAllSnapshots({ only: ['trends', 'monitor'] });
    expect(report.ok).toBe(false);
    expect(report.errors.trends).toContain('compute quota exceeded');
    expect(report.written.monitor).toBe(1);
  });
});
