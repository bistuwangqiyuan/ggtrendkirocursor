import { query, queryOne, pool } from '../db/client';
import { trendsService } from './trends';
import { generateJson, isLlmConfigured, LlmError } from './llm';
import type {
  BpContent,
  BpOpportunity,
  BpReport,
  BpReportListItem,
  BpScores,
  BpTrendSnapshot,
  GenerateBpInput,
  PaginatedBpReports,
  Result,
  BpError,
  Trend,
} from '../../types';

/** Fixed six-dimension weights (sum = 1). Server is the source of truth. */
export const SCORE_WEIGHTS: Record<keyof BpScores, number> = {
  market: 0.18,
  roi: 0.25,
  onlineability: 0.20,
  feasibility: 0.12,
  speed: 0.10,
  moat: 0.15,
};

const SCORE_KEYS: (keyof BpScores)[] = ['market', 'roi', 'onlineability', 'feasibility', 'speed', 'moat'];

/** Clamp a value into the 1..10 scoring band; non-numbers become 0. */
function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

/** Compute the weighted total from six dimensions, rounded to 2 decimals. */
export function computeWeightedScore(scores: BpScores): number {
  let total = 0;
  for (const key of SCORE_KEYS) {
    total += clampScore(scores[key]) * SCORE_WEIGHTS[key];
  }
  return Math.round(total * 100) / 100;
}

export class BpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BpValidationError';
  }
}

/**
 * Parse the largest percentage value found in a win-rate string (e.g. "约8%-12%"
 * -> 12). Returns null when no percentage is present. Pure, for unit testing.
 */
export function parseWinRatePercent(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const matches = s.match(/\d+(?:\.\d+)?/g);
  if (!matches) return null;
  const nums = matches.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

/** Win rates above this (% profitable cash exit) are flagged as optimistic. */
export const WIN_RATE_OPTIMISM_THRESHOLD = 40;

/**
 * Parse the first signed number out of a percent-like string, e.g.
 * "约6.5%" -> 6.5, "-12%（悲观）" -> -12. Sign matters for risk-adjusted
 * returns (unlike parseWinRatePercent which takes the optimistic max).
 */
export function parseSignedPercent(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Whitelisted sort options for the report list. */
export type BpListSortBy = 'createdAt' | 'riskAdjusted';
export type BpListSortOrder = 'asc' | 'desc';

/**
 * Validate the raw LLM JSON against the BP contract and normalize it:
 * - recompute every weighted score (do not trust the model's self-report)
 * - rank opportunities by weighted score and mark the top one as selected
 * - force `selectedOpportunity` to the actual highest-scoring opportunity
 * Throws BpValidationError when required structure is missing.
 */
export function validateAndNormalizeBpContent(raw: any): BpContent {
  if (!raw || typeof raw !== 'object') throw new BpValidationError('Response is not an object');

  const oppsRaw = Array.isArray(raw.opportunities) ? raw.opportunities : [];
  if (oppsRaw.length < 5) {
    throw new BpValidationError(`Expected >= 5 opportunities, got ${oppsRaw.length}`);
  }

  let opportunities: BpOpportunity[] = oppsRaw.map((o: any) => {
    const s = o?.scores ?? {};
    for (const key of SCORE_KEYS) {
      if (s[key] === undefined || s[key] === null) {
        throw new BpValidationError(`Opportunity "${o?.name ?? '?'}" missing score "${key}"`);
      }
    }
    const scores: BpScores = {
      market: clampScore(s.market),
      roi: clampScore(s.roi),
      onlineability: clampScore(s.onlineability),
      feasibility: clampScore(s.feasibility),
      speed: clampScore(s.speed),
      moat: clampScore(s.moat),
    };
    const name = String(o?.name ?? '').trim();
    if (!name) throw new BpValidationError('Opportunity missing name');
    return {
      name,
      description: String(o?.description ?? '').trim(),
      scores,
      weightedScore: computeWeightedScore(scores),
      isSelected: false,
      rank: 0,
    };
  });

  opportunities.sort((a, b) => b.weightedScore - a.weightedScore);
  opportunities = opportunities.map((o, i) => ({ ...o, rank: i + 1, isSelected: i === 0 }));
  const selected = opportunities[0];

  const seed = raw.seedReturn ?? {};
  if (!Array.isArray(seed.bookRoiByYear) || seed.bookRoiByYear.length < 5) {
    throw new BpValidationError('seedReturn.bookRoiByYear must have 5 yearly values');
  }
  for (const field of ['annualizedBook', 'winRate', 'profitLossRatio', 'expectedValueMOIC', 'riskAdjustedAnnualized']) {
    if (!seed[field]) throw new BpValidationError(`seedReturn missing "${field}"`);
  }

  if (!raw.title || !raw.summary) throw new BpValidationError('Missing title/summary');

  // Anti-optimism guardrail: a seed-stage profitable cash-exit win rate above the
  // threshold is implausible for China early-stage; append a calibration note
  // rather than hard-failing generation.
  const winRateStr = String(seed.winRate).trim();
  const winRatePct = parseWinRatePercent(winRateStr);
  let seedNotes = seed.notes ? String(seed.notes).trim() : undefined;
  if (winRatePct !== null && winRatePct > WIN_RATE_OPTIMISM_THRESHOLD) {
    const flag = `【风险校准提示】所填胜率（${winRateStr}）按"盈利现金退出"口径偏高，国内种子阶段单笔投资 5 年内实现盈利现金退出的概率通常仅为个位数到约 10-15%，请按现金退出口径审慎解读，勿以账面存活冒充现金退出。`;
    seedNotes = seedNotes ? `${seedNotes} ${flag}` : flag;
  }

  const market = raw.market ?? {};
  const financials = raw.financials ?? {};

  return {
    title: String(raw.title).trim(),
    summary: String(raw.summary).trim(),
    selectedOpportunity: selected.name,
    opportunities,
    market: {
      tam: String(market.tam ?? '').trim(),
      sam: String(market.sam ?? '').trim(),
      som: String(market.som ?? '').trim(),
      notes: market.notes ? String(market.notes).trim() : undefined,
    },
    businessModel: String(raw.businessModel ?? '').trim(),
    financials: {
      years: Array.isArray(financials.years)
        ? financials.years.map((y: any) => ({
            year: Number(y?.year) || 0,
            revenue: String(y?.revenue ?? '').trim(),
            ebitda: String(y?.ebitda ?? '').trim(),
          }))
        : [],
    },
    seedReturn: {
      bookRoiByYear: seed.bookRoiByYear.slice(0, 5).map((n: any) => Number(n) || 0),
      annualizedBook: String(seed.annualizedBook).trim(),
      winRate: String(seed.winRate).trim(),
      profitLossRatio: String(seed.profitLossRatio).trim(),
      expectedValueMOIC: String(seed.expectedValueMOIC).trim(),
      riskAdjustedAnnualized: String(seed.riskAdjustedAnnualized).trim(),
      notes: seedNotes,
    },
  };
}

function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize a free-text business model for dedup comparison: lowercase, collapse
 * whitespace, and strip leading/trailing punctuation. Two plans whose normalized
 * business models are equal are treated as the same model.
 */
export function normalizeBusinessModel(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim();
}

/**
 * Pure helper: given a normalized business model and a list of existing completed
 * reports, return the id of the earliest one sharing that model (excluding the
 * report being generated). Returns null when there is no match.
 */
export function pickCanonicalByBusinessModel(
  bmNorm: string,
  candidates: { id: string; businessModelNorm: string; createdAt: Date }[],
  excludeId?: string
): string | null {
  if (!bmNorm) return null;
  const matches = candidates
    .filter((c) => c.id !== excludeId && c.businessModelNorm === bmNorm)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return matches.length > 0 ? matches[0].id : null;
}

const SYSTEM_PROMPT = `你是一位资深的早期风险投资分析师与连续创业者。基于给定的"谷歌热搜关键词"，头脑风暴**可完全线上化（纯网站/SaaS，无需线下重资产）**的商业机会，进行严谨评分与遴选，遴选其中**投入产出比（ROI）最高且可完全线上化**的机会，并产出一份投资人级别、数据公允、可溯源、可执行的结构化商业计划书。

【输出格式】
1. 必须只输出一个 JSON 对象，不要任何额外文字或 Markdown 代码块。
2. 字段名保持英文，文本内容用中文。

【机会与评分】
3. opportunities 至少 5 个，每个含 name、description 及 scores（market/roi/onlineability/feasibility/speed/moat，取值 1-10 整数或一位小数）。description 需具体到产品形态、目标用户、获客方式、变现方式，避免空话。
4. 优先遴选可完全线上化、且 ROI 高的机会；最终 selectedOpportunity 必须是综合最优者（服务器会按固定权重重新计算并校正，请如实评分）。

【公允数据 · 反乐观谬误（极重要）】
5. 所有财务与回报数据必须**实事求是、公允**，符合**国内（中国）同阶段同类创业**的真实基准概率，严禁乐观谬误。校准锚点（用于推理，不要照抄，须结合本机会具体调整并给出依据）：
   - 早期/种子阶段创业**绝大多数最终回报为 0 或亏损**；能走到下一轮（A 轮）的比例通常约 10-20%。
   - **以"真实现金退出"（被并购/老股转让/IPO 且形成真实流动性）口径衡量，种子轮单笔投资 5 年内实现盈利现金退出的概率通常仅为个位数到约 10-15%**，绝不能用"账面存活/纸面估值上涨"冒充现金退出。
   - 早期 VC 回报呈幂律分布：胜率低、但盈亏比高（极少数赢家可达数十倍）。单一项目种子轮的期望收益倍数（EV/MOIC）通常约 1.0-2.5x（已计入大概率归零），并非每个项目都能赚钱。
6. 必须严格区分两套口径：
   - 账面口径（book）：基于业务存活/账面估值，偏乐观，仅供参考。
   - 风险调整/现金退出口径（cash-exit / risk-adjusted）：已乘以"真实拿到钱的概率"，是决策依据。
   两者不得混用，winRate 必须是"盈利现金退出"的概率，不得用存活率冒充。

【种子轮回报指标】
7. seedReturn 必须给出：bookRoiByYear（第1-5年账面ROI，百分比数字数组，5个）、annualizedBook（账面年化）、winRate（盈利现金退出的概率，如"约8%-12%"）、profitLossRatio（盈亏比，如"约6:1"）、expectedValueMOIC（已计入归零概率的期望收益倍数EV，如"约1.4x"）、riskAdjustedAnnualized（风险调整年化，通常远低于账面年化）、notes（口径与计算依据说明）。

【执行摘要必须包含回报数字】
8. summary（执行摘要）正文中必须用文字明确写出：种子轮资金第1/2/3/4/5年的投资收益率（ROI）、年化收益、胜率（盈利现金退出的概率）、盈亏比，并强调这些是"成功拿到钱（现金退出）口径"而非账面存活口径。摘要还需点明选定机会、市场空间与可执行的关键路径。`;

function buildUserPrompt(trend: BpTrendSnapshot): string {
  return `谷歌热搜第一名关键词："${trend.keyword}"
分类：${trend.category || '未知'} | 搜索量：${trend.searchVolume} | 增长速度：${trend.growthRate} | 趋势窗口：${trend.timeRange} | 地区：${trend.region || '全球'}

请基于该关键词，头脑风暴可完全线上化（纯网站/SaaS）的商业机会，遴选 ROI 最高者，产出公允、可执行的商业计划书。
特别要求：summary 正文必须用文字写明"种子轮资金第1/2/3/4/5年投资收益率、年化收益、胜率（盈利现金退出概率）、盈亏比"，且明确这是"成功现金退出"口径而非账面存活口径；所有概率与收益必须符合国内同阶段真实基准，避免乐观谬误。

请严格按以下 JSON 结构输出（字段名保持英文，文本内容用中文）：
{
  "title": "",
  "summary": "（执行摘要：含选定机会、市场空间、关键可执行路径；并明确写出种子轮第1-5年ROI、年化、胜率(现金退出)、盈亏比）",
  "selectedOpportunity": "",
  "opportunities": [ { "name": "", "description": "", "scores": { "market": 0, "roi": 0, "onlineability": 0, "feasibility": 0, "speed": 0, "moat": 0 } } ],
  "market": { "tam": "", "sam": "", "som": "", "notes": "" },
  "businessModel": "",
  "financials": { "years": [ { "year": 1, "revenue": "", "ebitda": "" } ] },
  "seedReturn": { "bookRoiByYear": [0,0,0,0,0], "annualizedBook": "", "winRate": "", "profitLossRatio": "", "expectedValueMOIC": "", "riskAdjustedAnnualized": "", "notes": "" }
}`;
}

/**
 * Deduplication window (days). A keyword is treated as "already done" only if it
 * has a completed BP within this many days; after the window elapses the cron
 * regenerates a fresh BP. The same window bounds the manual reuse path and the
 * business-model dedup, so the weekly refresh produces genuinely new content.
 */
export const DEDUPE_WINDOW_DAYS = 7;

/** True when `date` is within `days` of `now` (inclusive boundary at exactly N days). */
export function isWithinDays(date: Date, now: Date, days: number): boolean {
  const ms = now.getTime() - date.getTime();
  if (!Number.isFinite(ms)) return false;
  return ms <= days * 24 * 60 * 60 * 1000 && ms >= 0;
}

/**
 * Pure helper: build the set of keyword_norms that are "recently completed"
 * (within `windowDays`). Used by the cron skip-set so the 7-day rule is
 * unit-testable independently of the database.
 */
export function recentKeywordNormSet(
  rows: { keywordNorm: string; createdAt: Date }[],
  now: Date,
  windowDays = DEDUPE_WINDOW_DAYS
): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.keywordNorm && isWithinDays(r.createdAt, now, windowDays)) {
      set.add(r.keywordNorm);
    }
  }
  return set;
}

/** Minimum composite hotword score (0-100) for scheduled BP generation. */
export const MIN_TREND_SCORE = 60;

const SCHEDULED_SCAN_PAGE_SIZE = 50;
const SCHEDULED_SCAN_MAX_PAGES = 5;

/** Composite 0-100 score: 50% growth_rate (%) + 50% log-normalized search volume. */
export function computeTrendHotwordScore(t: { searchVolume: number; growthRate: number }): number {
  const growthPart = Math.min(100, Math.max(0, t.growthRate));
  const volumePart = Math.min(100, (Math.log10(Math.max(1, t.searchVolume)) / 6) * 100);
  return Math.round(growthPart * 0.5 + volumePart * 0.5);
}

/**
 * Pick the first trend (in search_volume order) that has no completed BP and
 * meets the score threshold. Pure function for unit testing.
 */
export function pickFirstEligibleTrend(
  trends: Trend[],
  completedKeywordNorms: Set<string>,
  minScore = MIN_TREND_SCORE,
  startRank = 1
): { trend: Trend; trendScore: number; rank: number } | null {
  let rank = startRank;
  for (const trend of trends) {
    const norm = normalizeKeyword(trend.keyword);
    if (completedKeywordNorms.has(norm)) {
      rank++;
      continue;
    }
    const trendScore = computeTrendHotwordScore(trend);
    if (trendScore <= minScore) {
      rank++;
      continue;
    }
    return { trend, trendScore, rank };
  }
  return null;
}

function mapReportRow(row: any): BpReport {
  return {
    id: row.id,
    keyword: row.keyword,
    keywordNorm: row.keyword_norm,
    sourceTrendId: row.source_trend_id ?? undefined,
    searchVolume: Number(row.search_volume) || 0,
    growthRate: Number(row.growth_rate) || 0,
    category: row.category ?? '',
    timeRange: row.time_range ?? '',
    region: row.region ?? '',
    rank: Number(row.rank) || 0,
    status: row.status,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    selectedOpportunity: row.selected_opportunity ?? undefined,
    contentJson: row.content_json ?? null,
    businessModelNorm: row.business_model_norm ?? undefined,
    canonicalReportId: row.canonical_report_id ?? null,
    model: row.model ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    error: row.error ?? null,
    userId: row.user_id ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export class BpService {
  /** Resolve the source trend: explicit keyword/trendId, else the #1 by search volume. */
  async resolveSourceTrend(input: GenerateBpInput): Promise<BpTrendSnapshot | null> {
    const timeRange = input.timeRange || '4h';

    const res = await trendsService.getTrends({
      timeRange,
      keyword: input.keyword || undefined,
      sortBy: 'search_volume',
      sortOrder: 'desc',
      page: 1,
      pageSize: 1,
    });

    let trend = res.success ? res.data.trends[0] : undefined;

    // Fallback: ignore the time-range filter if nothing matched.
    if (!trend) {
      const res2 = await trendsService.getTrends({
        keyword: input.keyword || undefined,
        sortBy: 'search_volume',
        sortOrder: 'desc',
        page: 1,
        pageSize: 1,
      });
      trend = res2.success ? res2.data.trends[0] : undefined;
    }

    if (!trend) return null;

    return {
      sourceTrendId: input.trendId || trend.id,
      keyword: trend.keyword,
      searchVolume: trend.searchVolume,
      growthRate: trend.growthRate,
      category: trend.category,
      timeRange: trend.timeRange || timeRange,
      region: trend.region || '',
      rank: 1,
    };
  }

  /** Whether a completed BP exists for this keyword within the dedupe window. */
  async hasCompletedBp(keywordNorm: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM bp_reports
         WHERE keyword_norm = $1 AND status = 'completed'
           AND created_at >= NOW() - make_interval(days => $2)
       ) AS exists`,
      [keywordNorm, DEDUPE_WINDOW_DAYS]
    );
    return !!row?.exists;
  }

  /**
   * Keyword_norm values with a completed BP within the dedupe window (7 days).
   * Older keywords fall out of the set so the cron regenerates a fresh BP.
   * Filtering is done via the pure `recentKeywordNormSet` helper (testable).
   */
  async getRecentlyCompletedKeywordNorms(windowDays = DEDUPE_WINDOW_DAYS): Promise<Set<string>> {
    const rows = await query<{ keyword_norm: string; created_at: any }>(
      `SELECT keyword_norm, created_at FROM bp_reports
       WHERE status = 'completed' AND keyword_norm IS NOT NULL
         AND created_at >= NOW() - make_interval(days => $1)`,
      [windowDays]
    );
    const mapped = rows.map((r) => ({
      keywordNorm: r.keyword_norm,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));
    return recentKeywordNormSet(mapped, new Date(), windowDays);
  }

  /**
   * Walk trends by search_volume desc; return the first whose composite score
   * exceeds MIN_TREND_SCORE and which has no completed BP within the dedupe
   * window (7 days). Keywords last generated more than 7 days ago are eligible
   * again so their BP is refreshed.
   */
  async pickNextUngeneratedTrend(
    timeRange = '4h'
  ): Promise<{ snapshot: BpTrendSnapshot; trendScore: number } | null> {
    const completed = await this.getRecentlyCompletedKeywordNorms();
    let globalRank = 0;
    let effectiveTimeRange: string | undefined = timeRange;

    for (let page = 1; page <= SCHEDULED_SCAN_MAX_PAGES; page++) {
      const res = await trendsService.getTrends({
        timeRange: effectiveTimeRange,
        sortBy: 'search_volume',
        sortOrder: 'desc',
        page,
        pageSize: SCHEDULED_SCAN_PAGE_SIZE,
      });

      if (page === 1 && (!res.success || res.data.trends.length === 0) && effectiveTimeRange) {
        effectiveTimeRange = undefined;
        page = 0;
        continue;
      }

      if (!res.success || res.data.trends.length === 0) break;

      const picked = pickFirstEligibleTrend(res.data.trends, completed, MIN_TREND_SCORE, globalRank + 1);
      if (picked) {
        const { trend, trendScore, rank } = picked;
        return {
          trendScore,
          snapshot: {
            sourceTrendId: trend.id,
            keyword: trend.keyword,
            searchVolume: trend.searchVolume,
            growthRate: trend.growthRate,
            category: trend.category,
            timeRange: trend.timeRange || timeRange,
            region: trend.region || '',
            rank,
          },
        };
      }

      globalRank += res.data.trends.length;
      if (res.data.pagination.currentPage >= res.data.pagination.totalPages) break;
    }

    return null;
  }

  /**
   * Find the earliest completed report within the dedupe window (7 days) whose
   * business model matches `bmNorm` (excluding `excludeId`). Bounding by the
   * window means the weekly keyword refresh produces genuinely new content
   * rather than re-pointing at a stale canonical from a previous week.
   * Only considers canonical reports (those that are not themselves duplicates).
   */
  async findCompletedByBusinessModel(bmNorm: string, excludeId?: string): Promise<BpReport | null> {
    if (!bmNorm) return null;
    const row = await queryOne<any>(
      `SELECT * FROM bp_reports
       WHERE status = 'completed'
         AND business_model_norm = $1
         AND canonical_report_id IS NULL
         AND created_at >= NOW() - make_interval(days => $3)
         AND ($2::uuid IS NULL OR id <> $2::uuid)
       ORDER BY created_at ASC LIMIT 1`,
      [bmNorm, excludeId ?? null, DEDUPE_WINDOW_DAYS]
    );
    return row ? mapReportRow(row) : null;
  }

  /** Return a completed report for this keyword within the dedupe window (7 days), if any. */
  async findReusable(keywordNorm: string): Promise<BpReport | null> {
    const row = await queryOne<any>(
      `SELECT * FROM bp_reports
       WHERE keyword_norm = $1 AND status = 'completed'
         AND created_at >= NOW() - make_interval(days => $2)
       ORDER BY created_at DESC LIMIT 1`,
      [keywordNorm, DEDUPE_WINDOW_DAYS]
    );
    return row ? mapReportRow(row) : null;
  }

  /**
   * Mark long-running `generating`/`pending` rows as `failed` so a later run can
   * retry them. Serverless timeouts can otherwise leave reports stuck forever.
   * Returns the number of rows reset.
   */
  async resetStaleGenerating(maxAgeMinutes = 15): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE bp_reports
         SET status = 'failed',
             error = COALESCE(error, '') || ' [auto-reset: stale generating]',
             updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('generating', 'pending')
         AND updated_at < NOW() - make_interval(mins => $1)
       RETURNING id`,
      [maxAgeMinutes]
    );
    return rows.length;
  }

  /**
   * Scheduled entry point: clean stale rows, pick the next eligible hotword
   * (score > MIN_TREND_SCORE, no completed BP within the last 7 days), then
   * generate one new BP. Keywords roll back into eligibility after 7 days.
   */
  async runScheduledGeneration(): Promise<
    Result<
      | { action: 'generated'; report: BpReport; trendScore: number; rank: number }
      | { action: 'skipped'; reason: string },
      BpError
    >
  > {
    if (!isLlmConfigured()) {
      return { success: false, error: { code: 'LLM_NOT_CONFIGURED', message: 'AI 服务未配置（缺少 LLM_API_KEY）' } };
    }

    const staleReset = await this.resetStaleGenerating();
    if (staleReset > 0) {
      console.log(`[bp-cron] reset ${staleReset} stale generating report(s)`);
    }

    const picked = await this.pickNextUngeneratedTrend('4h');
    if (!picked) {
      return { success: true, data: { action: 'skipped', reason: 'no_eligible_trend' } };
    }

    const { snapshot, trendScore } = picked;
    const result = await this.generate({
      keyword: snapshot.keyword,
      trendId: snapshot.sourceTrendId,
      timeRange: '4h',
    });
    if (!result.success) return result;
    return {
      success: true,
      data: { action: 'generated', report: result.data, trendScore, rank: snapshot.rank },
    };
  }

  /**
   * Full orchestration: resolve trend -> dedupe -> placeholder -> LLM -> validate
   * -> persist report + opportunities. Returns the final (completed/failed) report.
   */
  async generate(input: GenerateBpInput): Promise<Result<BpReport, BpError>> {
    if (!isLlmConfigured()) {
      return { success: false, error: { code: 'LLM_NOT_CONFIGURED', message: 'AI 服务未配置（缺少 LLM_API_KEY）' } };
    }

    const trend = await this.resolveSourceTrend(input);
    if (!trend) {
      return { success: false, error: { code: 'NO_TREND', message: '没有可用于生成的趋势数据' } };
    }

    const keywordNorm = normalizeKeyword(trend.keyword);

    const reusable = await this.findReusable(keywordNorm);
    if (reusable) {
      return { success: true, data: reusable };
    }

    // Insert placeholder row (status=generating) so failures are traceable.
    const placeholder = await queryOne<any>(
      `INSERT INTO bp_reports
        (keyword, keyword_norm, source_trend_id, search_volume, growth_rate, category, time_range, region, rank, status, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generating',$10)
       RETURNING *`,
      [
        trend.keyword,
        keywordNorm,
        trend.sourceTrendId ?? null,
        trend.searchVolume,
        trend.growthRate,
        trend.category,
        trend.timeRange,
        trend.region,
        trend.rank,
        input.userId ?? null,
      ]
    );

    if (!placeholder) {
      return { success: false, error: { code: 'DB_ERROR', message: '无法创建 BP 记录' } };
    }

    const reportId: string = placeholder.id;

    try {
      const llm = await generateJson<any>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(trend),
        temperature: 0.7,
        maxTokens: 4000,
      });

      const content = validateAndNormalizeBpContent(llm.data);
      const bmNorm = normalizeBusinessModel(content.businessModel);
      const model = llm.provider ? `${llm.provider}/${llm.model}` : llm.model;

      // Business-model dedupe: if an existing completed plan already describes the
      // same business model, reuse it instead of storing duplicate content. The
      // placeholder row is marked completed and points at the canonical report so
      // the trigger keyword counts as "done" (cron won't regenerate it).
      const canonical = await this.findCompletedByBusinessModel(bmNorm, reportId);
      if (canonical) {
        await query(
          `UPDATE bp_reports SET
            status = 'completed',
            title = $2,
            summary = $3,
            selected_opportunity = $4,
            content_json = NULL,
            business_model_norm = $5,
            canonical_report_id = $6,
            model = $7,
            tokens_used = $8,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            reportId,
            canonical.title ?? null,
            canonical.summary ?? null,
            canonical.selectedOpportunity ?? null,
            bmNorm,
            canonical.id,
            model,
            llm.tokensUsed ?? null,
          ]
        );
        // Return the canonical plan with its content resolved (via getById).
        const resolved = await this.getById(reportId);
        if (resolved.success) return resolved;
        return { success: true, data: canonical };
      }

      const updated = await queryOne<any>(
        `UPDATE bp_reports SET
          status = 'completed',
          title = $2,
          summary = $3,
          selected_opportunity = $4,
          content_json = $5,
          business_model_norm = $8,
          model = $6,
          tokens_used = $7,
          error = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [
          reportId,
          content.title,
          content.summary,
          content.selectedOpportunity,
          JSON.stringify(content),
          model,
          llm.tokensUsed ?? null,
          bmNorm,
        ]
      );

      // Persist opportunities (parameterized multi-row insert).
      await this.insertOpportunities(reportId, content.opportunities);

      const report = mapReportRow(updated);
      report.opportunities = content.opportunities;
      return { success: true, data: report };
    } catch (err) {
      const code = err instanceof LlmError ? err.code : err instanceof BpValidationError ? 'BP_INVALID' : 'GENERATION_FAILED';
      const message = (err as Error).message || '生成失败';
      await query(
        `UPDATE bp_reports SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [reportId, `${code}: ${message}`.slice(0, 1000)]
      );
      return {
        success: false,
        error: { code, message, reportId },
      };
    }
  }

  private async insertOpportunities(reportId: string, opps: BpOpportunity[]): Promise<void> {
    if (!opps.length) return;
    const cols = 13;
    const valuesSql: string[] = [];
    const params: any[] = [];
    opps.forEach((o, i) => {
      const base = i * cols;
      valuesSql.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`
      );
      params.push(
        reportId,
        o.name,
        o.description,
        o.scores.market,
        o.scores.roi,
        o.scores.onlineability,
        o.scores.feasibility,
        o.scores.speed,
        o.scores.moat,
        o.weightedScore,
        o.isSelected,
        o.rank,
        new Date()
      );
    });
    await query(
      `INSERT INTO bp_opportunities
        (report_id, name, description, score_market, score_roi, score_onlineability, score_feasibility, score_speed, score_moat, weighted_score, is_selected, rank, created_at)
       VALUES ${valuesSql.join(',')}`,
      params
    );
  }

  /** Fetch a single report plus its ranked opportunities. */
  async getById(id: string): Promise<Result<BpReport, BpError>> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'BP 不存在' } };
    }
    const row = await queryOne<any>(`SELECT * FROM bp_reports WHERE id = $1`, [id]);
    if (!row) return { success: false, error: { code: 'NOT_FOUND', message: 'BP 不存在' } };

    const report = mapReportRow(row);

    // Duplicate (business-model) rows store no content of their own; resolve the
    // plan content and opportunities from the canonical report they point at.
    const contentSourceId =
      !report.contentJson && report.canonicalReportId ? report.canonicalReportId : id;

    if (contentSourceId !== id) {
      const canonRow = await queryOne<any>(`SELECT * FROM bp_reports WHERE id = $1`, [contentSourceId]);
      if (canonRow) {
        report.contentJson = canonRow.content_json ?? null;
        report.title = report.title ?? canonRow.title ?? undefined;
        report.summary = report.summary ?? canonRow.summary ?? undefined;
        report.selectedOpportunity = report.selectedOpportunity ?? canonRow.selected_opportunity ?? undefined;
      }
    }

    const oppRows = await query<any>(
      `SELECT * FROM bp_opportunities WHERE report_id = $1 ORDER BY rank ASC`,
      [contentSourceId]
    );
    if (oppRows.length > 0) {
      report.opportunities = oppRows.map((o) => ({
        id: o.id,
        reportId: o.report_id,
        name: o.name,
        description: o.description ?? '',
        scores: {
          market: Number(o.score_market) || 0,
          roi: Number(o.score_roi) || 0,
          onlineability: Number(o.score_onlineability) || 0,
          feasibility: Number(o.score_feasibility) || 0,
          speed: Number(o.score_speed) || 0,
          moat: Number(o.score_moat) || 0,
        },
        weightedScore: Number(o.weighted_score) || 0,
        isSelected: !!o.is_selected,
        rank: Number(o.rank) || 0,
      }));
    } else if (Array.isArray(report.contentJson?.opportunities) && report.contentJson!.opportunities.length > 0) {
      // Fallback: opportunities are always embedded in content_json (the authoritative
      // source). This keeps the score matrix rendering even if the bp_opportunities
      // table insert was skipped (e.g. transient/legacy-schema write failure).
      report.opportunities = report.contentJson!.opportunities.map((o: any, i: number) => ({
        id: `${id}-opp-${i}`,
        reportId: id,
        name: o.name,
        description: o.description ?? '',
        scores: {
          market: Number(o?.scores?.market) || 0,
          roi: Number(o?.scores?.roi) || 0,
          onlineability: Number(o?.scores?.onlineability) || 0,
          feasibility: Number(o?.scores?.feasibility) || 0,
          speed: Number(o?.scores?.speed) || 0,
          moat: Number(o?.scores?.moat) || 0,
        },
        weightedScore: Number(o.weightedScore) || 0,
        isSelected: !!o.isSelected,
        rank: Number(o.rank) || i + 1,
      }));
    } else {
      report.opportunities = [];
    }
    return { success: true, data: report };
  }

  /**
   * Paginated list of reports (without the large content JSON).
   * Exposes the risk-adjusted annualized return (resolved through
   * canonical_report_id for dedup pointers) and supports sorting by it.
   */
  async list(
    page = 1,
    pageSize = 20,
    sortBy: BpListSortBy = 'createdAt',
    sortOrder: BpListSortOrder = 'desc'
  ): Promise<Result<PaginatedBpReports, BpError>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const offset = (safePage - 1) * safeSize;

    const countRow = await queryOne<{ total: string }>(`SELECT COUNT(*) as total FROM bp_reports`);
    const totalItems = parseInt(countRow?.total || '0', 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));

    const dir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    // Whitelist-built ORDER BY (no user input is interpolated directly).
    const orderBy = sortBy === 'riskAdjusted'
      ? `risk_adjusted_num ${dir} NULLS LAST, r.created_at DESC`
      : `r.created_at ${dir}`;

    // Duplicate reports store no content; resolve via the canonical report.
    // risk_adjusted_num extracts the first signed number ("约6.5%" -> 6.5) for sorting.
    const rows = await query<any>(
      `SELECT r.id, r.keyword, r.title, r.status, r.selected_opportunity, r.created_at,
              COALESCE(r.content_json, c.content_json)->'seedReturn'->>'riskAdjustedAnnualized' AS risk_adjusted,
              NULLIF(substring(
                COALESCE(r.content_json, c.content_json)->'seedReturn'->>'riskAdjustedAnnualized'
                from '-?[0-9]+\\.?[0-9]*'
              ), '')::numeric AS risk_adjusted_num
       FROM bp_reports r
       LEFT JOIN bp_reports c ON r.canonical_report_id = c.id
       ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [safeSize, offset]
    );

    const reports: BpReportListItem[] = rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      title: r.title ?? undefined,
      status: r.status,
      selectedOpportunity: r.selected_opportunity ?? undefined,
      riskAdjustedAnnualized: r.risk_adjusted ?? undefined,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));

    return {
      success: true,
      data: { reports, pagination: { currentPage: safePage, totalPages, totalItems, pageSize: safeSize } },
    };
  }
}

export const bpService = new BpService();
