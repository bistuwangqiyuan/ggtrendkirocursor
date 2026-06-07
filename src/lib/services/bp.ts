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
} from '../../types';

/** Fixed six-dimension weights (sum = 1). Server is the source of truth. */
export const SCORE_WEIGHTS: Record<keyof BpScores, number> = {
  market: 0.20,
  roi: 0.25,
  onlineability: 0.15,
  feasibility: 0.15,
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
      notes: seed.notes ? String(seed.notes).trim() : undefined,
    },
  };
}

function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

const SYSTEM_PROMPT = `你是一位资深的早期风险投资分析师与连续创业者。基于给定的"谷歌热搜关键词"，头脑风暴可线上化（网站/SaaS）的商业机会，进行严谨评分与遴选，并产出一份投资人级别、数据公允、可溯源的结构化商业计划书。
要求：
1. 必须只输出一个 JSON 对象，不要任何额外文字或 Markdown。
2. opportunities 至少 5 个，每个含 name、description 及 scores（market/roi/onlineability/feasibility/speed/moat，取值 1-10 整数或一位小数）。
3. 所有财务与回报数据必须公允、符合国内同阶段同类创业的真实概率，区分"账面口径"与"风险调整/现金退出口径"，不得以账面存活冒充现金退出。
4. seedReturn 必须给出：bookRoiByYear（第1-5年账面ROI，百分比数字数组）、annualizedBook（年化）、winRate（盈利现金退出的概率）、profitLossRatio（盈亏比）、expectedValueMOIC（期望收益倍数EV）、riskAdjustedAnnualized（风险调整年化）、notes（口径说明）。`;

function buildUserPrompt(trend: BpTrendSnapshot): string {
  return `谷歌热搜第一名关键词："${trend.keyword}"
分类：${trend.category || '未知'} | 搜索量：${trend.searchVolume} | 增长速度：${trend.growthRate} | 趋势窗口：${trend.timeRange} | 地区：${trend.region || '全球'}

请严格按以下 JSON 结构输出（字段名保持英文，文本内容用中文）：
{
  "title": "",
  "summary": "",
  "selectedOpportunity": "",
  "opportunities": [ { "name": "", "description": "", "scores": { "market": 0, "roi": 0, "onlineability": 0, "feasibility": 0, "speed": 0, "moat": 0 } } ],
  "market": { "tam": "", "sam": "", "som": "", "notes": "" },
  "businessModel": "",
  "financials": { "years": [ { "year": 1, "revenue": "", "ebitda": "" } ] },
  "seedReturn": { "bookRoiByYear": [0,0,0,0,0], "annualizedBook": "", "winRate": "", "profitLossRatio": "", "expectedValueMOIC": "", "riskAdjustedAnnualized": "", "notes": "" }
}`;
}

/** Reuse window: a completed BP for the same keyword within this many hours is reused. */
const REUSE_WINDOW_HOURS = 24;

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

  /** Return a recent completed report for this keyword, if any (dedupe). */
  async findReusable(keywordNorm: string): Promise<BpReport | null> {
    const row = await queryOne<any>(
      `SELECT * FROM bp_reports
       WHERE keyword_norm = $1 AND status = 'completed'
         AND created_at >= NOW() - make_interval(hours => $2)
       ORDER BY created_at DESC LIMIT 1`,
      [keywordNorm, REUSE_WINDOW_HOURS]
    );
    return row ? mapReportRow(row) : null;
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

      const updated = await queryOne<any>(
        `UPDATE bp_reports SET
          status = 'completed',
          title = $2,
          summary = $3,
          selected_opportunity = $4,
          content_json = $5,
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
          llm.model,
          llm.tokensUsed ?? null,
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
    const oppRows = await query<any>(
      `SELECT * FROM bp_opportunities WHERE report_id = $1 ORDER BY rank ASC`,
      [id]
    );
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
    return { success: true, data: report };
  }

  /** Paginated list of reports (without the large content JSON). */
  async list(page = 1, pageSize = 20): Promise<Result<PaginatedBpReports, BpError>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const offset = (safePage - 1) * safeSize;

    const countRow = await queryOne<{ total: string }>(`SELECT COUNT(*) as total FROM bp_reports`);
    const totalItems = parseInt(countRow?.total || '0', 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));

    const rows = await query<any>(
      `SELECT id, keyword, title, status, selected_opportunity, created_at
       FROM bp_reports ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [safeSize, offset]
    );

    const reports: BpReportListItem[] = rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      title: r.title ?? undefined,
      status: r.status,
      selectedOpportunity: r.selected_opportunity ?? undefined,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));

    return {
      success: true,
      data: { reports, pagination: { currentPage: safePage, totalPages, totalItems, pageSize: safeSize } },
    };
  }
}

export const bpService = new BpService();
