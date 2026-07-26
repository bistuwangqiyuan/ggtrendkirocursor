/**
 * Snapshot builder: Postgres -> Netlify Blobs.
 *
 * Runs ONLY inside scheduled jobs (or the admin endpoint), which already pay for
 * a Neon wake window. Everything here is written with one goal: read the whole
 * world in as few round-trips as possible so the compute stays awake for
 * seconds, not minutes.
 *
 * Notable choices:
 * - Landing pages are built from three bulk queries for ALL keywords (a window
 *   function fetches each keyword's history in one pass), instead of the four
 *   per-keyword queries the request path used to run.
 * - Detail snapshots are written incrementally against a manifest, so a run
 *   rewrites only what actually changed.
 */
import { query, queryOne, getTrendsTableName, getTimestampColumnName } from '../db/client';
import { slugifyKeyword } from '../utils/slug';
import { bpService } from '../services/bp';
import { siteMonitorService } from '../services/siteMonitor';
import { trendsService } from '../services/trends';
import type { BpReport } from '../../types';
import {
  SNAPSHOT_KEYS,
  readSnapshot,
  writeSnapshot,
  listSnapshotKeys,
  deleteSnapshot,
} from './snapshot';
import {
  toIso,
  type BpListItemJson,
  type BpListSnapshot,
  type BpManifestSnapshot,
  type LandingDetailSnapshot,
  type LandingIndexSnapshot,
  type LandingKeywordJson,
  type LandingManifestSnapshot,
  type MonitorSnapshot,
  type TrendJson,
  type TrendsTopSnapshot,
} from './snapshotTypes';

const LANDING_MANIFEST_KEY = 'landing/manifest';
const BP_MANIFEST_KEY = 'bp/manifest';

/**
 * Row caps. The trends snapshot backs an "what's trending now" view, so capping
 * by recency is functionally equivalent while keeping the blob small enough to
 * parse per request.
 */
const TRENDS_SNAPSHOT_MAX = numberFromEnv('TRENDS_SNAPSHOT_MAX', 5000);
const LANDING_HISTORY_MAX = 30;
const BP_LIST_SNAPSHOT_MAX = numberFromEnv('BP_LIST_SNAPSHOT_MAX', 2000);
/** Per-run write caps so one build can't overrun the function's time budget. */
const LANDING_DETAIL_WRITES_PER_RUN = numberFromEnv('LANDING_DETAIL_WRITES_PER_RUN', 800);
const BP_DETAIL_WRITES_PER_RUN = numberFromEnv('BP_DETAIL_WRITES_PER_RUN', 40);

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface SnapshotBuildReport {
  ok: boolean;
  /** Section name -> number of snapshots written. */
  written: Record<string, number>;
  /** Section name -> error message, for sections that failed. */
  errors: Record<string, string>;
  /** Sections skipped because the time budget ran out. */
  skipped: string[];
  /**
   * Sections that started but stopped early at the deadline. Their remaining
   * items are picked up by the next run, since both detail loops are driven by a
   * manifest of what is already current.
   */
  truncated: string[];
  durationMs: number;
}

export interface BuildOptions {
  /**
   * Wall-clock budget. Sections not yet started are skipped once it is spent,
   * and the per-item detail loops stop at the same deadline — without that, a
   * first build over thousands of keywords outlives any function timeout.
   */
  budgetMs?: number;
  /** Restrict the build to these sections. */
  only?: SnapshotSection[];
}

export type SnapshotSection = 'trends' | 'landing' | 'bp' | 'monitor';

/** What one section managed to do before its deadline. */
interface SectionResult {
  written: number;
  /** True when items were left for the next run. */
  truncated?: boolean;
}

const ALL_SECTIONS: SnapshotSection[] = ['trends', 'landing', 'bp', 'monitor'];

/**
 * Rebuild every snapshot the read path depends on. Never throws: a failing
 * section is recorded and the rest still run, because a partial refresh is
 * strictly better than none.
 */
export async function rebuildAllSnapshots(options: BuildOptions = {}): Promise<SnapshotBuildReport> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 10 * 60 * 1000;
  const deadline = startedAt + budgetMs;
  const sections = options.only ?? ALL_SECTIONS;
  const report: SnapshotBuildReport = {
    ok: true, written: {}, errors: {}, skipped: [], truncated: [], durationMs: 0,
  };

  const builders: Record<SnapshotSection, (deadline: number) => Promise<SectionResult>> = {
    trends: buildTrendsSnapshots,
    landing: buildLandingSnapshots,
    bp: buildBpSnapshots,
    monitor: buildMonitorSnapshot,
  };

  for (const section of sections) {
    if (Date.now() > deadline) {
      report.skipped.push(section);
      continue;
    }
    try {
      const result = await builders[section](deadline);
      report.written[section] = result.written;
      if (result.truncated) report.truncated.push(section);
    } catch (error) {
      report.ok = false;
      report.errors[section] = (error as Error).message;
      console.error(`[snapshot-builder] ${section} failed:`, (error as Error).message);
    }
  }

  report.durationMs = Date.now() - startedAt;
  console.log('[snapshot-builder] done', JSON.stringify(report));
  return report;
}

// ---------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------

async function buildTrendsSnapshots(): Promise<SectionResult> {
  const tableName = await getTrendsTableName();
  const timestampCol = await getTimestampColumnName(tableName);
  const tsRef = timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';

  const countRow = await queryOne<{ total: string }>(`SELECT COUNT(*) AS total FROM "${tableName}"`);
  const totalRows = parseInt(countRow?.total || '0', 10);

  const rows = await query<any>(
    `SELECT id, keyword, search_volume, growth_rate, category, time_range, region,
            ${tsRef} AS ts, created_at
     FROM "${tableName}"
     ORDER BY ${tsRef} DESC
     LIMIT $1`,
    [TRENDS_SNAPSHOT_MAX]
  );

  const trendRows: TrendJson[] = rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    searchVolume: Number(r.search_volume) || 0,
    growthRate: Number(r.growth_rate) || 0,
    category: r.category ?? '',
    timeRange: (r.time_range ?? '') as TrendJson['timeRange'],
    region: r.region ?? '',
    timestamp: toIso(r.ts),
    createdAt: toIso(r.created_at),
  }));

  const payload: TrendsTopSnapshot = {
    rows: trendRows,
    totalRows,
    truncated: totalRows > trendRows.length,
  };

  let written = 0;
  if (await writeSnapshot<TrendsTopSnapshot>(SNAPSHOT_KEYS.trendsTop, payload)) written++;

  const categories = await trendsService.getCategories();
  const categoryList = categories.success ? categories.data.filter(Boolean) : [];
  if (await writeSnapshot<string[]>(SNAPSHOT_KEYS.trendsCategories, categoryList)) written++;

  return { written };
}

// ---------------------------------------------------------------------------
// landing (/t and /t/[slug])
// ---------------------------------------------------------------------------

async function buildLandingSnapshots(deadline: number): Promise<SectionResult> {
  const tableName = await getTrendsTableName();
  const timestampCol = await getTimestampColumnName(tableName);
  const tsRef = timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';

  // Query 1: one aggregate row per keyword.
  const aggRows = await query<any>(
    `SELECT keyword,
            MAX(search_volume) AS search_volume,
            MAX(growth_rate) AS growth_rate,
            MAX(region) AS region,
            MAX(${tsRef}) AS last_seen,
            COUNT(*) AS appearances
     FROM "${tableName}"
     GROUP BY keyword
     ORDER BY last_seen DESC, search_volume DESC`
  );

  const keywords: LandingKeywordJson[] = [];
  for (const r of aggRows) {
    const slug = slugifyKeyword(r.keyword ?? '');
    // A pure-punctuation keyword has no addressable URL.
    if (!slug) continue;
    keywords.push({
      keyword: r.keyword,
      slug,
      searchVolume: Number(r.search_volume) || 0,
      growthRate: Number(r.growth_rate) || 0,
      region: r.region ?? '',
      lastSeen: toIso(r.last_seen),
      appearances: Number(r.appearances) || 0,
    });
  }

  let written = 0;
  if (await writeSnapshot<LandingIndexSnapshot>(SNAPSHOT_KEYS.landingIndex, { keywords })) written++;

  // Decide which detail snapshots actually need rewriting.
  const manifest = (await readSnapshot<LandingManifestSnapshot>(LANDING_MANIFEST_KEY))?.data.slugs ?? {};
  const stale = keywords.filter((k) => manifest[k.slug] !== k.lastSeen);
  const batch = stale.slice(0, LANDING_DETAIL_WRITES_PER_RUN);
  if (batch.length === 0) {
    await pruneLandingDetails(keywords);
    return { written };
  }

  const batchKeywords = batch.map((k) => k.keyword);

  // Query 2: the most recent N history rows for every keyword in the batch,
  // in a single pass (ROW_NUMBER beats N separate LIMIT queries).
  const historyRows = await query<any>(
    `SELECT keyword, search_volume, growth_rate, region, ts AS collected_at
     FROM (
       SELECT keyword, search_volume, growth_rate, region, ${tsRef} AS ts,
              ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY ${tsRef} DESC) AS rn
       FROM "${tableName}"
       WHERE keyword = ANY($1)
     ) ranked
     WHERE rn <= $2`,
    [batchKeywords, LANDING_HISTORY_MAX]
  );

  const historyByKeyword = new Map<string, LandingDetailSnapshot['history']>();
  for (const r of historyRows) {
    const list = historyByKeyword.get(r.keyword) ?? [];
    list.push({
      searchVolume: Number(r.search_volume) || 0,
      growthRate: Number(r.growth_rate) || 0,
      region: r.region ?? '',
      collectedAt: toIso(r.collected_at),
    });
    historyByKeyword.set(r.keyword, list);
  }
  for (const list of historyByKeyword.values()) {
    list.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }

  // Query 3: the best completed BP per normalized keyword, for all keywords at
  // once. DISTINCT ON mirrors the per-slug ordering the request path used:
  // canonical report first, then newest.
  const bpRows = await query<any>(
    `SELECT DISTINCT ON (keyword_norm) keyword_norm, id, title, summary, selected_opportunity
     FROM bp_reports
     WHERE status = 'completed'
     ORDER BY keyword_norm, (canonical_report_id IS NULL) DESC, created_at DESC`
  );
  const bpByNorm = new Map<string, LandingDetailSnapshot['bp']>();
  for (const r of bpRows) {
    bpByNorm.set(r.keyword_norm, {
      id: r.id,
      title: r.title ?? null,
      summary: r.summary ?? null,
      selectedOpportunity: r.selected_opportunity ?? null,
    });
  }

  let truncated = false;
  for (const kw of batch) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const detail: LandingDetailSnapshot = {
      keyword: kw,
      history: historyByKeyword.get(kw.keyword) ?? [],
      bp: bpByNorm.get(normalizeKeyword(kw.keyword)) ?? null,
    };
    if (await writeSnapshot<LandingDetailSnapshot>(SNAPSHOT_KEYS.landingDetail(kw.slug), detail)) {
      written++;
      manifest[kw.slug] = kw.lastSeen;
    }
  }

  // The manifest records exactly what got written, so an interrupted run resumes
  // where it stopped instead of redoing the whole batch.
  await writeSnapshot<LandingManifestSnapshot>(LANDING_MANIFEST_KEY, { slugs: manifest });
  if (!truncated) await pruneLandingDetails(keywords);
  return { written, truncated: truncated || stale.length > batch.length };
}

/** Matches bp.ts / landing.ts normalizeKeyword so BP lookup keys line up. */
function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Drop detail snapshots for keywords that no longer exist (e.g. pruned by the
 * retention job), so /t/[slug] 404s instead of serving a page the sitemap and
 * index no longer link to.
 */
async function pruneLandingDetails(keywords: LandingKeywordJson[]): Promise<void> {
  const live = new Set(keywords.map((k) => k.slug));
  const existing = await listSnapshotKeys('landing/detail/');
  const manifest = (await readSnapshot<LandingManifestSnapshot>(LANDING_MANIFEST_KEY))?.data.slugs ?? {};
  let changed = false;
  for (const key of existing) {
    const slug = key.slice('landing/detail/'.length);
    if (!slug || live.has(slug)) continue;
    await deleteSnapshot(key);
    delete manifest[slug];
    changed = true;
  }
  if (changed) await writeSnapshot<LandingManifestSnapshot>(LANDING_MANIFEST_KEY, { slugs: manifest });
}

// ---------------------------------------------------------------------------
// bp (/bp and /bp/[id])
// ---------------------------------------------------------------------------

/**
 * Rebuild the list snapshot and return the raw rows, so the caller can reconcile
 * detail snapshots without querying again.
 */
async function refreshBpListSnapshot(): Promise<{ rows: any[]; written: number }> {
  // One query for the whole list, mirroring bpService.list()'s projection
  // (including the numeric extraction used for risk-adjusted sorting).
  const rows = await query<any>(
    `SELECT r.id, r.keyword, r.title, r.status, r.selected_opportunity, r.created_at, r.updated_at,
            COALESCE(r.content_json, c.content_json)->'seedReturn'->>'riskAdjustedAnnualized' AS risk_adjusted,
            NULLIF(substring(
              COALESCE(r.content_json, c.content_json)->'seedReturn'->>'riskAdjustedAnnualized'
              from '-?[0-9]+\\.?[0-9]*'
            ), '')::numeric AS risk_adjusted_num
     FROM bp_reports r
     LEFT JOIN bp_reports c ON r.canonical_report_id = c.id
     ORDER BY r.created_at DESC
     LIMIT $1`,
    [BP_LIST_SNAPSHOT_MAX]
  );

  const reports: BpListItemJson[] = rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    title: r.title ?? undefined,
    status: r.status,
    selectedOpportunity: r.selected_opportunity ?? undefined,
    riskAdjustedAnnualized: r.risk_adjusted ?? undefined,
    riskAdjustedNum: r.risk_adjusted_num === null || r.risk_adjusted_num === undefined
      ? null
      : Number(r.risk_adjusted_num),
    createdAt: toIso(r.created_at),
  }));

  const written = (await writeSnapshot<BpListSnapshot>(SNAPSHOT_KEYS.bpList, { reports })) ? 1 : 0;
  return { rows, written };
}

async function buildBpSnapshots(deadline: number): Promise<SectionResult> {
  const { rows, written: listWritten } = await refreshBpListSnapshot();
  let written = listWritten;

  // Detail snapshots: only for reports whose updated_at moved (or that are new).
  const manifest = (await readSnapshot<BpManifestSnapshot>(BP_MANIFEST_KEY))?.data.reports ?? {};
  const stale = rows.filter((r) => manifest[r.id] !== toIso(r.updated_at));
  const batch = stale.slice(0, BP_DETAIL_WRITES_PER_RUN);
  let truncated = stale.length > batch.length;
  for (const row of batch) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const result = await bpService.getById(row.id);
    if (!result.success) continue;
    if (await writeBpDetail(result.data)) {
      written++;
      manifest[row.id] = toIso(row.updated_at);
    }
  }

  // Forget manifest entries for reports that no longer exist.
  const liveIds = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(manifest)) {
    if (!liveIds.has(id)) {
      await deleteSnapshot(SNAPSHOT_KEYS.bpDetail(id));
      delete manifest[id];
    }
  }

  await writeSnapshot<BpManifestSnapshot>(BP_MANIFEST_KEY, { reports: manifest });
  return { written, truncated };
}

async function writeBpDetail(report: BpReport): Promise<boolean> {
  return writeSnapshot(SNAPSHOT_KEYS.bpDetail(report.id), {
    report: {
      ...report,
      createdAt: toIso(report.createdAt),
      updatedAt: toIso(report.updatedAt),
    },
  });
}

/**
 * Snapshot a report straight from the object the generator already holds, so an
 * interactive generation costs zero extra queries yet /bp/[id] serves the report
 * the moment the user is redirected to it. The list snapshot is refreshed too
 * (one query) so /bp shows the new row immediately.
 */
export async function captureGeneratedBpReport(report: BpReport): Promise<void> {
  try {
    if (!(await writeBpDetail(report))) return;
    const manifest = (await readSnapshot<BpManifestSnapshot>(BP_MANIFEST_KEY))?.data.reports ?? {};
    manifest[report.id] = toIso(report.updatedAt);
    await writeSnapshot<BpManifestSnapshot>(BP_MANIFEST_KEY, { reports: manifest });
    await refreshBpListSnapshot();
  } catch (error) {
    // A snapshot miss degrades a page; it must never fail the generation that
    // already succeeded and was persisted.
    console.error('[snapshot-builder] captureGeneratedBpReport failed:', (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// monitor (/monitor)
// ---------------------------------------------------------------------------

async function buildMonitorSnapshot(): Promise<SectionResult> {
  const sites = await siteMonitorService.listSitesWithLatestCheck();
  const payload: MonitorSnapshot = {
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      createdAt: toIso(s.createdAt),
      lastCheck: s.lastCheck
        ? { ...s.lastCheck, checkedAt: toIso(s.lastCheck.checkedAt) }
        : null,
    })),
  };
  return { written: (await writeSnapshot<MonitorSnapshot>(SNAPSHOT_KEYS.monitorLatest, payload)) ? 1 : 0 };
}
