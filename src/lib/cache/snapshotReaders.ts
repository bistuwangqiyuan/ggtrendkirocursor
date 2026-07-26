/**
 * Snapshot readers: the read path's only data source.
 *
 * Each function reproduces in memory what the corresponding service used to do
 * in SQL (filter, sort, paginate), so pages keep their existing shapes while no
 * longer waking the Neon compute.
 *
 * Every reader returns a `hit` flag. A page must be able to tell "the snapshot
 * has not been built yet" (show a build-pending state) from "the data really is
 * empty" (show an empty state) — conflating them would hide a broken pipeline.
 */
import type { PaginatedBpReports, PaginatedTrends, BpReport, BpReportListItem, Trend } from '../../types';
import type { LandingKeyword, LandingPageData } from '../services/landing';
import type { SiteWithLatestCheck } from '../services/siteMonitor';
import { collectedWithinHours, timeRangeVariants } from '../services/trends';
import { SNAPSHOT_KEYS, readSnapshot } from './snapshot';
import {
  reviveBpListItem,
  reviveBpReport,
  reviveLandingDetail,
  reviveLandingKeyword,
  reviveMonitorSite,
  reviveTrend,
  type BpDetailSnapshot,
  type BpListSnapshot,
  type LandingDetailSnapshot,
  type LandingIndexSnapshot,
  type MonitorSnapshot,
  type StatsSnapshot,
  type TrendsTopSnapshot,
} from './snapshotTypes';

export interface SnapshotRead<T> {
  /** False when the snapshot is missing — the caller should show a pending state. */
  hit: boolean;
  data: T;
  /** When the snapshot was produced, for "data as of" labels. */
  generatedAt: Date | null;
}

function miss<T>(data: T): SnapshotRead<T> {
  return { hit: false, data, generatedAt: null };
}

function paginate<T>(items: T[], page: number, pageSize: number) {
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * safeSize;
  return {
    slice: items.slice(start, start + safeSize),
    pagination: { currentPage: safePage, totalPages, totalItems, pageSize: safeSize },
  };
}

// ---------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------

export interface TrendsSnapshotQuery {
  timeRange?: string;
  collectedWithin?: string;
  keyword?: string;
  category?: string;
  excludeCategories?: string[];
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export async function getTrendsFromSnapshot(
  params: TrendsSnapshotQuery
): Promise<SnapshotRead<PaginatedTrends>> {
  const snap = await readSnapshot<TrendsTopSnapshot>(SNAPSHOT_KEYS.trendsTop);
  const emptyPage: PaginatedTrends = {
    trends: [],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 0, pageSize: params.pageSize ?? 20 },
  };
  if (!snap) return miss(emptyPage);

  const {
    timeRange, collectedWithin, keyword, category, excludeCategories,
    sortBy = 'search_volume', sortOrder = 'desc', page = 1, pageSize = 20,
  } = params;

  let rows: Trend[] = snap.data.rows.map(reviveTrend);

  if (timeRange) {
    const variants = new Set(timeRangeVariants(timeRange));
    rows = rows.filter((r) => variants.has(r.timeRange));
  }
  const hours = collectedWithin ? collectedWithinHours(collectedWithin) : undefined;
  if (hours) {
    const cutoff = Date.now() - hours * 3600_000;
    rows = rows.filter((r) => r.timestamp.getTime() >= cutoff);
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    rows = rows.filter((r) => r.keyword.toLowerCase().includes(needle));
  }
  if (category) {
    rows = rows.filter((r) => r.category === category);
  } else if (excludeCategories && excludeCategories.length > 0) {
    const excluded = new Set(excludeCategories);
    rows = rows.filter((r) => !excluded.has(r.category));
  }

  const dir = sortOrder === 'asc' ? 1 : -1;
  const keyOf = (t: Trend): number =>
    sortBy === 'growth_rate' ? t.growthRate
      : sortBy === 'timestamp' ? t.timestamp.getTime()
        : t.searchVolume;
  rows.sort((a, b) => (keyOf(a) - keyOf(b)) * dir);

  const { slice, pagination } = paginate(rows, page, pageSize);
  return {
    hit: true,
    data: { trends: slice, pagination },
    generatedAt: new Date(snap.generatedAt),
  };
}

export async function getCategoriesFromSnapshot(): Promise<SnapshotRead<string[]>> {
  const snap = await readSnapshot<string[]>(SNAPSHOT_KEYS.trendsCategories);
  if (!snap) return miss<string[]>([]);
  return { hit: true, data: snap.data, generatedAt: new Date(snap.generatedAt) };
}

// ---------------------------------------------------------------------------
// landing
// ---------------------------------------------------------------------------

export interface LandingKeywordPage {
  keywords: LandingKeyword[];
  pagination: { currentPage: number; totalPages: number; totalItems: number; pageSize: number };
}

export async function listKeywordsFromSnapshot(
  page = 1,
  pageSize = 50
): Promise<SnapshotRead<LandingKeywordPage>> {
  const snap = await readSnapshot<LandingIndexSnapshot>(SNAPSHOT_KEYS.landingIndex);
  const empty: LandingKeywordPage = {
    keywords: [],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 0, pageSize },
  };
  if (!snap) return miss(empty);

  const { slice, pagination } = paginate(snap.data.keywords, page, pageSize);
  return {
    hit: true,
    data: { keywords: slice.map(reviveLandingKeyword), pagination },
    generatedAt: new Date(snap.generatedAt),
  };
}

export async function listKeywordsForSitemapFromSnapshot(
  limit = 300
): Promise<SnapshotRead<{ slug: string; lastSeen: Date }[]>> {
  const snap = await readSnapshot<LandingIndexSnapshot>(SNAPSHOT_KEYS.landingIndex);
  if (!snap) return miss<{ slug: string; lastSeen: Date }[]>([]);
  const entries = snap.data.keywords
    .slice(0, Math.max(0, limit))
    .map((k) => ({ slug: k.slug, lastSeen: new Date(k.lastSeen) }));
  return { hit: true, data: entries, generatedAt: new Date(snap.generatedAt) };
}

export async function getLandingDataFromSnapshot(
  slug: string
): Promise<SnapshotRead<LandingPageData | null>> {
  const clean = slug.trim().toLowerCase();
  if (!clean || clean.length > 200) return { hit: true, data: null, generatedAt: null };
  const snap = await readSnapshot<LandingDetailSnapshot>(SNAPSHOT_KEYS.landingDetail(clean));
  if (!snap) return miss<LandingPageData | null>(null);
  return { hit: true, data: reviveLandingDetail(snap.data), generatedAt: new Date(snap.generatedAt) };
}

/**
 * Whether a slug appears in the keyword index at all. Distinguishes "this
 * keyword exists but its detail snapshot hasn't been built yet" from "no such
 * keyword", so a crawler following a dead URL doesn't log an error. Returns null
 * when the index snapshot itself is missing.
 */
export async function landingSlugExistsInSnapshot(slug: string): Promise<boolean | null> {
  const snap = await readSnapshot<LandingIndexSnapshot>(SNAPSHOT_KEYS.landingIndex);
  if (!snap) return null;
  const clean = slug.trim().toLowerCase();
  return snap.data.keywords.some((k) => k.slug === clean);
}

// ---------------------------------------------------------------------------
// bp
// ---------------------------------------------------------------------------

export async function listBpFromSnapshot(
  page = 1,
  pageSize = 20,
  sortBy: 'createdAt' | 'riskAdjusted' = 'createdAt',
  sortOrder: 'asc' | 'desc' = 'desc',
  status?: string,
  /** Keep only reports created this many days ago or less. Omit for all history. */
  withinDays?: number
): Promise<SnapshotRead<PaginatedBpReports>> {
  const snap = await readSnapshot<BpListSnapshot>(SNAPSHOT_KEYS.bpList);
  const empty: PaginatedBpReports = {
    reports: [],
    pagination: { currentPage: 1, totalPages: 1, totalItems: 0, pageSize },
  };
  if (!snap) return miss(empty);

  let rows = snap.data.reports;
  if (status) rows = rows.filter((r) => r.status === status);
  if (withinDays && withinDays > 0) {
    const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString();
    // createdAt is a stored ISO string, so a lexicographic compare is both
    // correct and cheaper than parsing every row into a Date.
    rows = rows.filter((r) => r.createdAt >= cutoff);
  }

  // Mirror the SQL ordering: failed placeholders last, then the chosen key,
  // with missing risk-adjusted values sorted last regardless of direction.
  const dir = sortOrder === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const failedA = a.status === 'failed' ? 1 : 0;
    const failedB = b.status === 'failed' ? 1 : 0;
    if (failedA !== failedB) return failedA - failedB;
    if (sortBy === 'riskAdjusted') {
      const aNull = a.riskAdjustedNum === null;
      const bNull = b.riskAdjustedNum === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      if (!aNull && !bNull && a.riskAdjustedNum !== b.riskAdjustedNum) {
        return (a.riskAdjustedNum! - b.riskAdjustedNum!) * dir;
      }
      return b.createdAt.localeCompare(a.createdAt);
    }
    return a.createdAt.localeCompare(b.createdAt) * dir;
  });

  const { slice, pagination } = paginate(rows, page, pageSize);
  const reports: BpReportListItem[] = slice.map(reviveBpListItem);
  return { hit: true, data: { reports, pagination }, generatedAt: new Date(snap.generatedAt) };
}

export async function getBpByIdFromSnapshot(id: string): Promise<SnapshotRead<BpReport | null>> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { hit: true, data: null, generatedAt: null };
  const snap = await readSnapshot<BpDetailSnapshot>(SNAPSHOT_KEYS.bpDetail(id));
  if (!snap) return miss<BpReport | null>(null);
  return { hit: true, data: reviveBpReport(snap.data.report), generatedAt: new Date(snap.generatedAt) };
}

/**
 * Whether a report id exists at all, according to the list snapshot. Lets
 * /bp/[id] tell "this report exists but its detail snapshot hasn't been built
 * yet" (show a pending state) from "no such report" (404), without a DB query.
 * Returns null when the list snapshot itself is missing.
 */
export async function bpIdExistsInSnapshot(id: string): Promise<boolean | null> {
  const snap = await readSnapshot<BpListSnapshot>(SNAPSHOT_KEYS.bpList);
  if (!snap) return null;
  return snap.data.reports.some((r) => r.id === id);
}

/**
 * A report is "in flight" while it is being generated. Callers may refresh those
 * from Postgres because a user is actively watching the page — but only within a
 * short window, so a permanently stuck row can't be polled into steady DB load.
 */
const IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000;

export function isBpInFlight(report: BpReport | null): boolean {
  if (!report) return false;
  if (report.status !== 'generating' && report.status !== 'pending') return false;
  const updated = report.updatedAt instanceof Date ? report.updatedAt.getTime() : 0;
  return Date.now() - updated < IN_FLIGHT_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// monitor
// ---------------------------------------------------------------------------

export async function listMonitorSitesFromSnapshot(): Promise<SnapshotRead<SiteWithLatestCheck[]>> {
  const snap = await readSnapshot<MonitorSnapshot>(SNAPSHOT_KEYS.monitorLatest);
  if (!snap) return miss<SiteWithLatestCheck[]>([]);
  return {
    hit: true,
    data: snap.data.sites.map(reviveMonitorSite),
    generatedAt: new Date(snap.generatedAt),
  };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/** Shown when the snapshot has not been built yet, so the page still renders. */
export const EMPTY_STATS: StatsSnapshot = {
  totals: {
    trends: 0, keywords: 0, bpTotal: 0, bpCompleted: 0, bpFailed: 0, bpDuplicates: 0,
    users: 0, subscribers: 0, feedback: 0, monitoredSites: 0,
  },
  daily: [],
  topicMix: { sports: 0, entertainment: 0, general: 0, unclassified: 0 },
  content: { bpInLast30Days: 0, topKeywords: [], topReports: [] },
  monitor: { sites: 0, up: 0, down: 0, avgSeoScore: null },
  freshness: { latestTrendAt: null, latestBpAt: null },
};

export async function getStatsFromSnapshot(): Promise<SnapshotRead<StatsSnapshot>> {
  const snap = await readSnapshot<StatsSnapshot>(SNAPSHOT_KEYS.statsOverview);
  if (!snap) return miss(EMPTY_STATS);
  return { hit: true, data: snap.data, generatedAt: new Date(snap.generatedAt) };
}
