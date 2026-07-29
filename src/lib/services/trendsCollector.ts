import {
  query,
  getClient,
  getTrendsTableName,
  getTimestampColumnName,
  trendsTableHasColumn,
  isDbDown,
} from '../db/client';
import { classifyTrendTopic, type TopicClass } from './trendTriage';
import {
  drainPendingTrends,
  enqueueTrendHarvest,
  type DrainSummary,
  type QueuedTrendRow,
} from './trendIntake';

/**
 * Google Trends "Daily Trending Searches" RSS collector.
 *
 * Provides a free, zero-LLM-token supply of REAL hotwords so the BP generator
 * never starves (all-history dedupe means each keyword is analyzed only once,
 * so a static pool would exhaust quickly). Rows are written into the active trends table
 * with a fresh collection timestamp so the dashboard's collectedWithin filter
 * and the BP picker both see fresh, eligible keywords.
 *
 * The RSS feed is public and unauthenticated:
 *   https://trends.google.com/trending/rss?geo=US
 *
 * HARVEST AND STORE ARE SEPARATE STEPS
 * `harvest()` talks only to Google; `persist()` talks only to Postgres. When the
 * database is unavailable the harvest is parked in the Blobs intake queue instead
 * of being discarded, because the RSS feed is a rolling window — a dropped
 * harvest is a permanently lost set of hotwords, not a delayed one. See
 * trendIntake.ts.
 */

/** Geographies to harvest (English-language markets keep keywords usable). */
export const DEFAULT_GEOS = ['US', 'GB', 'CA', 'AU', 'IN', 'SG'];

/** Collected rows are tagged with this category. */
export const COLLECTOR_CATEGORY = 'trending';

/**
 * time_range stored for freshly trending items. The live google_trends table
 * enforces a CHECK constraint allowing only the short forms ('4h'/'24h'/'48h');
 * '4h' also matches the BP picker's default scan window.
 */
export const COLLECTOR_TIME_RANGE = '4h';

/** Don't re-insert the same keyword+region collected within this many hours. */
export const COLLECTOR_DEDUPE_HOURS = 24;

const RSS_TIMEOUT_MS = 12_000;

export interface RssTrendItem {
  keyword: string;
  approxTraffic: number | null;
  /** Headlines of the stories driving the spike. Empty when the feed omits them. */
  newsTitles: string[];
  /** Publisher names and article URLs for those stories. */
  newsSources: string[];
}

export interface CollectedTrendRow {
  keyword: string;
  searchVolume: number;
  growthRate: number;
  category: string;
  timeRange: string;
  region: string;
  /** Sport / entertainment / general, decided from the keyword and its news. */
  topicClass: TopicClass;
}

/** Decode the handful of XML/HTML entities that show up in trend titles. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Parse an approximate-traffic string into a number of searches.
 * Handles "200,000+", "200K+", "1M+", "2.5M+", and bare numbers.
 * Returns null when no number is present.
 */
export function parseApproxTraffic(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/,/g, '').trim();
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*([KkMmBb])?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toUpperCase();
  const mult = unit === 'K' ? 1_000 : unit === 'M' ? 1_000_000 : unit === 'B' ? 1_000_000_000 : 1;
  return Math.round(n * mult);
}

/**
 * Estimate a defensible growth-rate signal for a freshly trending keyword.
 *
 * The daily-trending RSS feed contains genuine breakout searches but exposes no
 * growth figure, so we derive a conservative surge estimate from the traffic
 * tier. This is used only as an internal ranking/eligibility signal (it keeps
 * collected rows above MIN_TREND_SCORE in the BP picker); it is intentionally
 * understated relative to real "breakout" multiples to avoid optimism bias.
 * Output is bounded to 74-100 (%).
 */
export function estimateTrendGrowthRate(searchVolume: number): number {
  const sv = Math.max(1, searchVolume);
  const g = 74 + (Math.log10(sv) - 3) * 10;
  return Math.round(Math.min(100, Math.max(74, g)));
}

/** Collect every value of a repeating tag within one item block. */
function extractAll(chunk: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const value = decodeXmlEntities(m[1] ?? m[2] ?? '');
    if (value) out.push(value);
  }
  return out;
}

/**
 * Extract trend items from a Google Trends daily RSS document.
 * Pure (no I/O) so it is unit-testable from a fixture string.
 *
 * Each `<item>` also carries the news stories behind the spike. Those headlines
 * and publishers are what makes an opaque keyword like "brickyard 400"
 * classifiable, so they are parsed alongside the keyword itself.
 */
export function parseTrendsRss(xml: string): RssTrendItem[] {
  if (typeof xml !== 'string' || !xml) return [];
  const items: RssTrendItem[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const titleRe = /<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i;
  const trafficRe = /<ht:approx_traffic>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/ht:approx_traffic>/i;

  let block: RegExpExecArray | null;
  while ((block = itemRe.exec(xml)) !== null) {
    const chunk = block[0];
    const tm = titleRe.exec(chunk);
    const rawTitle = tm ? (tm[1] ?? tm[2] ?? '') : '';
    const keyword = decodeXmlEntities(rawTitle);
    if (!keyword) continue;
    const trm = trafficRe.exec(chunk);
    const rawTraffic = trm ? (trm[1] ?? trm[2] ?? '') : '';
    items.push({
      keyword,
      approxTraffic: parseApproxTraffic(rawTraffic),
      newsTitles: extractAll(chunk, 'ht:news_item_title'),
      // Publisher name and article URL both carry the beat, and the URL host is
      // the more reliable of the two ("Yahoo Sports" vs "sports.yahoo.com").
      newsSources: [
        ...extractAll(chunk, 'ht:news_item_source'),
        ...extractAll(chunk, 'ht:news_item_url'),
      ],
    });
  }
  return items;
}

/**
 * Map a parsed RSS item to a trend row. A missing/zero traffic value falls back
 * to a modest default so the keyword is still usable.
 */
export function mapRssItemToRow(item: RssTrendItem, geo: string): CollectedTrendRow {
  const searchVolume = item.approxTraffic && item.approxTraffic > 0 ? item.approxTraffic : 5_000;
  return {
    keyword: item.keyword,
    searchVolume,
    growthRate: estimateTrendGrowthRate(searchVolume),
    category: COLLECTOR_CATEGORY,
    timeRange: COLLECTOR_TIME_RANGE,
    region: geo,
    // Classified here because this is the only place the news context exists;
    // it is gone by the time the BP picker reads the row back.
    topicClass: classifyTrendTopic({
      keyword: item.keyword,
      newsTitles: item.newsTitles,
      newsSources: item.newsSources,
    }).topic,
  };
}

/**
 * De-duplicate parsed items within a single feed by normalized keyword,
 * keeping the highest traffic value seen.
 */
export function dedupeRssItems(items: RssTrendItem[]): RssTrendItem[] {
  const byKey = new Map<string, RssTrendItem>();
  for (const it of items) {
    const k = it.keyword.trim().toLowerCase();
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev || (it.approxTraffic ?? 0) > (prev.approxTraffic ?? 0)) {
      byKey.set(k, it);
    }
  }
  return [...byKey.values()];
}

async function fetchRss(geo: string): Promise<string | null> {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RSS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendNowBot/1.0)' },
    });
    if (!res.ok) {
      console.error(`[trends-collector] ${geo} RSS HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.error(`[trends-collector] ${geo} RSS fetch failed:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface HarvestSummary {
  rows: QueuedTrendRow[];
  /** How the harvested rows were classified. */
  topics: Record<TopicClass, number>;
  geos: Record<string, { fetched: number }>;
  errors: string[];
}

export interface PersistSummary {
  inserted: number;
  skipped: number;
  table: string;
  timestampColumn: string;
  /** False when the database predates the topic_class column. */
  topicClassStored: boolean;
}

export interface CollectSummary {
  inserted: number;
  skipped: number;
  /** Rows parked in the intake queue because the store was unavailable. */
  deferred: number;
  table: string;
  timestampColumn: string;
  /** False when the database predates the topic_class column. */
  topicClassStored: boolean;
  /** How the freshly harvested rows were classified. */
  topics: Record<TopicClass, number>;
  geos: Record<string, { fetched: number; inserted: number; skipped: number }>;
  errors: string[];
}

export class TrendsCollector {
  /**
   * Read every geo's feed and turn it into storable rows. Touches no database, so
   * it succeeds during an outage and its output can be queued.
   */
  async harvest(geos: string[] = DEFAULT_GEOS): Promise<HarvestSummary> {
    const summary: HarvestSummary = {
      rows: [],
      topics: { sports: 0, entertainment: 0, general: 0 },
      geos: {},
      errors: [],
    };

    for (const geo of geos) {
      summary.geos[geo] = { fetched: 0 };
      const xml = await fetchRss(geo);
      if (xml === null) {
        summary.errors.push(`${geo}: fetch failed`);
        continue;
      }
      const items = dedupeRssItems(parseTrendsRss(xml));
      summary.geos[geo].fetched = items.length;
      for (const item of items) {
        // id is assigned here, not at insert time, so a plan generated from this
        // row while the database is down can already reference it.
        const row: QueuedTrendRow = { id: crypto.randomUUID(), ...mapRssItemToRow(item, geo) };
        summary.topics[row.topicClass]++;
        summary.rows.push(row);
      }
    }
    return summary;
  }

  /**
   * Write harvested rows into the active trends table, skipping keywords already
   * stored for the same region inside the dedupe window.
   *
   * `collectedAt` is the time the feed was READ, which for a replayed batch is
   * hours before now. Storing the real observation time keeps /trends honest and
   * lets the row age out of the analysis window on schedule; `created_at` records
   * when it actually landed in Postgres.
   *
   * Throws when the database is unavailable, so callers can queue instead.
   */
  async persist(rows: QueuedTrendRow[], collectedAt: Date = new Date()): Promise<PersistSummary> {
    // Bail out before doing any of the schema probing. While the breaker is open
    // `query()` returns an empty result instead of throwing, which would silently
    // empty the dedupe set and let this insert duplicate every row it retries.
    if (isDbDown()) throw new Error('DB unavailable (circuit breaker open)');

    const table = await getTrendsTableName();
    const tsCol = await getTimestampColumnName(table);
    const tsRef = tsCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';
    const withTopicClass = await trendsTableHasColumn(table, 'topic_class');
    const result: PersistSummary = {
      inserted: 0,
      skipped: 0,
      table,
      timestampColumn: tsCol,
      topicClassStored: withTopicClass,
    };
    if (rows.length === 0) return result;

    // One dedupe query for every region in the batch, rather than one per geo:
    // same answer, fewer round trips inside the wake window.
    const regions = [...new Set(rows.map((r) => r.region))];
    const existingRows = await query<{ region: string; keyword: string }>(
      `SELECT DISTINCT region, keyword FROM "${table}"
       WHERE region = ANY($1::text[]) AND ${tsRef} >= NOW() - make_interval(hours => $2)`,
      [regions, COLLECTOR_DEDUPE_HOURS]
    );
    const seen = new Set(existingRows.map((r) => dedupeKey(r.region, r.keyword)));

    const fresh: QueuedTrendRow[] = [];
    for (const row of rows) {
      const key = dedupeKey(row.region, row.keyword);
      if (seen.has(key)) {
        result.skipped++;
        continue;
      }
      seen.add(key);
      fresh.push(row);
    }
    if (fresh.length === 0) return result;

    // Parameterized multi-row insert. id comes from the row because the
    // google_trends table has no UUID default (trends_trending_now ignores the
    // explicit id). topic_class is included only where it exists, so a database
    // that has not run the additive migration still collects.
    const cols = withTopicClass ? 9 : 8;
    const valuesSql: string[] = [];
    const params: any[] = [];
    fresh.forEach((row, i) => {
      const b = i * cols;
      const placeholders = Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(',');
      valuesSql.push(`(${placeholders},NOW())`);
      params.push(
        row.id,
        row.keyword,
        row.searchVolume,
        row.growthRate,
        row.category,
        row.timeRange,
        row.region
      );
      if (withTopicClass) params.push(row.topicClass);
      params.push(collectedAt);
    });

    const insertSql = `INSERT INTO "${table}"
      (id, keyword, search_volume, growth_rate, category, time_range, region,${withTopicClass ? ' topic_class,' : ''} ${tsRef}, created_at)
      VALUES ${valuesSql.join(',')}`;
    // Use a raw client so INSERT errors surface (the shared query() helper
    // swallows errors and returns [], which would mask a failed insert).
    const client = await getClient();
    try {
      const res = await client.query(insertSql, params);
      result.inserted = res.rowCount ?? fresh.length;
    } finally {
      client.release();
    }
    return result;
  }

  /**
   * Harvest, then store. A store failure parks the harvest in the intake queue
   * rather than losing it, and is reported as `deferred` instead of as a silent
   * zero-insert run.
   */
  async collect(geos: string[] = DEFAULT_GEOS): Promise<CollectSummary> {
    const harvestedAt = new Date();
    const harvest = await this.harvest(geos);

    const summary: CollectSummary = {
      inserted: 0,
      skipped: 0,
      deferred: 0,
      table: '',
      timestampColumn: '',
      topicClassStored: false,
      topics: harvest.topics,
      geos: {},
      errors: [...harvest.errors],
    };
    for (const [geo, stat] of Object.entries(harvest.geos)) {
      summary.geos[geo] = { fetched: stat.fetched, inserted: 0, skipped: 0 };
    }
    if (harvest.rows.length === 0) return summary;

    try {
      const persisted = await this.persist(harvest.rows, harvestedAt);
      summary.inserted = persisted.inserted;
      summary.skipped = persisted.skipped;
      summary.table = persisted.table;
      summary.timestampColumn = persisted.timestampColumn;
      summary.topicClassStored = persisted.topicClassStored;
    } catch (error) {
      const queued = await enqueueTrendHarvest(harvest.rows, harvestedAt);
      summary.deferred = queued ? harvest.rows.length : 0;
      summary.errors.push(
        queued
          ? `store unavailable, queued ${harvest.rows.length} row(s): ${(error as Error).message}`
          : `store unavailable and queue write failed: ${(error as Error).message}`
      );
    }
    return summary;
  }

  /**
   * Replay queued harvests into Postgres. Called at the start of the write window
   * and by the recovery job, so hotwords gathered during an outage land as soon as
   * the database is reachable again.
   */
  async drainPending(now: Date = new Date()): Promise<DrainSummary> {
    return drainPendingTrends((rows, harvestedAt) => this.persist(rows, harvestedAt), now);
  }
}

/** Region-scoped dedupe identity. Dedupe is per region, so US and GB may both hold a keyword. */
function dedupeKey(region: string, keyword: string): string {
  return `${region}\u0000${keyword.trim().toLowerCase()}`;
}

export const trendsCollector = new TrendsCollector();
