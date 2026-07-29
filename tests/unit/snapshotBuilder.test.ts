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
  trendsTableHasColumn: vi.fn(async () => true),
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

/**
 * A budget that is still open when the section starts and spent by the time its
 * detail loop begins, without depending on how fast the machine is: the keyword
 * query takes longer than the whole budget, exactly as a slow database read would.
 */
const SLOW_QUERY_MS = 40;
const SPENT_BY_QUERY_BUDGET_MS = 20;

describe('time budget', () => {
  it('stops writing landing details at the deadline and reports the section as truncated', async () => {
    // The aggregate query returns the keyword list; history and BP lookups are
    // irrelevant to this test, so an empty result is fine for both.
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('GROUP BY keyword')) {
        await new Promise((r) => setTimeout(r, SLOW_QUERY_MS));
        return keywordAggregates(50);
      }
      return [];
    });

    // The index must still be written; no detail may be.
    const report = await rebuildAllSnapshots({ only: ['landing'], budgetMs: SPENT_BY_QUERY_BUDGET_MS });

    expect(report.ok).toBe(true);
    expect(report.truncated).toContain('landing');
    const index = await readSnapshot<{ keywords: unknown[] }>('landing/index');
    expect(index?.data.keywords).toHaveLength(50);
    expect(await listSnapshotKeys('landing/detail/')).toHaveLength(0);
  });

  it('finishes the leftover details on the next run', async () => {
    let slow = true;
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('GROUP BY keyword')) {
        if (slow) await new Promise((r) => setTimeout(r, SLOW_QUERY_MS));
        return keywordAggregates(5);
      }
      return [];
    });

    const interrupted = await rebuildAllSnapshots({ only: ['landing'], budgetMs: SPENT_BY_QUERY_BUDGET_MS });
    expect(interrupted.truncated).toContain('landing');
    slow = false;
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

describe('stats section', () => {
  /** Route each aggregate query to a canned result by matching its SQL. */
  function mockStatsQueries() {
    queryOne.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('COUNT(DISTINCT keyword)')) return { n: '90' };
      if (s.includes('FROM bp_reports WHERE status = \'completed\'')) return { n: '8' };
      if (s.includes('FROM bp_reports WHERE status = \'failed\'')) return { n: '2' };
      if (s.includes('canonical_report_id IS NOT NULL')) return { n: '3' };
      if (s.includes('FROM bp_reports WHERE created_at')) return { n: '7' };
      if (s.includes('COUNT(*) AS n FROM bp_reports')) return { n: '10' };
      if (s.includes('FROM users')) return { n: '4' };
      if (s.includes('newsletter_subscribers')) return { n: '5' };
      if (s.includes('FROM feedback')) return { n: '6' };
      if (s.includes('monitored_sites')) return { n: '1' };
      if (s.includes('MAX(trend_timestamp)')) return { ts: '2026-07-26T00:00:00.000Z' };
      if (s.includes('MAX(created_at)')) return { ts: '2026-07-25T00:00:00.000Z' };
      return { n: '120' };
    });

    query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("COALESCE(topic_class")) {
        return [
          { topic: 'sports', n: '50' },
          { topic: 'entertainment', n: '30' },
          { topic: 'general', n: '40' },
        ];
      }
      if (s.includes('FROM bp_reports WHERE created_at >=') && s.includes('GROUP BY 1')) {
        return [{ d: '2026-07-25', total: '5', completed: '4', failed: '1' }];
      }
      if (s.includes('FROM users WHERE created_at >=')) return [{ d: '2026-07-26', n: '2' }];
      if (s.includes('date_trunc') && s.includes('trend_timestamp >=')) {
        return [{ d: '2026-07-26', n: '40' }, { d: '2026-07-25', n: '35' }];
      }
      if (s.includes('GROUP BY keyword')) {
        return [{ keyword: 'tax refund', appearances: '9', search_volume: '200000' }];
      }
      if (s.includes('risk_adjusted_num')) {
        return [{ id: 'r1', keyword: 'tax refund', title: 'A plan', risk_adjusted: '42%' }];
      }
      return [];
    });
  }

  it('aggregates totals, a daily series and the topic mix into one snapshot', async () => {
    mockStatsQueries();
    const report = await rebuildAllSnapshots({ only: ['stats'] });
    expect(report.ok).toBe(true);

    const snap = await readSnapshot<any>('stats/overview');
    expect(snap?.data.totals).toMatchObject({
      keywords: 90, bpTotal: 10, bpCompleted: 8, bpFailed: 2, bpDuplicates: 3, users: 4,
    });
    expect(snap?.data.topicMix).toEqual({
      sports: 50, entertainment: 30, general: 40, unclassified: 0,
    });
    // Chronological, so a chart reads left to right.
    expect(snap?.data.daily.map((d: any) => d.date)).toEqual(['2026-07-25', '2026-07-26']);
    expect(snap?.data.content.topKeywords[0]).toMatchObject({
      keyword: 'tax refund', slug: 'tax-refund', appearances: 9,
    });
  });

  it('merges each daily source onto the same date', async () => {
    mockStatsQueries();
    await rebuildAllSnapshots({ only: ['stats'] });
    const snap = await readSnapshot<any>('stats/overview');
    const day = snap?.data.daily.find((d: any) => d.date === '2026-07-25');
    expect(day).toMatchObject({ trendsCollected: 35, bpCreated: 5, bpCompleted: 4, bpFailed: 1 });
  });

  it('still writes a snapshot when a table this database lacks is queried', async () => {
    // newsletter_subscribers is missing in some deployments; one absent table
    // must not cost the whole statistics page.
    queryOne.mockRejectedValue(new Error('relation does not exist'));
    query.mockRejectedValue(new Error('relation does not exist'));

    const report = await rebuildAllSnapshots({ only: ['stats'] });
    expect(report.ok).toBe(true);
    const snap = await readSnapshot<any>('stats/overview');
    expect(snap?.data.totals.bpTotal).toBe(0);
  });
});
