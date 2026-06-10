import { describe, test, expect } from 'vitest';
import {
  SCORE_WEIGHTS,
  computeWeightedScore,
  validateAndNormalizeBpContent,
  BpValidationError,
  computeTrendHotwordScore,
  pickFirstEligibleTrend,
  MIN_TREND_SCORE,
  normalizeBusinessModel,
  pickCanonicalByBusinessModel,
  parseWinRatePercent,
  WIN_RATE_OPTIMISM_THRESHOLD,
  DEDUPE_WINDOW_DAYS,
  isWithinDays,
  recentKeywordNormSet,
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

function makeTrend(keyword: string, searchVolume: number, growthRate: number, id = 't1'): Trend {
  return {
    id,
    keyword,
    searchVolume,
    growthRate,
    category: 'technology',
    timeRange: '4h',
    region: 'US',
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

describe('isWithinDays (7-day dedup boundary)', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  test('just under the window is within', () => {
    const almost7 = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000 - 1000));
    expect(isWithinDays(almost7, now, DEDUPE_WINDOW_DAYS)).toBe(true);
  });

  test('exactly N days is inclusive (within)', () => {
    expect(isWithinDays(daysAgo(7), now, DEDUPE_WINDOW_DAYS)).toBe(true);
  });

  test('just over the window is outside', () => {
    const over7 = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000 + 1000));
    expect(isWithinDays(over7, now, DEDUPE_WINDOW_DAYS)).toBe(false);
  });

  test('future dates (negative elapsed) are not counted', () => {
    expect(isWithinDays(daysAgo(-1), now, DEDUPE_WINDOW_DAYS)).toBe(false);
  });

  test('invalid date is not within', () => {
    expect(isWithinDays(new Date('not-a-date'), now, DEDUPE_WINDOW_DAYS)).toBe(false);
  });
});

describe('recentKeywordNormSet', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  test('recent keyword stays, old keyword drops out of the set', () => {
    const rows = [
      { keywordNorm: 'recent', createdAt: daysAgo(2) },
      { keywordNorm: 'stale', createdAt: daysAgo(8) },
    ];
    const set = recentKeywordNormSet(rows, now, DEDUPE_WINDOW_DAYS);
    expect(set.has('recent')).toBe(true);
    expect(set.has('stale')).toBe(false);
  });

  test('keyword at exactly the boundary is retained', () => {
    const set = recentKeywordNormSet([{ keywordNorm: 'edge', createdAt: daysAgo(7) }], now, DEDUPE_WINDOW_DAYS);
    expect(set.has('edge')).toBe(true);
  });

  test('empty keyword norms are skipped', () => {
    const set = recentKeywordNormSet([{ keywordNorm: '', createdAt: daysAgo(1) }], now, DEDUPE_WINDOW_DAYS);
    expect(set.size).toBe(0);
  });

  test('defaults to the 7-day window when omitted', () => {
    const rows = [
      { keywordNorm: 'in', createdAt: daysAgo(6) },
      { keywordNorm: 'out', createdAt: daysAgo(9) },
    ];
    const set = recentKeywordNormSet(rows, now);
    expect(set.has('in')).toBe(true);
    expect(set.has('out')).toBe(false);
  });
});
