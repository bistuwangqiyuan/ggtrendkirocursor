import { query, getClient, getTrendsTableName, getTimestampColumnName } from '../db/client';

/**
 * Google Trends "Daily Trending Searches" RSS collector.
 *
 * Provides a free, zero-LLM-token supply of REAL hotwords so the BP generator
 * never starves (the 7-day dedup window would otherwise exhaust a static pool
 * in 1-2 days at 5-10x volume). Rows are written into the active trends table
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
}

export interface CollectedTrendRow {
  keyword: string;
  searchVolume: number;
  growthRate: number;
  category: string;
  timeRange: string;
  region: string;
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

/**
 * Extract trend items from a Google Trends daily RSS document.
 * Pure (no I/O) so it is unit-testable from a fixture string.
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
    items.push({ keyword, approxTraffic: parseApproxTraffic(rawTraffic) });
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

    const summary: CollectSummary = {
      inserted: 0,
      skipped: 0,
      table,
      timestampColumn: tsCol,
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

      // Parameterized multi-row insert. id is generated in-app because the
      // google_trends table has no UUID default (trends_trending_now ignores
      // the explicit id). Each tuple ends with NOW(),NOW() for the collection
      // timestamp column and created_at, so only 7 columns are parameterized.
      const cols = 7;
      const valuesSql: string[] = [];
      const params: any[] = [];
      fresh.forEach((row, i) => {
        const b = i * cols;
        valuesSql.push(
          `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},NOW(),NOW())`
        );
        params.push(
          crypto.randomUUID(),
          row.keyword,
          row.searchVolume,
          row.growthRate,
          row.category,
          row.timeRange,
          row.region
        );
      });

      const insertSql = `INSERT INTO "${table}"
        (id, keyword, search_volume, growth_rate, category, time_range, region, ${tsRef}, created_at)
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
