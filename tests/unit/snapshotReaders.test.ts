import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_KEYS, writeSnapshot, resetSnapshotStore } from '../../src/lib/cache/snapshot';
import {
  listBpFromSnapshot,
  getStatsFromSnapshot,
  getTrendsFromSnapshot,
} from '../../src/lib/cache/snapshotReaders';
import type { BpListSnapshot, TrendsTopSnapshot } from '../../src/lib/cache/snapshotTypes';

let dir: string;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function bpRow(id: string, createdAt: string) {
  return {
    id,
    keyword: `keyword ${id}`,
    title: `Title ${id}`,
    status: 'completed',
    selectedOpportunity: 'opp',
    riskAdjustedAnnualized: '12%',
    riskAdjustedNum: 12,
    createdAt,
  };
}

async function seedBp(rows: ReturnType<typeof bpRow>[]) {
  await writeSnapshot<BpListSnapshot>(SNAPSHOT_KEYS.bpList, { reports: rows as any });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snapread-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('business plan recency window', () => {
  beforeEach(async () => {
    await seedBp([
      bpRow('fresh', daysAgo(2)),
      bpRow('recent', daysAgo(20)),
      bpRow('old', daysAgo(60)),
      bpRow('ancient', daysAgo(400)),
    ]);
  });

  it('returns everything when no window is given', async () => {
    const read = await listBpFromSnapshot(1, 20);
    expect(read.data.pagination.totalItems).toBe(4);
  });

  it('keeps only reports inside a 30-day window', async () => {
    const read = await listBpFromSnapshot(1, 20, 'createdAt', 'desc', undefined, 30);
    expect(read.data.reports.map((r) => r.id)).toEqual(['fresh', 'recent']);
  });

  it('narrows further for a 7-day window', async () => {
    const read = await listBpFromSnapshot(1, 20, 'createdAt', 'desc', undefined, 7);
    expect(read.data.reports.map((r) => r.id)).toEqual(['fresh']);
  });

  it('reports pagination totals for the window, not the archive', async () => {
    // Otherwise the pager would offer pages that render empty.
    const read = await listBpFromSnapshot(1, 1, 'createdAt', 'desc', undefined, 30);
    expect(read.data.pagination.totalItems).toBe(2);
    expect(read.data.pagination.totalPages).toBe(2);
  });

  it('combines the window with a status filter', async () => {
    await seedBp([
      bpRow('fresh', daysAgo(1)),
      { ...bpRow('freshFailed', daysAgo(1)), status: 'failed' },
    ]);
    const read = await listBpFromSnapshot(1, 20, 'createdAt', 'desc', 'completed', 30);
    expect(read.data.reports.map((r) => r.id)).toEqual(['fresh']);
  });

  it('returns an empty page rather than a miss when the window excludes everything', async () => {
    // `hit` stays true: the data is real and really empty, which the page must
    // distinguish from a snapshot that was never built.
    const read = await listBpFromSnapshot(1, 20, 'createdAt', 'desc', undefined, 1);
    expect(read.hit).toBe(true);
    expect(read.data.reports).toEqual([]);
  });
});

describe('trends collection window', () => {
  it('keeps only rows collected inside the requested window', async () => {
    const row = (id: string, hoursAgo: number) => ({
      id,
      keyword: `kw ${id}`,
      searchVolume: 1000,
      growthRate: 80,
      category: 'trending',
      timeRange: '4h',
      region: 'US',
      topicClass: 'general',
      timestamp: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    });
    await writeSnapshot<TrendsTopSnapshot>(SNAPSHOT_KEYS.trendsTop, {
      rows: [row('a', 2), row('b', 30), row('c', 100)] as any,
      totalRows: 3,
      truncated: false,
    });

    const day = await getTrendsFromSnapshot({ collectedWithin: '24h' });
    expect(day.data.trends.map((t) => t.id)).toEqual(['a']);

    const twoDays = await getTrendsFromSnapshot({ collectedWithin: '48h' });
    expect(twoDays.data.trends.map((t) => t.id).sort()).toEqual(['a', 'b']);

    const all = await getTrendsFromSnapshot({});
    expect(all.data.trends).toHaveLength(3);
  });
});

describe('stats snapshot', () => {
  it('reports a miss with a zeroed payload before the first build', async () => {
    const read = await getStatsFromSnapshot();
    expect(read.hit).toBe(false);
    expect(read.data.totals.bpTotal).toBe(0);
    expect(read.data.daily).toEqual([]);
  });

  it('returns the stored aggregates once built', async () => {
    await writeSnapshot(SNAPSHOT_KEYS.statsOverview, {
      totals: {
        trends: 120, keywords: 90, bpTotal: 10, bpCompleted: 8, bpFailed: 1,
        bpDuplicates: 1, users: 3, subscribers: 2, feedback: 1, monitoredSites: 1,
      },
      daily: [{ date: '2026-07-25', trendsCollected: 40, bpCreated: 5, bpCompleted: 5, bpFailed: 0, usersRegistered: 1 }],
      topicMix: { sports: 50, entertainment: 30, general: 40, unclassified: 0 },
      content: { bpInLast30Days: 10, topKeywords: [], topReports: [] },
      monitor: { sites: 1, up: 1, down: 0, avgSeoScore: 92 },
      freshness: { latestTrendAt: null, latestBpAt: null },
    });

    const read = await getStatsFromSnapshot();
    expect(read.hit).toBe(true);
    expect(read.data.totals.trends).toBe(120);
    expect(read.data.topicMix.sports).toBe(50);
    expect(read.generatedAt).toBeInstanceOf(Date);
  });
});
