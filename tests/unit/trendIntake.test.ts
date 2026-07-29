import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSnapshotKeys, resetSnapshotStore, writeSnapshot } from '../../src/lib/cache/snapshot';
import {
  drainPendingTrends,
  enqueueTrendHarvest,
  intakeTtlHours,
  listPendingTrendBatches,
  partitionByFreshness,
  pendingTrendBacklog,
  pendingTrendsAsTrends,
  pruneExpiredTrendBatches,
  type QueuedTrendRow,
} from '../../src/lib/services/trendIntake';

let dir: string;

const HOUR = 3_600_000;

function row(keyword: string, region = 'US'): QueuedTrendRow {
  return {
    id: `id-${region}-${keyword}`,
    keyword,
    searchVolume: 50_000,
    growthRate: 80,
    category: 'trending',
    timeRange: '4h',
    region,
    topicClass: 'general',
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'intake-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  delete process.env.TRENDS_INTAKE_TTL_HOURS;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.TRENDS_INTAKE_TTL_HOURS;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('queueing a harvest', () => {
  it('stores the rows with the time the feed was read', async () => {
    const harvestedAt = new Date(Date.now() - 2 * HOUR);
    const key = await enqueueTrendHarvest([row('alpha'), row('beta')], harvestedAt);

    expect(key).toMatch(/^trends\/pending\//);
    const batches = await listPendingTrendBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0].batch.rows).toHaveLength(2);
    expect(batches[0].batch.harvestedAt).toBe(harvestedAt.toISOString());
  });

  it('queues nothing for an empty harvest', async () => {
    expect(await enqueueTrendHarvest([])).toBeNull();
    expect(await listPendingTrendBatches()).toHaveLength(0);
  });

  it('lists batches oldest first, so the drain replays them in order', async () => {
    await enqueueTrendHarvest([row('old')], new Date(Date.now() - 5 * HOUR));
    await enqueueTrendHarvest([row('new')], new Date(Date.now() - 1 * HOUR));

    const keywords = (await listPendingTrendBatches()).map((b) => b.batch.rows[0].keyword);
    expect(keywords).toEqual(['old', 'new']);
  });

  it('skips an entry whose payload is not a batch', async () => {
    await writeSnapshot('trends/pending/garbage', { nothing: true });
    expect(await listPendingTrendBatches()).toHaveLength(0);
  });
});

describe('expiry', () => {
  it('keeps a harvest exactly as long as the picker would still consider it', () => {
    const now = new Date();
    const batches = [
      { key: 'a', batch: { batchId: 'a', harvestedAt: new Date(now.getTime() - 47 * HOUR).toISOString(), rows: [] } },
      { key: 'b', batch: { batchId: 'b', harvestedAt: new Date(now.getTime() - 49 * HOUR).toISOString(), rows: [] } },
    ];

    const { fresh, expired } = partitionByFreshness(batches, now);
    expect(fresh.map((f) => f.key)).toEqual(['a']);
    expect(expired.map((e) => e.key)).toEqual(['b']);
  });

  it('treats an unparseable harvest time as expired rather than keeping it forever', () => {
    const batches = [{ key: 'x', batch: { batchId: 'x', harvestedAt: 'not-a-date', rows: [] } }];
    expect(partitionByFreshness(batches).expired).toHaveLength(1);
  });

  it('honours TRENDS_INTAKE_TTL_HOURS', () => {
    process.env.TRENDS_INTAKE_TTL_HOURS = '6';
    expect(intakeTtlHours()).toBe(6);
    const batches = [
      { key: 'a', batch: { batchId: 'a', harvestedAt: new Date(Date.now() - 8 * HOUR).toISOString(), rows: [] } },
    ];
    expect(partitionByFreshness(batches).expired).toHaveLength(1);
  });

  it('ignores a nonsensical TTL', () => {
    process.env.TRENDS_INTAKE_TTL_HOURS = '0';
    expect(intakeTtlHours()).toBe(48);
  });

  it('deletes expired batches during maintenance', async () => {
    await enqueueTrendHarvest([row('ancient')], new Date(Date.now() - 100 * HOUR));
    await enqueueTrendHarvest([row('recent')], new Date(Date.now() - 1 * HOUR));

    expect(await pruneExpiredTrendBatches()).toBe(1);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(1);
  });
});

describe('serving queued hotwords to the picker', () => {
  it('presents them as trends carrying their real observation time', async () => {
    const harvestedAt = new Date(Date.now() - 3 * HOUR);
    await enqueueTrendHarvest([row('alpha'), row('alpha', 'GB')], harvestedAt);

    const trends = await pendingTrendsAsTrends();

    expect(trends).toHaveLength(2);
    expect(trends[0].id).toBe('id-US-alpha');
    expect(trends[0].timestamp.toISOString()).toBe(harvestedAt.toISOString());
    expect(trends.map((t) => t.region)).toEqual(['US', 'GB']);
  });

  it('withholds hotwords too old to analyze', async () => {
    await enqueueTrendHarvest([row('ancient')], new Date(Date.now() - 100 * HOUR));
    expect(await pendingTrendsAsTrends()).toHaveLength(0);
  });
});

describe('draining the queue', () => {
  it('persists each batch with its own harvest time, then deletes it', async () => {
    const first = new Date(Date.now() - 5 * HOUR);
    const second = new Date(Date.now() - 2 * HOUR);
    await enqueueTrendHarvest([row('old')], first);
    await enqueueTrendHarvest([row('new')], second);
    const persist = vi.fn(async (rows: QueuedTrendRow[]) => ({ inserted: rows.length, skipped: 0 }));

    const summary = await drainPendingTrends(persist);

    expect(summary).toMatchObject({ inserted: 2, batches: 2, remaining: 0 });
    expect(persist.mock.calls[0][1].toISOString()).toBe(first.toISOString());
    expect(persist.mock.calls[1][1].toISOString()).toBe(second.toISOString());
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(0);
  });

  it('keeps everything queued when the database is still unavailable', async () => {
    await enqueueTrendHarvest([row('alpha')], new Date());
    await enqueueTrendHarvest([row('beta')], new Date());
    const persist = vi.fn(async () => {
      throw new Error('DB unavailable (circuit breaker open)');
    });

    const summary = await drainPendingTrends(persist);

    // Stops at the first failure rather than retrying each batch in turn.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(summary.remaining).toBe(2);
    expect(summary.errors).toHaveLength(1);
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(2);
  });

  it('reports rows the store deduplicated away', async () => {
    await enqueueTrendHarvest([row('alpha'), row('beta')], new Date());
    const persist = vi.fn(async () => ({ inserted: 1, skipped: 1 }));

    const summary = await drainPendingTrends(persist);

    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('drops expired batches without spending a database round trip on them', async () => {
    await enqueueTrendHarvest([row('ancient'), row('older')], new Date(Date.now() - 100 * HOUR));
    const persist = vi.fn(async () => ({ inserted: 0, skipped: 0 }));

    const summary = await drainPendingTrends(persist);

    expect(persist).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ expiredBatches: 1, expiredRows: 2, inserted: 0 });
    expect(await listSnapshotKeys('trends/pending/')).toHaveLength(0);
  });
});

describe('backlog reporting', () => {
  it('counts only replayable rows and names the oldest harvest', async () => {
    const oldest = new Date(Date.now() - 4 * HOUR);
    await enqueueTrendHarvest([row('a'), row('b')], oldest);
    await enqueueTrendHarvest([row('c')], new Date());
    await enqueueTrendHarvest([row('expired')], new Date(Date.now() - 100 * HOUR));

    expect(await pendingTrendBacklog()).toEqual({
      batches: 2,
      rows: 3,
      oldestHarvestedAt: oldest.toISOString(),
    });
  });

  it('reports an empty backlog on a healthy site', async () => {
    expect(await pendingTrendBacklog()).toEqual({ batches: 0, rows: 0, oldestHarvestedAt: null });
  });
});
