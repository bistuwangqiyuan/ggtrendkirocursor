import { query, queryOne, getTrendsTableName, getTimestampColumnName } from '../db/client';
import { slugifyKeyword, slugToLikePattern } from '../utils/slug';

/**
 * Hotword landing pages (/t/[slug]).
 *
 * Every collected Google Trends keyword gets a dedicated, SEO-optimized
 * landing page that catches organic search traffic for that keyword and
 * funnels visitors to the AI business-plan report and registration. The slug
 * is derived from the keyword (no extra column), so lookups fetch candidate
 * rows with a tolerant ILIKE pattern and re-verify with slugifyKeyword.
 */

export interface LandingKeyword {
  keyword: string;
  slug: string;
  searchVolume: number;
  growthRate: number;
  region: string;
  lastSeen: Date;
  appearances: number;
}

export interface LandingHistoryRow {
  searchVolume: number;
  growthRate: number;
  region: string;
  collectedAt: Date;
}

export interface LandingBpSummary {
  id: string;
  title: string | null;
  summary: string | null;
  selectedOpportunity: string | null;
}

export interface LandingPageData {
  keyword: LandingKeyword;
  history: LandingHistoryRow[];
  bp: LandingBpSummary | null;
}

/** Matches bp.ts normalizeKeyword so the landing page finds the keyword's BP. */
function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

const MAX_HISTORY_ROWS = 30;

export class LandingService {
  /**
   * Distinct collected keywords, newest first. Backs the /t index page and the
   * sitemap. Slugs that collapse to empty (pure-punctuation keywords) are
   * dropped — they can't have a URL.
   */
  async listKeywords(page = 1, pageSize = 50): Promise<{
    keywords: LandingKeyword[];
    pagination: { currentPage: number; totalPages: number; totalItems: number; pageSize: number };
  }> {
    const tableName = await getTrendsTableName();
    const timestampCol = await getTimestampColumnName(tableName);
    const tsRef = timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';

    const countRow = await queryOne<{ total: string }>(
      `SELECT COUNT(DISTINCT keyword) AS total FROM "${tableName}"`
    );
    const totalItems = parseInt(countRow?.total || '0', 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const offset = (page - 1) * pageSize;

    const rows = await query<any>(
      `SELECT keyword,
              MAX(search_volume) AS search_volume,
              MAX(growth_rate) AS growth_rate,
              MAX(region) AS region,
              MAX(${tsRef}) AS last_seen,
              COUNT(*) AS appearances
       FROM "${tableName}"
       GROUP BY keyword
       ORDER BY last_seen DESC, search_volume DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    const keywords = rows
      .map((r) => this.mapKeywordRow(r))
      .filter((k) => k.slug.length > 0);

    return { keywords, pagination: { currentPage: page, totalPages, totalItems, pageSize } };
  }

  /** Newest keywords for the sitemap (slug + lastmod only). */
  async listKeywordsForSitemap(limit = 300): Promise<{ slug: string; lastSeen: Date }[]> {
    const { keywords } = await this.listKeywords(1, limit);
    return keywords.map((k) => ({ slug: k.slug, lastSeen: k.lastSeen }));
  }

  /**
   * Resolve a slug back to its keyword and assemble the landing page data:
   * aggregated stats, trending history, and the completed BP (if any).
   * Returns null when no collected keyword matches the slug.
   */
  async getLandingData(slug: string): Promise<LandingPageData | null> {
    const clean = slug.trim().toLowerCase();
    if (!clean || clean.length > 200) return null;

    const tableName = await getTrendsTableName();
    const timestampCol = await getTimestampColumnName(tableName);
    const tsRef = timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';

    // Candidate keywords whose slug could equal `clean` (hyphens are wildcards),
    // then verify exactly by recomputing the slug.
    const pattern = slugToLikePattern(clean);
    const candidates = await query<{ keyword: string }>(
      `SELECT DISTINCT keyword FROM "${tableName}" WHERE keyword ILIKE $1 LIMIT 50`,
      [pattern]
    );
    const keyword = candidates.map((c) => c.keyword).find((k) => slugifyKeyword(k) === clean);
    if (!keyword) return null;

    const aggRow = await queryOne<any>(
      `SELECT keyword,
              MAX(search_volume) AS search_volume,
              MAX(growth_rate) AS growth_rate,
              MAX(region) AS region,
              MAX(${tsRef}) AS last_seen,
              COUNT(*) AS appearances
       FROM "${tableName}"
       WHERE keyword = $1
       GROUP BY keyword`,
      [keyword]
    );
    if (!aggRow) return null;

    const historyRows = await query<any>(
      `SELECT search_volume, growth_rate, region, ${tsRef} AS collected_at
       FROM "${tableName}"
       WHERE keyword = $1
       ORDER BY ${tsRef} DESC
       LIMIT $2`,
      [keyword, MAX_HISTORY_ROWS]
    );

    // Canonical completed report preferred; any completed report as fallback.
    const norm = normalizeKeyword(keyword);
    const bpRow = await queryOne<any>(
      `SELECT id, title, summary, selected_opportunity
       FROM bp_reports
       WHERE keyword_norm = $1 AND status = 'completed'
       ORDER BY (canonical_report_id IS NULL) DESC, created_at DESC
       LIMIT 1`,
      [norm]
    );

    return {
      keyword: this.mapKeywordRow(aggRow),
      history: historyRows.map((r) => ({
        searchVolume: Number(r.search_volume) || 0,
        growthRate: Number(r.growth_rate) || 0,
        region: r.region ?? '',
        collectedAt: r.collected_at instanceof Date ? r.collected_at : new Date(r.collected_at),
      })),
      bp: bpRow
        ? {
            id: bpRow.id,
            title: bpRow.title ?? null,
            summary: bpRow.summary ?? null,
            selectedOpportunity: bpRow.selected_opportunity ?? null,
          }
        : null,
    };
  }

  private mapKeywordRow(r: any): LandingKeyword {
    return {
      keyword: r.keyword,
      slug: slugifyKeyword(r.keyword),
      searchVolume: Number(r.search_volume) || 0,
      growthRate: Number(r.growth_rate) || 0,
      region: r.region ?? '',
      lastSeen: r.last_seen instanceof Date ? r.last_seen : new Date(r.last_seen ?? 0),
      appearances: Number(r.appearances) || 0,
    };
  }
}

export const landingService = new LandingService();
