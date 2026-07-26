import { describe, test, expect } from 'vitest';
import {
  SCORE_WEIGHTS,
  computeWeightedScore,
  validateAndNormalizeBpContent,
  BpValidationError,
  computeTrendHotwordScore,
  pickFirstEligibleTrend,
  orderTrendsForAnalysis,
  MIN_TREND_SCORE,
  normalizeBusinessModel,
  BUSINESS_MODEL_NORM_MAX_LENGTH,
  parseBpStatusParam,
  pickCanonicalByBusinessModel,
  parseWinRatePercent,
  parseSignedPercent,
  WIN_RATE_OPTIMISM_THRESHOLD,
  completedKeywordNormSet,
  failedKeywordNormSet,
  FAILURE_SKIP_MIN_COUNT,
  FAILURE_SKIP_WINDOW_HOURS,
  buildAvoidModelsLine,
  parseWinRateRange,
  recomputeSeedReturn,
  buildSeedCalibrationNote,
} from '../../src/lib/services/bp';
import type { Trend } from '../../src/types';
import { extractJsonObject } from '../../src/lib/services/llm';

const fullScores = (over: Partial<Record<string, number>> = {}) => ({
  market: 5, roi: 5, onlineability: 5, feasibility: 5, speed: 5, moat: 5, ...over,
});

function makeOpp(name: string, scores: any) {
  return { name, description: `${name} desc`, scores };
}

function validRaw() {
  return {
    title: 'Demo BP',
    summary: 'An executive summary.',
    selectedOpportunity: 'will-be-overwritten',
    opportunities: [
      makeOpp('A', fullScores({ roi: 9, market: 9 })),
      makeOpp('B', fullScores({ roi: 3 })),
      makeOpp('C', fullScores()),
      makeOpp('D', fullScores({ moat: 2 })),
      makeOpp('E', fullScores({ speed: 8 })),
    ],
    market: { tam: '10B', sam: '2B', som: '200M', notes: 'note' },
    businessModel: 'SaaS subscription',
    financials: { years: [{ year: 1, revenue: '1M', ebitda: '-0.2M' }] },
    seedReturn: {
      bookRoiByYear: [50, 140, 380, 495, 665],
      annualizedBook: '≈50%',
      winRate: '28%',
      profitLossRatio: '4.0:1',
      expectedValueMOIC: '1.37x',
      riskAdjustedAnnualized: '≈6.5%',
      notes: 'cash-exit basis',
    },
  };
}

describe('computeWeightedScore', () => {
  test('weights sum to 1', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100) / 100).toBe(1);
  });

  test('all-5 scores yield weighted 5', () => {
    expect(computeWeightedScore(fullScores() as any)).toBe(5);
  });

  test('roi has the highest weight (0.25)', () => {
    const highRoi = computeWeightedScore(fullScores({ roi: 10, market: 0 }) as any);
    const highMarket = computeWeightedScore(fullScores({ roi: 0, market: 10 }) as any);
    expect(highRoi).toBeGreaterThan(highMarket);
  });

  test('out-of-range scores are clamped', () => {
    expect(computeWeightedScore(fullScores({ roi: 999 }) as any)).toBeLessThanOrEqual(10);
  });
});

describe('validateAndNormalizeBpContent', () => {
  test('recomputes weighted scores and selects the top opportunity', () => {
    const content = validateAndNormalizeBpContent(validRaw());
    expect(content.opportunities).toHaveLength(5);
    expect(content.opportunities[0].isSelected).toBe(true);
    expect(content.opportunities[0].name).toBe('A'); // highest roi+market
    expect(content.selectedOpportunity).toBe('A');
    // ranks are sequential
    expect(content.opportunities.map((o) => o.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  test('throws when fewer than 5 opportunities', () => {
    const raw = validRaw();
    raw.opportunities = raw.opportunities.slice(0, 3);
    expect(() => validateAndNormalizeBpContent(raw)).toThrow(BpValidationError);
  });

  test('throws when an opportunity is missing a score dimension', () => {
    const raw = validRaw();
    delete (raw.opportunities[0].scores as any).moat;
    expect(() => validateAndNormalizeBpContent(raw)).toThrow(BpValidationError);
  });

  test('throws when seedReturn metrics are incomplete', () => {
    const raw = validRaw();
    (raw.seedReturn as any).winRate = '';
    expect(() => validateAndNormalizeBpContent(raw)).toThrow(BpValidationError);
  });

  test('throws when bookRoiByYear has fewer than 5 entries', () => {
    const raw = validRaw();
    raw.seedReturn.bookRoiByYear = [1, 2, 3];
    expect(() => validateAndNormalizeBpContent(raw)).toThrow(BpValidationError);
  });

  test('appends a calibration note for an optimistic win rate', () => {
    const raw = validRaw();
    (raw.seedReturn as any).winRate = '约 60%';
    const content = validateAndNormalizeBpContent(raw);
    expect(content.seedReturn.notes).toContain('风险校准');
  });

  test('does not flag a plausible cash-exit win rate', () => {
    const raw = validRaw();
    (raw.seedReturn as any).winRate = '约8%-12%';
    (raw.seedReturn as any).notes = 'cash-exit basis';
    const content = validateAndNormalizeBpContent(raw);
    expect(content.seedReturn.notes).toBe('cash-exit basis');
  });
});

describe('parseWinRatePercent', () => {
  test('returns the largest percentage in a range', () => {
    expect(parseWinRatePercent('约8%-12%')).toBe(12);
  });

  test('handles a single value and decimals', () => {
    expect(parseWinRatePercent('9.5%')).toBe(9.5);
  });

  test('returns null when no number present', () => {
    expect(parseWinRatePercent('未知')).toBeNull();
    expect(parseWinRatePercent(undefined)).toBeNull();
  });

  test('threshold is a sane percentage', () => {
    expect(WIN_RATE_OPTIMISM_THRESHOLD).toBeGreaterThan(0);
    expect(WIN_RATE_OPTIMISM_THRESHOLD).toBeLessThan(100);
  });
});

describe('buildAvoidModelsLine', () => {
  test('returns empty string when there are no models', () => {
    expect(buildAvoidModelsLine([])).toBe('');
    expect(buildAvoidModelsLine(['', '   '])).toBe('');
  });

  test('joins distinct trimmed models into one instruction line', () => {
    const line = buildAvoidModelsLine(['saas 订阅', ' saas 订阅 ', '内容平台']);
    expect(line).toContain('saas 订阅');
    expect(line).toContain('内容平台');
    // de-duplicated: the model appears once
    expect(line.match(/saas 订阅/g)?.length).toBe(1);
    expect(line.endsWith('。')).toBe(true);
  });

  test('caps the number of listed models', () => {
    const many = Array.from({ length: 50 }, (_, i) => `model${i}`);
    const line = buildAvoidModelsLine(many, 20);
    expect(line.includes('model19')).toBe(true);
    expect(line.includes('model20')).toBe(false);
  });
});

describe('parseSignedPercent (risk-adjusted annualized sorting)', () => {
  test('parses a positive percentage with prose around it', () => {
    expect(parseSignedPercent('约6.5%（中性情景）')).toBe(6.5);
  });

  test('keeps the negative sign', () => {
    expect(parseSignedPercent('-12%')).toBe(-12);
    expect(parseSignedPercent('约-8.5%')).toBe(-8.5);
  });

  test('takes the first number of a range', () => {
    expect(parseSignedPercent('5%-10%')).toBe(5);
  });

  test('returns null for non-numeric or non-string input', () => {
    expect(parseSignedPercent('未知')).toBeNull();
    expect(parseSignedPercent(undefined)).toBeNull();
    expect(parseSignedPercent(null)).toBeNull();
  });
});

function makeTrend(
  keyword: string,
  searchVolume: number,
  growthRate: number,
  id = 't1',
  topicClass: Trend['topicClass'] = 'general'
): Trend {
  return {
    id,
    keyword,
    searchVolume,
    growthRate,
    category: 'technology',
    timeRange: '4h',
    region: 'US',
    topicClass,
    timestamp: new Date(),
    createdAt: new Date(),
  };
}

describe('computeTrendHotwordScore', () => {
  test('returns 0 for zero growth and minimal volume', () => {
    expect(computeTrendHotwordScore({ searchVolume: 1, growthRate: 0 })).toBe(0);
  });

  test('clamps negative growth to 0 for growth component', () => {
    expect(computeTrendHotwordScore({ searchVolume: 1_000_000, growthRate: -50 })).toBe(50);
  });

  test('high growth and volume yield score near 100', () => {
    expect(computeTrendHotwordScore({ searchVolume: 1_000_000, growthRate: 100 })).toBe(100);
  });

  test('score exceeds MIN_TREND_SCORE when growth is strong', () => {
    const score = computeTrendHotwordScore({ searchVolume: 10_000, growthRate: 80 });
    expect(score).toBeGreaterThan(MIN_TREND_SCORE);
  });
});

describe('pickFirstEligibleTrend', () => {
  test('skips keywords with completed BP and picks next eligible', () => {
    const trends = [
      makeTrend('Alpha', 500_000, 90, '1'),
      makeTrend('Beta', 400_000, 85, '2'),
      makeTrend('Gamma', 300_000, 70, '3'),
    ];
    const completed = new Set(['alpha']); // #1 already has BP
    const picked = pickFirstEligibleTrend(trends, completed);
    expect(picked?.trend.keyword).toBe('Beta');
    expect(picked?.rank).toBe(2);
    expect(picked!.trendScore).toBeGreaterThan(MIN_TREND_SCORE);
  });

  test('skips trends below score threshold', () => {
    const trends = [
      makeTrend('Low', 10, 0, '1'),
      makeTrend('High', 200_000, 80, '2'),
    ];
    const picked = pickFirstEligibleTrend(trends, new Set());
    expect(picked?.trend.keyword).toBe('High');
    expect(picked?.rank).toBe(2);
  });

  test('returns null when no eligible trend exists', () => {
    const trends = [makeTrend('Done', 500_000, 90)];
    const picked = pickFirstEligibleTrend(trends, new Set(['done']));
    expect(picked).toBeNull();
  });

  test('skips a hotword the collector classified as sport', () => {
    const trends = [
      makeTrend('Chiefs Game', 900_000, 95, '1', 'sports'),
      makeTrend('Tax Filing Deadline', 300_000, 80, '2', 'general'),
    ];
    const picked = pickFirstEligibleTrend(trends, new Set());
    expect(picked?.trend.keyword).toBe('Tax Filing Deadline');
  });

  test('skips a hotword classified as entertainment', () => {
    const trends = [
      makeTrend('Some Actor', 900_000, 95, '1', 'entertainment'),
      makeTrend('Power Outage Map', 300_000, 80, '2', 'general'),
    ];
    expect(pickFirstEligibleTrend(trends, new Set())?.trend.keyword).toBe('Power Outage Map');
  });

  test('re-classifies an unclassified legacy row from its keyword', () => {
    // Rows collected before triage shipped carry no topic_class, so the obvious
    // cases still have to be caught at pick time.
    const trends = [
      makeTrend('chiefs vs bills', 900_000, 95, '1', null),
      makeTrend('Storm Warning', 300_000, 80, '2', null),
    ];
    expect(pickFirstEligibleTrend(trends, new Set())?.trend.keyword).toBe('Storm Warning');
  });

  test('keeps an ambiguous unclassified row eligible', () => {
    const trends = [makeTrend('Aurora Borealis', 300_000, 80, '1', null)];
    expect(pickFirstEligibleTrend(trends, new Set())?.trend.keyword).toBe('Aurora Borealis');
  });

  test('returns null when every candidate is sport or entertainment', () => {
    const trends = [
      makeTrend('Match Day', 900_000, 95, '1', 'sports'),
      makeTrend('Premiere Night', 800_000, 95, '2', 'entertainment'),
    ];
    expect(pickFirstEligibleTrend(trends, new Set())).toBeNull();
  });
});

describe('orderTrendsForAnalysis', () => {
  test('promotes a comparable keyword that names a buildable service', () => {
    const generic = makeTrend('Aurora Borealis', 300_000, 80, '1');
    const commercial = makeTrend('best tax software', 300_000, 80, '2');
    const ordered = orderTrendsForAnalysis([generic, commercial]);
    expect(ordered[0].trend.keyword).toBe('best tax software');
  });

  test('does not let a commercial hint outrank a much hotter keyword', () => {
    // The bonus caps at 15 points against a 0-100 hotword score, so a genuine
    // breakout still wins. Without that cap the ranking would chase wording.
    const breakout = makeTrend('Aurora Borealis', 5_000_000, 100, '1');
    const lukewarm = makeTrend('best tax software app online', 2_000, 62, '2');
    expect(orderTrendsForAnalysis([lukewarm, breakout])[0].trend.keyword).toBe('Aurora Borealis');
  });

  test('preserves each candidate position in the incoming order', () => {
    // rank is recorded on the report as the hotword's standing, so re-sorting
    // must not renumber it.
    const ordered = orderTrendsForAnalysis([
      makeTrend('Aurora Borealis', 300_000, 80, '1'),
      makeTrend('best tax software', 300_000, 80, '2'),
    ]);
    expect(ordered.find((o) => o.trend.id === '1')?.rank).toBe(1);
    expect(ordered.find((o) => o.trend.id === '2')?.rank).toBe(2);
  });
});

describe('normalizeBusinessModel', () => {
  test('lowercases, trims and collapses whitespace', () => {
    expect(normalizeBusinessModel('  SaaS   Subscription  ')).toBe('saas subscription');
  });

  test('strips surrounding punctuation but keeps inner characters', () => {
    expect(normalizeBusinessModel('“SaaS 订阅制”。')).toBe('saas 订阅制');
    expect(normalizeBusinessModel('B2B SaaS, freemium')).toBe('b2b saas, freemium');
  });

  test('treats equivalent models as equal after normalization', () => {
    expect(normalizeBusinessModel('SaaS 订阅')).toBe(normalizeBusinessModel('  saas   订阅 '));
  });

  test('returns empty string for non-strings or blank input', () => {
    expect(normalizeBusinessModel(undefined)).toBe('');
    expect(normalizeBusinessModel(null)).toBe('');
    expect(normalizeBusinessModel('   ')).toBe('');
  });

  test('caps output at the DB column length (varchar(300))', () => {
    // Reasoning-tier models emit multi-paragraph businessModel prose; an
    // uncapped norm broke the completed-report UPDATE in production
    // ("value too long for type character varying(300)", 2026-07-13).
    const long = '全AI无人化运营闭环。'.repeat(100);
    const norm = normalizeBusinessModel(long);
    expect(norm.length).toBeLessThanOrEqual(BUSINESS_MODEL_NORM_MAX_LENGTH);
    expect(norm.length).toBe(BUSINESS_MODEL_NORM_MAX_LENGTH);
  });

  test('equal long models still normalize equal after capping', () => {
    const long = 'x'.repeat(500);
    expect(normalizeBusinessModel(long)).toBe(normalizeBusinessModel(`  ${long}  `));
  });
});

describe('parseBpStatusParam', () => {
  test('accepts whitelisted statuses', () => {
    expect(parseBpStatusParam('completed')).toBe('completed');
    expect(parseBpStatusParam('failed')).toBe('failed');
    expect(parseBpStatusParam('generating')).toBe('generating');
    expect(parseBpStatusParam('pending')).toBe('pending');
  });

  test('rejects anything not whitelisted (SQL-injection-proof by construction)', () => {
    expect(parseBpStatusParam('COMPLETED')).toBeUndefined();
    expect(parseBpStatusParam("completed' OR 1=1 --")).toBeUndefined();
    expect(parseBpStatusParam('')).toBeUndefined();
    expect(parseBpStatusParam(null)).toBeUndefined();
    expect(parseBpStatusParam(undefined)).toBeUndefined();
  });
});

describe('pickCanonicalByBusinessModel', () => {
  const d = (ms: number) => new Date(2026, 0, 1, 0, 0, 0, ms);
  const candidates = [
    { id: 'b', businessModelNorm: 'saas subscription', createdAt: d(200) },
    { id: 'a', businessModelNorm: 'saas subscription', createdAt: d(100) },
    { id: 'c', businessModelNorm: 'marketplace', createdAt: d(50) },
  ];

  test('returns the earliest matching report id', () => {
    expect(pickCanonicalByBusinessModel('saas subscription', candidates)).toBe('a');
  });

  test('returns null when no business model matches', () => {
    expect(pickCanonicalByBusinessModel('ad network', candidates)).toBeNull();
  });

  test('returns null for an empty normalized model', () => {
    expect(pickCanonicalByBusinessModel('', candidates)).toBeNull();
  });

  test('excludes the report being generated', () => {
    expect(pickCanonicalByBusinessModel('marketplace', candidates, 'c')).toBeNull();
  });
});

describe('extractJsonObject', () => {
  test('extracts JSON from a fenced block', () => {
    const text = 'Here:\n```json\n{"a":1,"b":{"c":2}}\n```\nthanks';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ a: 1, b: { c: 2 } });
  });

  test('extracts a balanced object ignoring trailing prose', () => {
    const text = '{"a":"}{","b":2} trailing junk';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ a: '}{', b: 2 });
  });

  test('returns null when no object present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('completedKeywordNormSet (all-history dedupe)', () => {
  test('every completed keyword stays in the set regardless of age', () => {
    const rows = [
      { keywordNorm: 'recent' },
      { keywordNorm: 'ancient' },
    ];
    const set = completedKeywordNormSet(rows);
    expect(set.has('recent')).toBe(true);
    expect(set.has('ancient')).toBe(true);
  });

  test('empty keyword norms are skipped', () => {
    const set = completedKeywordNormSet([{ keywordNorm: '' }]);
    expect(set.size).toBe(0);
  });

  test('duplicate norms collapse into one entry', () => {
    const set = completedKeywordNormSet([
      { keywordNorm: 'dup' },
      { keywordNorm: 'dup' },
    ]);
    expect(set.size).toBe(1);
  });
});

describe('failedKeywordNormSet (failure circuit breaker)', () => {
  const now = new Date('2026-07-03T12:00:00Z');
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);

  test('keyword with >= min failures within the window is circuit-broken', () => {
    const rows = [
      { keywordNorm: 'bad', createdAt: hoursAgo(1) },
      { keywordNorm: 'bad', createdAt: hoursAgo(6) },
    ];
    const set = failedKeywordNormSet(rows, now);
    expect(set.has('bad')).toBe(true);
  });

  test('a single failure does not trip the breaker (tolerates transient errors)', () => {
    const set = failedKeywordNormSet([{ keywordNorm: 'once', createdAt: hoursAgo(2) }], now);
    expect(set.has('once')).toBe(false);
    expect(FAILURE_SKIP_MIN_COUNT).toBe(2);
  });

  test('failures outside the window are ignored (keyword becomes eligible again)', () => {
    const rows = [
      { keywordNorm: 'old', createdAt: hoursAgo(FAILURE_SKIP_WINDOW_HOURS + 1) },
      { keywordNorm: 'old', createdAt: hoursAgo(FAILURE_SKIP_WINDOW_HOURS + 2) },
    ];
    const set = failedKeywordNormSet(rows, now);
    expect(set.has('old')).toBe(false);
  });

  test('mixed in/out-of-window failures only count the in-window ones', () => {
    const rows = [
      { keywordNorm: 'mixed', createdAt: hoursAgo(1) },
      { keywordNorm: 'mixed', createdAt: hoursAgo(FAILURE_SKIP_WINDOW_HOURS + 5) },
    ];
    // Only 1 failure inside the window -> not circuit-broken.
    expect(failedKeywordNormSet(rows, now).has('mixed')).toBe(false);
  });

  test('future timestamps and empty norms are skipped', () => {
    const rows = [
      { keywordNorm: 'future', createdAt: hoursAgo(-1) },
      { keywordNorm: 'future', createdAt: hoursAgo(-2) },
      { keywordNorm: '', createdAt: hoursAgo(1) },
    ];
    expect(failedKeywordNormSet(rows, now).size).toBe(0);
  });

  test('independent keywords are counted separately', () => {
    const rows = [
      { keywordNorm: 'a', createdAt: hoursAgo(1) },
      { keywordNorm: 'a', createdAt: hoursAgo(2) },
      { keywordNorm: 'b', createdAt: hoursAgo(3) },
    ];
    const set = failedKeywordNormSet(rows, now);
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
  });
});

describe('parseWinRateRange', () => {
  test('parses a percent range and returns lo/hi/mid', () => {
    expect(parseWinRateRange('约8%-12%')).toEqual({ lo: 8, hi: 12, mid: 10 });
  });

  test('single value collapses to itself', () => {
    expect(parseWinRateRange('10%')).toEqual({ lo: 10, hi: 10, mid: 10 });
  });

  test('non-string / no numbers -> null', () => {
    expect(parseWinRateRange(undefined)).toBeNull();
    expect(parseWinRateRange('无')).toBeNull();
  });
});

describe('recomputeSeedReturn (deterministic basis)', () => {
  test('recomputes annualized book and the EV / risk-adjusted intervals', () => {
    // Year-5 book ROI 100% -> M=2.0; annualized = 2^(1/5)-1 ≈ 14.87%.
    // p=10% -> EV in [0.2, 0.2+0.9=1.1]; risk-adj in [0.2^(1/5)-1, 1.1^(1/5)-1]
    //        ≈ [-27.52%, +1.92%].
    const rc = recomputeSeedReturn({ bookRoiByYear: [20, 40, 60, 80, 100], winRate: '约10%' })!;
    expect(rc.bookMultiple).toBe(2);
    expect(rc.annualizedBookPct).toBeCloseTo(14.87, 1);
    expect(rc.winRateMidPct).toBe(10);
    expect(rc.evMoicLo).toBeCloseTo(0.2, 5);
    expect(rc.evMoicHi).toBeCloseTo(1.1, 5);
    expect(rc.riskAdjustedAnnualizedLoPct).toBeCloseTo(-27.52, 1);
    expect(rc.riskAdjustedAnnualizedHiPct).toBeCloseTo(1.92, 1);
  });

  test('win-rate range uses the midpoint', () => {
    const rc = recomputeSeedReturn({ bookRoiByYear: [0, 0, 0, 0, 400], winRate: '约8%-12%' })!;
    expect(rc.bookMultiple).toBe(5);
    expect(rc.evMoicLo).toBeCloseTo(0.5, 5);
    expect(rc.evMoicHi).toBeCloseTo(1.4, 5);
  });

  test('returns null on missing inputs', () => {
    expect(recomputeSeedReturn({ bookRoiByYear: [1, 2], winRate: '10%' })).toBeNull();
    expect(recomputeSeedReturn({ bookRoiByYear: [0, 0, 0, 0, 100], winRate: 'n/a' })).toBeNull();
  });

  test('non-positive book multiple returns null (total loss beyond -100%)', () => {
    expect(recomputeSeedReturn({ bookRoiByYear: [0, 0, 0, 0, -100], winRate: '10%' })).toBeNull();
  });
});

describe('buildSeedCalibrationNote', () => {
  test('silent when reported metrics fall inside the recomputed intervals', () => {
    // M=2 -> annualized 14.87%; p=10% -> EV in [0.2, 1.1]; risk-adj in [-27.52%, 1.92%].
    const note = buildSeedCalibrationNote({
      bookRoiByYear: [20, 40, 60, 80, 100],
      annualizedBook: '约15%',
      winRate: '约10%',
      expectedValueMOIC: '约0.8x',
      riskAdjustedAnnualized: '约-5%',
    });
    expect(note).toBe('');
  });

  test('flags the real-world inconsistency found in production data', () => {
    // Live sample: annualized 30% with bookRoiByYear ending at 100% and
    // risk-adjusted 10% at p=10-15% — both inconsistent with the formulas.
    const note = buildSeedCalibrationNote({
      bookRoiByYear: [20, 40, 60, 80, 100],
      annualizedBook: '30%',
      winRate: '约10%-15%',
      expectedValueMOIC: '约1.5x',
      riskAdjustedAnnualized: '约10%',
    });
    expect(note).toContain('【复算校准】');
    expect(note).toContain('账面年化自报 30%');
    expect(note).toContain('verify_bp_math.py');
  });

  test('validateAndNormalizeBpContent appends the calibration note to seed notes', () => {
    const raw = validRawForCalibration();
    const content = validateAndNormalizeBpContent(raw);
    expect(content.seedReturn.notes).toContain('【复算校准】');
  });

  function validRawForCalibration() {
    const fullScores = { market: 5, roi: 5, onlineability: 5, feasibility: 5, speed: 5, moat: 5 };
    return {
      title: 'T',
      summary: 'S',
      selectedOpportunity: 'x',
      opportunities: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, description: name, scores: fullScores })),
      market: { tam: '1', sam: '1', som: '1' },
      businessModel: 'm',
      financials: { years: [] },
      seedReturn: {
        bookRoiByYear: [20, 40, 60, 80, 100],
        annualizedBook: '30%', // inconsistent on purpose (should be ≈14.87%)
        winRate: '10%',
        profitLossRatio: '5:1',
        expectedValueMOIC: '1.5x',
        riskAdjustedAnnualized: '10%',
        notes: 'base note',
      },
    };
  }
});
