import {
  query,
  getClient,
  getTrendsTableName,
  getTimestampColumnName,
  trendsTableHasColumn,
} from '../db/client';
import { classifyTrendTopic, type TopicClass } from './trendTriage';

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

export interface CollectSummary {
  inserted: number;
  skipped: number;
  table: string;
  timestampColumn: string;
  /** False when the database predates the topic_class column. */
  topicClassStored: boolean;
  /** How the freshly inserted rows were classified. */
  topics: Record<TopicClass, number>;
  geos: Record<string, { fetched: number; inserted: number; skipped: number }>;
  errors: string[];
}

export class TrendsCollector {
  /**
   * Harvest trending keywords across geos and persist fresh rows into the active
   * trends table. Per-region 24h dedupe avoids piling duplicates each run.
   */
  async collect(geos: string[] = DEFAULT_GEOS): Promise<CollectSummary> {
    const table = await getTrendsTableName();
    const tsCol = await getTimestampColumnName(table);
    const tsRef = tsCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';
    const withTopicClass = await trendsTableHasColumn(table, 'topic_class');

    const summary: CollectSummary = {
      inserted: 0,
      skipped: 0,
      table,
      timestampColumn: tsCol,
      topicClassStored: withTopicClass,
      topics: { sports: 0, entertainment: 0, general: 0 },
      geos: {},
      errors: [],
    };

    for (const geo of geos) {
      const geoStat = { fetched: 0, inserted: 0, skipped: 0 };
      summary.geos[geo] = geoStat;

      const xml = await fetchRss(geo);
      if (xml === null) {
        summary.errors.push(`${geo}: fetch failed`);
        continue;
      }

      const items = dedupeRssItems(parseTrendsRss(xml));
      geoStat.fetched = items.length;
      if (items.length === 0) continue;

      // Existing keywords for this region collected within the dedupe window.
      const existingRows = await query<{ keyword: string }>(
        `SELECT DISTINCT keyword FROM "${table}"
         WHERE region = $1 AND ${tsRef} >= NOW() - make_interval(hours => $2)`,
        [geo, COLLECTOR_DEDUPE_HOURS]
      );
      const existing = new Set(existingRows.map((r) => r.keyword.trim().toLowerCase()));

      const fresh = items
        .map((it) => mapRssItemToRow(it, geo))
        .filter((row) => {
          if (existing.has(row.keyword.trim().toLowerCase())) {
            geoStat.skipped++;
            return false;
          }
          return true;
        });

      if (fresh.length === 0) continue;
      for (const row of fresh) summary.topics[row.topicClass]++;

      // Parameterized multi-row insert. id is generated in-app because the
      // google_trends table has no UUID default (trends_trending_now ignores
      // the explicit id). Each tuple ends with NOW(),NOW() for the collection
      // timestamp column and created_at, so the remaining columns are the only
      // parameterized ones. topic_class is included only where it exists, so a
      // database that has not run the additive migration still collects.
      const cols = withTopicClass ? 8 : 7;
      const valuesSql: string[] = [];
      const params: any[] = [];
      fresh.forEach((row, i) => {
        const b = i * cols;
        const placeholders = Array.from({ length: cols }, (_, j) => `$${b + j + 1}`).join(',');
        valuesSql.push(`(${placeholders},NOW(),NOW())`);
        params.push(
          crypto.randomUUID(),
          row.keyword,
          row.searchVolume,
          row.growthRate,
          row.category,
          row.timeRange,
          row.region
        );
        if (withTopicClass) params.push(row.topicClass);
      });

      const insertSql = `INSERT INTO "${table}"
        (id, keyword, search_volume, growth_rate, category, time_range, region,${withTopicClass ? ' topic_class,' : ''} ${tsRef}, created_at)
        VALUES ${valuesSql.join(',')}`;
      // Use a raw client so INSERT errors surface (the shared query() helper
      // swallows errors and returns [], which would mask a failed insert).
      const client = await getClient();
      try {
        const res = await client.query(insertSql, params);
        const n = res.rowCount ?? fresh.length;
        geoStat.inserted = n;
        summary.inserted += n;
      } catch (err) {
        summary.errors.push(`${geo}: insert failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
      summary.skipped += geoStat.skipped;
    }

    return summary;
  }
}

export const trendsCollector = new TrendsCollector();
