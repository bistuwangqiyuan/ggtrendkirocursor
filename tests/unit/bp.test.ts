import { describe, test, expect } from 'vitest';
import {
  SCORE_WEIGHTS,
  computeWeightedScore,
  validateAndNormalizeBpContent,
  BpValidationError,
} from '../../src/lib/services/bp';
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
