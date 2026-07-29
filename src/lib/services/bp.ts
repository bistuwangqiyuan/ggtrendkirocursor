import { query, queryOne, pool, getClient } from '../db/client';
import { trendsService } from './trends';
import { generateJson, isLlmConfigured, LlmError } from './llm';
import {
  classifyTrendTopic,
  commercialIntentScore,
  isAnalyzableTopic,
  parseTopicClass,
} from './trendTriage';
import { getTrendsFromSnapshot } from '../cache/snapshotReaders';
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

/** A canonical completed report, keyed by business model, for in-memory dedupe. */
export interface CanonicalBusinessModel {
  id: string;
  businessModelNorm: string;
  title: string | null;
  summary: string | null;
  selectedOpportunity: string | null;
}

/** One finished generation, ready to be inserted in its final state. */
export interface BatchResultInput {
  snapshot: BpTrendSnapshot;
  status: 'completed' | 'failed';
  title?: string | null;
  summary?: string | null;
  selectedOpportunity?: string | null;
  contentJson?: BpContent | null;
  businessModelNorm?: string | null;
  /** Set when this plan duplicates an existing business model. */
  canonicalReportId?: string | null;
  model?: string | null;
  tokensUsed?: number | null;
  error?: string | null;
  userId?: string | null;
  opportunities?: BpOpportunity[];
}

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

/** Whitelisted status filter values for the report list. */
export const BP_REPORT_STATUSES = ['pending', 'generating', 'completed', 'failed'] as const;
export type BpReportStatus = (typeof BP_REPORT_STATUSES)[number];

/** Parse an untrusted status query param; returns undefined when not whitelisted. */
export function parseBpStatusParam(raw: unknown): BpReportStatus | undefined {
  return BP_REPORT_STATUSES.includes(raw as BpReportStatus) ? (raw as BpReportStatus) : undefined;
}

/**
 * Parse a win-rate string into a {lo, hi, mid} percent range.
 * "约8%-12%" -> {lo:8, hi:12, mid:10}; "10%" -> {lo:10, hi:10, mid:10}.
 */
export function parseWinRateRange(s: unknown): { lo: number; hi: number; mid: number } | null {
  if (typeof s !== 'string') return null;
  const matches = s.match(/\d+(?:\.\d+)?/g);
  if (!matches) return null;
  const nums = matches.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return { lo, hi, mid: (lo + hi) / 2 };
}

/**
 * Deterministic seed-return recomputation from the raw inputs the LLM reports.
 * Declared basis (also stated in the appended note so results are reproducible
 * with scripts/verify_bp_math.py):
 *   book multiple M      = 1 + bookRoiByYear[4] / 100      (year-5 cumulative book ROI)
 *   annualized book      = M^(1/5) - 1                     (point value, unambiguous)
 *   EV MOIC interval     = [p*M, p*M + (1-p)]              (p = mid win rate as cash-exit
 *                            probability; lower bound assumes total loss on the losing
 *                            branch, upper bound assumes principal is recovered)
 *   risk-adj. annualized = [EV_lo^(1/5)-1, EV_hi^(1/5)-1]  (annualizing the EV interval)
 * The interval form encodes the genuine ambiguity in loss-recovery assumptions
 * instead of pretending a single convention is the truth.
 * Pure; returns null when required inputs are missing/unparsable.
 */
export function recomputeSeedReturn(seed: {
  bookRoiByYear: number[];
  winRate: unknown;
}): {
  bookMultiple: number;
  annualizedBookPct: number;
  winRateMidPct: number;
  evMoicLo: number;
  evMoicHi: number;
  riskAdjustedAnnualizedLoPct: number;
  riskAdjustedAnnualizedHiPct: number;
} | null {
  if (!Array.isArray(seed.bookRoiByYear) || seed.bookRoiByYear.length < 5) return null;
  const roi5 = Number(seed.bookRoiByYear[4]);
  if (!Number.isFinite(roi5)) return null;
  const range = parseWinRateRange(seed.winRate);
  if (!range) return null;

  const bookMultiple = 1 + roi5 / 100;
  if (bookMultiple <= 0) return null;
  const annualizedBookPct = (Math.pow(bookMultiple, 1 / 5) - 1) * 100;
  const p = range.mid / 100;
  const evMoicLo = p * bookMultiple;
  const evMoicHi = p * bookMultiple + (1 - p);
  const annualizePct = (ev: number) => (ev > 0 ? (Math.pow(ev, 1 / 5) - 1) * 100 : -100);

  return {
    bookMultiple: round2(bookMultiple),
    annualizedBookPct: round2(annualizedBookPct),
    winRateMidPct: round2(range.mid),
    evMoicLo: round2(evMoicLo),
    evMoicHi: round2(evMoicHi),
    riskAdjustedAnnualizedLoPct: round2(annualizePct(evMoicLo)),
    riskAdjustedAnnualizedHiPct: round2(annualizePct(evMoicHi)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Slack applied before flagging: point-value tolerance for annualized book
 * (percentage points) and margins added around the EV / risk-adjusted
 * intervals (MOIC units / percentage points).
 */
export const SEED_RECOMPUTE_TOLERANCE = { annualizedPct: 5, moic: 0.1, riskAdjustedPct: 2 };

/**
 * Compare the LLM's self-reported seed metrics against the deterministic
 * recomputation and, when they fall outside the recomputed value/interval
 * (plus tolerance), build a calibration note stating the formulas and both
 * sets of numbers. Returns '' when the numbers agree (or can't be recomputed).
 * Pure.
 */
export function buildSeedCalibrationNote(seed: {
  bookRoiByYear: number[];
  annualizedBook: unknown;
  winRate: unknown;
  expectedValueMOIC: unknown;
  riskAdjustedAnnualized: unknown;
}): string {
  const rc = recomputeSeedReturn(seed);
  if (!rc) return '';

  const reportedAnnualized = parseSignedPercent(String(seed.annualizedBook ?? ''));
  const reportedMoic = parseSignedPercent(String(seed.expectedValueMOIC ?? ''));
  const reportedRiskAdj = parseSignedPercent(String(seed.riskAdjustedAnnualized ?? ''));

  const issues: string[] = [];
  if (reportedAnnualized !== null && Math.abs(reportedAnnualized - rc.annualizedBookPct) > SEED_RECOMPUTE_TOLERANCE.annualizedPct) {
    issues.push(`账面年化自报 ${reportedAnnualized}%、按第5年账面ROI复算为 ${rc.annualizedBookPct}%（公式 (1+ROI5/100)^(1/5)-1，ROI5=${seed.bookRoiByYear[4]}%）`);
  }
  if (
    reportedMoic !== null &&
    (reportedMoic < rc.evMoicLo - SEED_RECOMPUTE_TOLERANCE.moic || reportedMoic > rc.evMoicHi + SEED_RECOMPUTE_TOLERANCE.moic)
  ) {
    issues.push(`期望收益倍数自报 ${reportedMoic}x、按胜率中值复算应落在 ${rc.evMoicLo}x（亏损归零）~ ${rc.evMoicHi}x（亏损保本）区间（p=${rc.winRateMidPct}%，M=${rc.bookMultiple}x）`);
  }
  if (
    reportedRiskAdj !== null &&
    (reportedRiskAdj < rc.riskAdjustedAnnualizedLoPct - SEED_RECOMPUTE_TOLERANCE.riskAdjustedPct ||
      reportedRiskAdj > rc.riskAdjustedAnnualizedHiPct + SEED_RECOMPUTE_TOLERANCE.riskAdjustedPct)
  ) {
    issues.push(`风险调整年化自报 ${reportedRiskAdj}%、按 EV^(1/5)-1 复算应落在 ${rc.riskAdjustedAnnualizedLoPct}% ~ ${rc.riskAdjustedAnnualizedHiPct}% 区间`);
  }

  if (issues.length === 0) return '';
  return `【复算校准】服务器按确定性公式独立复算（口径：M=1+第5年账面ROI/100；年化=M^(1/5)-1；EV区间=[p×M, p×M+(1-p)]（下界亏损归零、上界亏损保本）；风险调整年化=EV^(1/5)-1；可用 scripts/verify_bp_math.py 复现）：${issues.join('；')}。两组数值不一致时应以复算口径审慎解读。`;
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

  // Deterministic recomputation guardrail: when the model's self-reported
  // metrics disagree with the declared formulas beyond tolerance, append a
  // calibration note stating both sets of numbers (reproducible via
  // scripts/verify_bp_math.py). Never hard-fails generation.
  const calibration = buildSeedCalibrationNote({
    bookRoiByYear: seed.bookRoiByYear.slice(0, 5).map((n: any) => Number(n) || 0),
    annualizedBook: seed.annualizedBook,
    winRate: seed.winRate,
    expectedValueMOIC: seed.expectedValueMOIC,
    riskAdjustedAnnualized: seed.riskAdjustedAnnualized,
  });
  if (calibration) {
    seedNotes = seedNotes ? `${seedNotes} ${calibration}` : calibration;
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

export function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Max length of a normalized business model, matching the DB column
 * (bp_reports.business_model_norm varchar(300)). Reasoning-tier models return
 * multi-paragraph businessModel prose; without this cap the UPDATE fails with
 * "value too long for type character varying(300)" and the whole generation is
 * lost AFTER the LLM tokens were spent.
 */
export const BUSINESS_MODEL_NORM_MAX_LENGTH = 300;

/**
 * Normalize a free-text business model for dedup comparison: lowercase, collapse
 * whitespace, strip leading/trailing punctuation, and cap at the DB column
 * length. Two plans whose normalized business models are equal are treated as
 * the same model (a 300-char prefix is more than distinctive enough for dedup).
 */
export function normalizeBusinessModel(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim()
    .slice(0, BUSINESS_MODEL_NORM_MAX_LENGTH);
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

export const SYSTEM_PROMPT = `你是资深早期风投分析师与连续创业者。基于给定"谷歌热搜关键词"，头脑风暴**可完全线上化（纯网站/SaaS，无线下重资产）**的商业机会，严谨评分并遴选其中**ROI 最高且可完全线上化**者，产出投资人级、数据公允、可溯源、可执行的结构化商业计划书。

【输出】仅输出一个 JSON 对象，无任何额外文字或 Markdown 代码块；字段名用英文，内容用中文。

【机会与评分】opportunities ≥5 个，各含 name、description、scores(market/roi/onlineability/feasibility/speed/moat，取值1-10，可一位小数)。description 须具体到产品形态、目标用户、获客与变现方式，忌空话。优先可完全线上化且高 ROI 者；selectedOpportunity 取综合最优（服务器会按固定权重复算校正，请如实评分）。

【全 AI 无人公司（核心硬约束）】所选机会必须是可由"全 AI 自动化运营的无人公司"承载的在线服务：内容生产、获客/投放、转化、客服、交付、计费、风控等关键环节尽可能由 AI 与自动化流程闭环完成，人工参与趋近于零（理想为 0，至多保留极少数合规/监督角色）。须在 onlineability 与 feasibility 评分中**显式体现自动化/无人化程度**（越无人、越自动得分越高）；selectedOpportunity 与 businessModel 必须逐环节说明"如何无人化"（用什么 AI/自动化能力实现各环节），并据此给出"近零边际人力成本"的成本结构与单位经济模型。务必合法合规、符合社会公序良俗与平台政策，绝不依赖灰产、欺诈或违规自动化。

【公允数据·反乐观谬误（极重要）】财务与回报须实事求是、贴合国内（中国）同阶段同类创业真实基准，严禁乐观谬误。锚点（供推理，结合本机会调整并给依据，勿照抄）：① 早期/种子阶段绝大多数最终回报为0或亏损，进入A轮比例约10-20%；② 以"真实现金退出"（并购/老股转让/IPO 且形成真实流动性）口径，种子轮单笔5年内盈利现金退出概率通常仅个位数至约10-15%，不得以"账面存活/纸面估值"冒充现金退出；③ 早期VC回报呈幂律——胜率低但盈亏比高，单项目种子轮期望收益倍数(EV/MOIC)通常约1.0-2.5x（已计入大概率归零）。须严格区分账面口径(book，偏乐观，仅参考)与风险调整/现金退出口径(cash-exit，已乘真实拿到钱概率，为决策依据)，二者不得混用；winRate 必须是"盈利现金退出"概率，不得用存活率冒充。

【种子轮回报指标】seedReturn 须给出：bookRoiByYear(第1-5年账面ROI，5个百分比数字)、annualizedBook(账面年化)、winRate(盈利现金退出概率，如"约8%-12%")、profitLossRatio(盈亏比，如"约6:1")、expectedValueMOIC(已计归零概率的期望收益倍数，如"约1.4x")、riskAdjustedAnnualized(风险调整年化，通常远低于账面年化)、notes(口径与计算依据)。所有关键财务/回报数据须**有理有据或给出可复算口径**：在 notes 与 market.notes 中写明关键公式与取值（如获客成本 CAC、转化率、客单价 ARPU、毛利率、回收期、年化与风险调整年化的折算方式），使其可用 Python 独立复算验证；无人化口径下人力成本应按近零计入。

【执行摘要含回报数字】summary 正文须用文字写明种子轮第1/2/3/4/5年ROI、年化、胜率(盈利现金退出)、盈亏比，并强调为"成功现金退出"口径而非账面存活；并点明选定机会、市场空间与可执行关键路径。`;

/**
 * Build the optional "avoid these recent business models" instruction line.
 * Pure + exported for unit testing. Caps the list to keep input tokens low.
 */
export function buildAvoidModelsLine(models: string[], max = 20): string {
  const cleaned = [...new Set(models.map((m) => (m || '').trim()).filter(Boolean))].slice(0, max);
  if (cleaned.length === 0) return '';
  return `请避免与以下近期已生成的商业模式实质重复（务必另辟差异化新方向）：${cleaned.join('；')}。`;
}

export function buildUserPrompt(trend: BpTrendSnapshot, avoidLine = ''): string {
  const avoid = avoidLine ? `\n${avoidLine}\n` : '';
  return `谷歌热搜第一名关键词："${trend.keyword}"
分类：${trend.category || '未知'} | 搜索量：${trend.searchVolume} | 增长速度：${trend.growthRate} | 趋势窗口：${trend.timeRange} | 地区：${trend.region || '全球'}
${avoid}
基于该关键词头脑风暴可完全线上化（纯网站/SaaS）的机会，遴选 ROI 最高者，产出公允可执行的计划书；概率与收益须贴合国内同阶段真实基准、避免乐观谬误。
**核心要求：所选机会必须是全 AI 自动化运营的"无人公司"模式（各关键环节近零人工）**，并在 businessModel 与 summary 中清楚说明各环节的无人化实现路径与近零人力成本结构；关键财务参数须可复算（注明公式与取值，便于用 Python 验证）；须合法合规、符合社会公序良俗。
严格按以下 JSON 结构输出（字段名英文，内容中文）：
{
  "title": "",
  "summary": "（执行摘要：含选定机会、市场空间、关键可执行路径；并明确写出种子轮第1-5年ROI、年化、胜率(现金退出)、盈亏比）",
  "selectedOpportunity": "",
  "opportunities": [ { "name": "", "description": "", "scores": { "market": 0, "roi": 0, "onlineability": 0, "feasibility": 0, "speed": 0, "moat": 0 } } ],
  "market": { "tam": "", "sam": "", "som": "", "notes": "（注明 CAC/转化率/ARPU/毛利率/回收期等关键参数与公式，便于 Python 复算）" },
  "businessModel": "（无人化运营：逐环节说明内容/获客/转化/客服/交付/计费/风控如何由 AI 自动化闭环、近零人力成本结构）",
  "financials": { "years": [ { "year": 1, "revenue": "", "ebitda": "" } ] },
  "seedReturn": { "bookRoiByYear": [0,0,0,0,0], "annualizedBook": "", "winRate": "", "profitLossRatio": "", "expectedValueMOIC": "", "riskAdjustedAnnualized": "", "notes": "" }
}`;
}

/**
 * Deduplication is all-history: a keyword is treated as "already done" if it
 * has a completed BP anywhere in the analysis record, so each hotword is
 * analyzed at most once. The same rule bounds the manual reuse path and the
 * business-model dedup.
 */

/**
 * Pure helper: build the set of keyword_norms that have a completed BP.
 * Used by the cron skip-set so the all-history dedupe rule is unit-testable
 * independently of the database.
 */
export function completedKeywordNormSet(
  rows: { keywordNorm: string }[]
): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.keywordNorm) set.add(r.keywordNorm);
  }
  return set;
}

/** Failure circuit breaker: skip keywords that failed at least this many times... */
export const FAILURE_SKIP_MIN_COUNT = 2;
/** ...within this window (hours). Keeps one bad keyword from wedging the picker. */
export const FAILURE_SKIP_WINDOW_HOURS = 24;

/**
 * Pure helper: keyword_norms with >= `minCount` failed reports within
 * `windowHours` of `now`. These are circuit-broken out of the picker so a
 * keyword that keeps failing (LLM timeouts, bad content) can't be re-picked
 * forever while eligible keywords starve behind it.
 */
export function failedKeywordNormSet(
  rows: { keywordNorm: string; createdAt: Date }[],
  now: Date,
  windowHours = FAILURE_SKIP_WINDOW_HOURS,
  minCount = FAILURE_SKIP_MIN_COUNT
): Set<string> {
  const windowMs = windowHours * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.keywordNorm) continue;
    const age = now.getTime() - r.createdAt.getTime();
    if (!Number.isFinite(age) || age < 0 || age > windowMs) continue;
    counts.set(r.keywordNorm, (counts.get(r.keywordNorm) ?? 0) + 1);
  }
  const set = new Set<string>();
  for (const [norm, count] of counts) {
    if (count >= minCount) set.add(norm);
  }
  return set;
}

/** Minimum composite hotword score (0-100) for scheduled BP generation. */
export const MIN_TREND_SCORE = 60;

const SCHEDULED_SCAN_PAGE_SIZE = 50;
const SCHEDULED_SCAN_MAX_PAGES = 5;

/**
 * LLM timeout for generation triggered from SYNCHRONOUS Netlify functions
 * (26s hard budget). Tight enough that a slow LLM fails inside the function,
 * gets its real error recorded on the report, and leaves budget for the DB
 * writes — instead of the function being killed with the row stuck at
 * 'generating'. Background functions (15-min budget) use the full default.
 */
export const SYNC_LLM_TIMEOUT_MS = 18_000;

/**
 * Scheduled picker only considers trends COLLECTED within this window. This
 * mechanically disqualifies stale one-off seed rows (fabricated multi-million
 * search volumes from 2026-06-05) that would otherwise outrank every real
 * RSS-collected hotword forever. Non-destructive: old rows stay in the table,
 * they just can't be picked.
 */
export const SCHEDULED_FRESHNESS_WINDOW: '48h' = '48h';

/** Composite 0-100 score: 50% growth_rate (%) + 50% log-normalized search volume. */
export function computeTrendHotwordScore(t: { searchVolume: number; growthRate: number }): number {
  const growthPart = Math.min(100, Math.max(0, t.growthRate));
  const volumePart = Math.min(100, (Math.log10(Math.max(1, t.searchVolume)) / 6) * 100);
  return Math.round(growthPart * 0.5 + volumePart * 0.5);
}

/**
 * Whether a hotword is worth analysing, on topic grounds.
 *
 * Rows collected since triage shipped carry a stored classification made with
 * the news context, which is far more accurate than anything derivable later.
 * Older rows have none, so they are re-classified from the keyword alone — that
 * catches the explicit cases ("chiefs vs bills") and lets the ambiguous ones
 * through, which is the right way round: a wasted report costs one LLM call,
 * while wrongly rejecting one loses an opportunity silently.
 */
export function isAnalyzableTrend(trend: Pick<Trend, 'keyword' | 'topicClass'>): boolean {
  const stored = parseTopicClass(trend.topicClass);
  if (stored) return isAnalyzableTopic(stored);
  return isAnalyzableTopic(classifyTrendTopic({ keyword: trend.keyword }).topic);
}

/**
 * How much a clear commercial angle is worth when ordering candidates.
 *
 * Search volume answers "what is popular", but the site exists to answer "what
 * could be sold online". The bonus is capped at 15 points against a 0-100
 * hotword score, so it reorders comparable candidates without letting a faint
 * commercial hint promote a lukewarm keyword over a genuine breakout.
 */
export const COMMERCIAL_INTENT_WEIGHT = 0.15;

export function rankTrendForAnalysis(
  trend: Pick<Trend, 'keyword' | 'searchVolume' | 'growthRate'>
): number {
  return (
    computeTrendHotwordScore(trend) +
    commercialIntentScore(trend.keyword) * COMMERCIAL_INTENT_WEIGHT
  );
}

/**
 * Order candidates by analysis value while remembering where each one stood in
 * the incoming search-volume order — reports record that position as the
 * hotword's rank, so re-sorting must not silently redefine it.
 */
export function orderTrendsForAnalysis(trends: Trend[], startRank = 1): { trend: Trend; rank: number }[] {
  return trends
    .map((trend, i) => ({ trend, rank: startRank + i }))
    .sort((a, b) => rankTrendForAnalysis(b.trend) - rankTrendForAnalysis(a.trend));
}

/**
 * Pick the first trend that has no completed BP, clears the score threshold,
 * and is not sport or entertainment. Pure function for unit testing.
 *
 * "First" is relative to the order it is given: callers that want the most
 * commercially promising candidate pass the list through
 * `orderTrendsForAnalysis` first.
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
    // Sport and celebrity hotwords yield near-identical plans, so they are
    // classified out here rather than after the LLM has been paid for.
    if (!isAnalyzableTrend(trend)) {
      rank++;
      continue;
    }
    return { trend, trendScore, rank };
  }
  return null;
}

/**
 * Build the parameterized multi-row INSERT for a report's opportunities.
 *
 * NOTE: table is bp_report_opportunities, NOT bp_opportunities. The shared Neon
 * database also hosts a sibling app whose sync job periodically drops &
 * recreates `bp_opportunities` with an incompatible legacy schema (plan_id /
 * scores jsonb, observed 2026-07-13); writing to a table that app owns caused
 * every generation to fail after its resync. Our own table name keeps the two
 * apps from clobbering each other.
 */
function buildOpportunitiesInsert(
  reportId: string,
  opps: BpOpportunity[]
): { sql: string; params: any[] } | null {
  if (!opps.length) return null;
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
  return {
    sql: `INSERT INTO bp_report_opportunities
        (report_id, name, description, score_market, score_roi, score_onlineability, score_feasibility, score_speed, score_moat, weighted_score, is_selected, rank, created_at)
       VALUES ${valuesSql.join(',')}`,
    params,
  };
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
  /**
   * Ops diagnostic (no generation): report how the scheduled picker sees the
   * world right now — the size of the all-history completed skip-set, what it
   * would pick, and whether that pick is (incorrectly) already in the skip-set.
   */
  async debugPickDiagnostics(timeRange = '4h'): Promise<{
    completedCount: number;
    failedSkipCount: number;
    picked: { keyword: string; norm: string; trendScore: number; inSkipSet: boolean; reusableId: string | null } | null;
    sampleNorms: string[];
  }> {
    const completed = await this.getRecentlyCompletedKeywordNorms();
    const failedSkip = await this.getRecentlyFailedKeywordNorms();
    const picked = await this.pickNextUngeneratedTrend(timeRange);
    let pickedInfo: any = null;
    if (picked) {
      const norm = normalizeKeyword(picked.snapshot.keyword);
      const reusable = await this.findReusable(norm);
      pickedInfo = {
        keyword: picked.snapshot.keyword,
        norm,
        trendScore: picked.trendScore,
        inSkipSet: completed.has(norm),
        reusableId: reusable ? reusable.id : null,
      };
    }
    return {
      completedCount: completed.size,
      failedSkipCount: failedSkip.size,
      picked: pickedInfo,
      sampleNorms: [...completed].slice(0, 8),
    };
  }

  /** Resolve the source trend: exact trendId if given, else keyword/#1 by search volume. */
  async resolveSourceTrend(input: GenerateBpInput): Promise<BpTrendSnapshot | null> {
    const timeRange = input.timeRange || '4h';

    // Prefer the exact trend the scheduler picked. A fuzzy keyword search can
    // "upgrade" to a higher-volume substring match (e.g. "netflix" ->
    // "netflix series (4h)"), which may already have a recent BP and cause an
    // unintended same-keyword reuse loop. Honour the explicit id when present.
    if (input.trendId) {
      const byId = await trendsService.getTrendById(input.trendId);
      if (byId) {
        return {
          sourceTrendId: byId.id,
          keyword: byId.keyword,
          searchVolume: byId.searchVolume,
          growthRate: byId.growthRate,
          category: byId.category,
          timeRange: byId.timeRange || timeRange,
          region: byId.region || '',
          rank: 1,
        };
      }
    }

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

  /** Whether a completed BP exists for this keyword (anywhere in history). */
  async hasCompletedBp(keywordNorm: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM bp_reports
         WHERE keyword_norm = $1 AND status = 'completed'
       ) AS exists`,
      [keywordNorm]
    );
    return !!row?.exists;
  }

  /**
   * Keyword_norm values with a completed BP anywhere in history. Dedupe is
   * all-history so each hotword gets exactly one analysis; the picker always
   * advances to genuinely-new keywords instead of refreshing old ones.
   */
  async getRecentlyCompletedKeywordNorms(): Promise<Set<string>> {
    const rows = await query<{ keyword_norm: string }>(
      `SELECT DISTINCT keyword_norm FROM bp_reports
       WHERE status = 'completed' AND keyword_norm IS NOT NULL`
    );
    const set = new Set<string>();
    for (const r of rows) if (r.keyword_norm) set.add(r.keyword_norm);
    return set;
  }

  /**
   * Which of `norms` already have a completed plan. Used as a last check before
   * inserting work that was selected from the cached dedupe state (during a
   * database outage) or buffered by an earlier run: those decisions were made
   * against a snapshot of the past, and this is the live answer.
   *
   * Asks only about the handful of keywords in hand, unlike the all-history set
   * the prepare phase pulls.
   */
  async getCompletedKeywordNormsAmong(norms: string[]): Promise<Set<string>> {
    const wanted = [...new Set(norms.filter(Boolean))];
    if (wanted.length === 0) return new Set();
    const rows = await query<{ keyword_norm: string }>(
      `SELECT DISTINCT keyword_norm FROM bp_reports
       WHERE status = 'completed' AND keyword_norm = ANY($1::text[])`,
      [wanted]
    );
    return new Set(rows.map((r) => r.keyword_norm).filter(Boolean));
  }

  /**
   * Circuit-broken keywords: keyword_norms with >= FAILURE_SKIP_MIN_COUNT failed
   * reports in the last FAILURE_SKIP_WINDOW_HOURS. The picker skips these so one
   * keyword that keeps failing (e.g. LLM timeouts) can't wedge the pipeline into
   * an infinite retry loop while fresh keywords starve behind it.
   */
  async getRecentlyFailedKeywordNorms(
    windowHours = FAILURE_SKIP_WINDOW_HOURS,
    minCount = FAILURE_SKIP_MIN_COUNT
  ): Promise<Set<string>> {
    const rows = await query<{ keyword_norm: string }>(
      `SELECT keyword_norm FROM bp_reports
       WHERE status = 'failed' AND keyword_norm IS NOT NULL
         AND created_at >= NOW() - make_interval(hours => $1)
       GROUP BY keyword_norm
       HAVING COUNT(*) >= $2`,
      [windowHours, minCount]
    );
    const set = new Set<string>();
    for (const r of rows) if (r.keyword_norm) set.add(r.keyword_norm);
    return set;
  }

  /**
   * Walk trends by search_volume desc; return the first whose composite score
   * exceeds MIN_TREND_SCORE and which has no completed BP anywhere in history
   * (all-history dedupe: each hotword is analyzed at most once).
   *
   * Only trends COLLECTED within SCHEDULED_FRESHNESS_WINDOW are scanned, and
   * keywords that recently failed repeatedly are circuit-broken out.
   */
  async pickNextUngeneratedTrend(
    timeRange = '4h'
  ): Promise<{ snapshot: BpTrendSnapshot; trendScore: number } | null> {
    const [completed, recentlyFailed] = await Promise.all([
      this.getRecentlyCompletedKeywordNorms(),
      this.getRecentlyFailedKeywordNorms(),
    ]);
    const skip = new Set<string>([...completed, ...recentlyFailed]);
    let globalRank = 0;
    let effectiveTimeRange: string | undefined = timeRange;

    for (let page = 1; page <= SCHEDULED_SCAN_MAX_PAGES; page++) {
      const res = await trendsService.getTrends({
        timeRange: effectiveTimeRange,
        collectedWithin: SCHEDULED_FRESHNESS_WINDOW,
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

      const picked = pickFirstEligibleTrend(res.data.trends, skip, MIN_TREND_SCORE, globalRank + 1);
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
   * Pick up to `count` eligible hotwords in one pass.
   *
   * Candidates come from the trends SNAPSHOT when one exists, which is the whole
   * point: the batch's collector phase refreshes that snapshot moments earlier in
   * the same wake window, so selecting a full batch of candidates costs zero
   * database queries instead of one paged scan per BP.
   *
   * `skip` is supplied by the caller (fetched once per batch) and is extended
   * in-place as candidates are chosen, so the same keyword is never picked twice.
   */
  async pickEligibleTrendCandidates(
    count: number,
    skip: Set<string>,
    timeRange = '4h',
    options: {
      /**
       * Hotwords not in the snapshot yet — currently the intake queue, whose rows
       * were harvested while the database was unavailable. Including them is what
       * lets a degraded run analyze the very keywords the outage would have cost.
       */
      extraTrends?: Trend[];
      /** Set false when the database is known to be down, so no scan is attempted. */
      allowDbScan?: boolean;
    } = {}
  ): Promise<{ snapshot: BpTrendSnapshot; trendScore: number }[]> {
    const picks: { snapshot: BpTrendSnapshot; trendScore: number }[] = [];
    if (count <= 0) return picks;
    const allowDbScan = options.allowDbScan !== false;

    const snapshotRead = await getTrendsFromSnapshot({
      timeRange,
      collectedWithin: SCHEDULED_FRESHNESS_WINDOW,
      sortBy: 'search_volume',
      sortOrder: 'desc',
      page: 1,
      pageSize: SCHEDULED_SCAN_PAGE_SIZE * SCHEDULED_SCAN_MAX_PAGES,
    });

    let trends: Trend[] = snapshotRead.hit ? snapshotRead.data.trends : [];

    // An empty result for the requested window means that bucket wasn't
    // collected; widen rather than report "no eligible trend".
    if (snapshotRead.hit && trends.length === 0) {
      const relaxed = await getTrendsFromSnapshot({
        collectedWithin: SCHEDULED_FRESHNESS_WINDOW,
        sortBy: 'search_volume',
        sortOrder: 'desc',
        page: 1,
        pageSize: SCHEDULED_SCAN_PAGE_SIZE * SCHEDULED_SCAN_MAX_PAGES,
      });
      trends = relaxed.data.trends;
    }

    if (!snapshotRead.hit && allowDbScan) {
      // No snapshot yet (fresh deploy): fall back to the paged DB scan.
      for (let page = 1; page <= SCHEDULED_SCAN_MAX_PAGES && picks.length < count; page++) {
        const res = await trendsService.getTrends({
          timeRange,
          collectedWithin: SCHEDULED_FRESHNESS_WINDOW,
          sortBy: 'search_volume',
          sortOrder: 'desc',
          page,
          pageSize: SCHEDULED_SCAN_PAGE_SIZE,
        });
        if (!res.success || res.data.trends.length === 0) break;
        trends.push(...res.data.trends);
        if (res.data.pagination.currentPage >= res.data.pagination.totalPages) break;
      }
    }

    if (options.extraTrends?.length) {
      const known = new Set(trends.map((t) => normalizeKeyword(t.keyword)));
      for (const trend of options.extraTrends) {
        if (known.has(normalizeKeyword(trend.keyword))) continue;
        known.add(normalizeKeyword(trend.keyword));
        trends.push(trend);
      }
    }

    // Reorder by analysis value before selecting. When the batch size is
    // smaller than the eligible pool — the normal case — this decides which
    // opportunities get the LLM budget, so the ones that read like a buildable
    // online service go first. Each entry keeps its search-volume position.
    const ordered = orderTrendsForAnalysis(trends);
    for (const { trend, rank } of ordered) {
      if (picks.length >= count) break;
      const picked = pickFirstEligibleTrend([trend], skip, MIN_TREND_SCORE, rank);
      if (!picked) continue;
      skip.add(normalizeKeyword(trend.keyword));
      picks.push({
        trendScore: picked.trendScore,
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
      });
    }

    return picks;
  }

  /**
   * Every canonical completed report keyed by business-model norm, in one query.
   * Lets the batch resolve business-model dedupe entirely in memory instead of
   * querying once per generated plan.
   */
  async listCanonicalBusinessModels(): Promise<Map<string, CanonicalBusinessModel>> {
    const rows = await query<any>(
      `SELECT DISTINCT ON (business_model_norm)
              business_model_norm, id, title, summary, selected_opportunity
       FROM bp_reports
       WHERE status = 'completed'
         AND canonical_report_id IS NULL
         AND business_model_norm IS NOT NULL
         AND business_model_norm <> ''
       ORDER BY business_model_norm, created_at ASC`
    );
    const map = new Map<string, CanonicalBusinessModel>();
    for (const r of rows) {
      map.set(r.business_model_norm, {
        id: r.id,
        businessModelNorm: r.business_model_norm,
        title: r.title ?? null,
        summary: r.summary ?? null,
        selectedOpportunity: r.selected_opportunity ?? null,
      });
    }
    return map;
  }

  /**
   * Persist one batch of finished generations in a single transaction.
   *
   * Rows are inserted in their FINAL state (completed / failed) rather than as
   * placeholders updated later, so the LLM phase in between needs no database
   * access at all. Crash safety comes from the Blobs buffer the caller writes
   * after each generation, which the next run replays.
   */
  async insertBatchResults(items: BatchResultInput[]): Promise<{ inserted: number; reports: BpReport[] }> {
    if (items.length === 0) return { inserted: 0, reports: [] };
    const client = await getClient();
    const reports: BpReport[] = [];
    try {
      await client.query('BEGIN');
      for (const item of items) {
        const s = item.snapshot;
        const row = await client.query(
          `INSERT INTO bp_reports
            (keyword, keyword_norm, source_trend_id, search_volume, growth_rate, category, time_range, region, rank,
             status, title, summary, selected_opportunity, content_json, business_model_norm, canonical_report_id,
             model, tokens_used, error, user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING *`,
          [
            s.keyword,
            normalizeKeyword(s.keyword),
            s.sourceTrendId ?? null,
            s.searchVolume,
            s.growthRate,
            s.category,
            s.timeRange,
            s.region,
            s.rank,
            item.status,
            item.title ?? null,
            item.summary ?? null,
            item.selectedOpportunity ?? null,
            item.contentJson ? JSON.stringify(item.contentJson) : null,
            item.businessModelNorm ?? null,
            item.canonicalReportId ?? null,
            item.model ?? null,
            item.tokensUsed ?? null,
            item.error ?? null,
            item.userId ?? null,
          ]
        );
        const report = mapReportRow(row.rows[0]);
        if (item.opportunities && item.opportunities.length > 0) {
          await this.insertOpportunitiesWithClient(client, report.id, item.opportunities);
          report.opportunities = item.opportunities;
        }
        reports.push(report);
      }
      await client.query('COMMIT');
      return { inserted: reports.length, reports };
    } catch (error) {
      // All-or-nothing: a partial batch would leave reports without their
      // opportunity rows, which the detail page renders as an empty score matrix.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Find the earliest completed report (anywhere in history) whose business
   * model matches `bmNorm` (excluding `excludeId`). Only considers canonical
   * reports (those that are not themselves duplicates).
   */
  async findCompletedByBusinessModel(bmNorm: string, excludeId?: string): Promise<BpReport | null> {
    if (!bmNorm) return null;
    const row = await queryOne<any>(
      `SELECT * FROM bp_reports
       WHERE status = 'completed'
         AND business_model_norm = $1
         AND canonical_report_id IS NULL
         AND ($2::uuid IS NULL OR id <> $2::uuid)
       ORDER BY created_at ASC LIMIT 1`,
      [bmNorm, excludeId ?? null]
    );
    return row ? mapReportRow(row) : null;
  }

  /**
   * Most recently used distinct business-model norms (all history), used to
   * steer the LLM away from re-proposing models that already exist. Converting
   * would-be collisions into new content avoids wasting whole calls.
   */
  async getRecentBusinessModels(limit = 20): Promise<string[]> {
    const rows = await query<{ business_model_norm: string }>(
      `SELECT business_model_norm FROM (
         SELECT business_model_norm, MAX(created_at) AS last_used
         FROM bp_reports
         WHERE status = 'completed'
           AND business_model_norm IS NOT NULL AND business_model_norm <> ''
         GROUP BY business_model_norm
       ) t
       ORDER BY last_used DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.business_model_norm).filter(Boolean);
  }

  /** Return the latest completed report for this keyword (anywhere in history), if any. */
  async findReusable(keywordNorm: string): Promise<BpReport | null> {
    const row = await queryOne<any>(
      `SELECT * FROM bp_reports
       WHERE keyword_norm = $1 AND status = 'completed'
       ORDER BY created_at DESC LIMIT 1`,
      [keywordNorm]
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
   * (score > MIN_TREND_SCORE, no completed BP anywhere in history), then
   * generate one new BP. Each hotword is analyzed at most once.
   */
  async runScheduledGeneration(opts?: { llmTimeoutMs?: number }): Promise<
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
    }, opts);
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
  async generate(input: GenerateBpInput, opts?: { llmTimeoutMs?: number }): Promise<Result<BpReport, BpError>> {
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

    // Steer the model away from recently-used business models so collisions
    // (which would otherwise waste a full LLM call) become new library content.
    // Non-essential: if the lookup fails, proceed without the avoid-list rather
    // than leaving the placeholder stuck at 'generating'.
    const avoidModels = await this.getRecentBusinessModels().catch(() => [] as string[]);
    const avoidLine = buildAvoidModelsLine(avoidModels);

    try {
      const llm = await generateJson<any>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(trend, avoidLine),
        temperature: 0.7,
        maxTokens: 4000,
        deadlineMs: opts?.llmTimeoutMs,
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

  /** Same insert as insertOpportunities, but on a transaction client. */
  private async insertOpportunitiesWithClient(
    client: { query: (sql: string, params?: any[]) => Promise<any> },
    reportId: string,
    opps: BpOpportunity[]
  ): Promise<void> {
    const built = buildOpportunitiesInsert(reportId, opps);
    if (!built) return;
    await client.query(built.sql, built.params);
  }

  private async insertOpportunities(reportId: string, opps: BpOpportunity[]): Promise<void> {
    const built = buildOpportunitiesInsert(reportId, opps);
    if (!built) return;
    await query(built.sql, built.params);
  }

  /** Fetch a single report plus its ranked opportunities. */
  async getById(id: string): Promise<Result<BpReport, BpError>> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'BP 不存在' } };
    }
    try {
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
      `SELECT * FROM bp_report_opportunities WHERE report_id = $1 ORDER BY rank ASC`,
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
    } catch (error) {
      console.error('bpService.getById error:', (error as Error).message);
      return { success: false, error: { code: 'DB_ERROR', message: `无法读取 BP 详情: ${(error as Error).message}` } };
    }
  }

  /**
   * Paginated list of reports (without the large content JSON).
   * Exposes the risk-adjusted annualized return (resolved through
   * canonical_report_id for dedup pointers) and supports sorting by it.
   * `status` (whitelisted) optionally filters to one report status.
   */
  async list(
    page = 1,
    pageSize = 20,
    sortBy: BpListSortBy = 'createdAt',
    sortOrder: BpListSortOrder = 'desc',
    status?: BpReportStatus
  ): Promise<Result<PaginatedBpReports, BpError>> {
    try {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const offset = (safePage - 1) * safeSize;

    const statusFilter = status ? `WHERE r.status = $3` : '';
    const countRow = status
      ? await queryOne<{ total: string }>(`SELECT COUNT(*) as total FROM bp_reports r WHERE r.status = $1`, [status])
      : await queryOne<{ total: string }>(`SELECT COUNT(*) as total FROM bp_reports`);
    const totalItems = parseInt(countRow?.total || '0', 10);
    const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));

    const dir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    // Whitelist-built ORDER BY (no user input is interpolated directly).
    // Failed placeholder rows sort behind real reports so a burst of failures
    // can't bury the library's actual content (rows are kept for traceability).
    const failedLast = `CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END ASC`;
    const orderBy = sortBy === 'riskAdjusted'
      ? `${failedLast}, risk_adjusted_num ${dir} NULLS LAST, r.created_at DESC`
      : `${failedLast}, r.created_at ${dir}`;

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
       ${statusFilter}
       ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      status ? [safeSize, offset, status] : [safeSize, offset]
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
    } catch (error) {
      console.error('bpService.list error:', (error as Error).message);
      return { success: false, error: { code: 'DB_ERROR', message: '无法读取 BP 列表' } };
    }
  }
}

export const bpService = new BpService();
