/**
 * JSON-safe snapshot payload shapes.
 *
 * Snapshots go through JSON, so every Date becomes an ISO string on the way in
 * and must be revived on the way out. Keeping the wire shapes in their own
 * module lets the builder (DB -> snapshot) and the readers (snapshot -> page
 * data) share one definition, so a shape change can't drift between them.
 */
import type { BpReport, BpReportListItem, Trend } from '../../types';
import type { SeoChecks, SiteWithLatestCheck } from '../services/siteMonitor';
import type { LandingKeyword, LandingPageData } from '../services/landing';

export type TrendJson = Omit<Trend, 'timestamp' | 'createdAt'> & {
  timestamp: string;
  createdAt: string;
};

export interface TrendsTopSnapshot {
  /** Most recent rows, newest first. Capped — see TRENDS_SNAPSHOT_MAX. */
  rows: TrendJson[];
  /** True row count in Postgres, so pagination totals stay honest. */
  totalRows: number;
  /** Whether `rows` was truncated relative to totalRows. */
  truncated: boolean;
}

export type LandingKeywordJson = Omit<LandingKeyword, 'lastSeen'> & { lastSeen: string };

export interface LandingIndexSnapshot {
  keywords: LandingKeywordJson[];
}

export interface LandingDetailSnapshot {
  keyword: LandingKeywordJson;
  history: { searchVolume: number; growthRate: number; region: string; collectedAt: string }[];
  bp: LandingPageData['bp'];
}

/** slug -> lastSeen ISO, so the builder can write only what changed. */
export interface LandingManifestSnapshot {
  slugs: Record<string, string>;
}

export type BpListItemJson = Omit<BpReportListItem, 'createdAt'> & {
  createdAt: string;
  /** Parsed risk-adjusted return for sorting (null when absent). */
  riskAdjustedNum: number | null;
};

export interface BpListSnapshot {
  reports: BpListItemJson[];
}

export type BpReportJson = Omit<BpReport, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export interface BpDetailSnapshot {
  report: BpReportJson;
}

/** report id -> updatedAt ISO, so the builder only re-writes changed reports. */
export interface BpManifestSnapshot {
  reports: Record<string, string>;
}

export interface MonitorSiteJson {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  lastCheck: {
    ok: boolean;
    httpStatus: number;
    responseMs: number;
    seoScore: number;
    seoChecks: SeoChecks;
    error: string | null;
    checkedAt: string;
  } | null;
}

export interface MonitorSnapshot {
  sites: MonitorSiteJson[];
}

// ---------------------------------------------------------------------------
// Revivers (snapshot -> runtime shape with real Dates)
// ---------------------------------------------------------------------------

export function reviveTrend(row: TrendJson): Trend {
  return {
    ...row,
    timestamp: new Date(row.timestamp),
    createdAt: new Date(row.createdAt),
  } as Trend;
}

export function reviveLandingKeyword(k: LandingKeywordJson): LandingKeyword {
  return { ...k, lastSeen: new Date(k.lastSeen) };
}

export function reviveLandingDetail(d: LandingDetailSnapshot): LandingPageData {
  return {
    keyword: reviveLandingKeyword(d.keyword),
    history: d.history.map((h) => ({ ...h, collectedAt: new Date(h.collectedAt) })),
    bp: d.bp,
  };
}

export function reviveBpListItem(r: BpListItemJson): BpReportListItem {
  const { riskAdjustedNum: _ignored, ...rest } = r;
  return { ...rest, createdAt: new Date(r.createdAt) } as BpReportListItem;
}

export function reviveBpReport(r: BpReportJson): BpReport {
  return {
    ...r,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  } as BpReport;
}

export function reviveMonitorSite(s: MonitorSiteJson): SiteWithLatestCheck {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    createdAt: new Date(s.createdAt),
    lastCheck: s.lastCheck
      ? { ...s.lastCheck, checkedAt: new Date(s.lastCheck.checkedAt) }
      : null,
  };
}

/** Serialize a Date-ish value to ISO, tolerating strings and nulls. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}
