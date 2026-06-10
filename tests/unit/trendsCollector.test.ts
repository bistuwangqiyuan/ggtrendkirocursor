import { describe, test, expect } from 'vitest';
import {
  parseApproxTraffic,
  parseTrendsRss,
  decodeXmlEntities,
  estimateTrendGrowthRate,
  mapRssItemToRow,
  dedupeRssItems,
  COLLECTOR_CATEGORY,
} from '../../src/lib/services/trendsCollector';
import {
  computeTrendHotwordScore,
  MIN_TREND_SCORE,
} from '../../src/lib/services/bp';
import { clampBatchSize, DEFAULT_BP_BATCH_SIZE, MAX_BP_BATCH_SIZE } from '../../src/lib/bpBatch';

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trends/trendingsearches/daily">
<channel>
  <title>Daily Search Trends</title>
  <item>
    <title>Acme &amp; Co launch</title>
    <ht:approx_traffic>200,000+</ht:approx_traffic>
    <pubDate>Wed, 10 Jun 2026 00:00:00 -0700</pubDate>
  </item>
  <item>
    <title><![CDATA[New iPhone]]></title>
    <ht:approx_traffic>50K+</ht:approx_traffic>
  </item>
  <item>
    <title>quiet keyword</title>
  </item>
</channel>
</rss>`;

describe('parseApproxTraffic', () => {
  test('parses comma-grouped numbers', () => {
    expect(parseApproxTraffic('200,000+')).toBe(200000);
  });
  test('parses K/M/B units', () => {
    expect(parseApproxTraffic('50K+')).toBe(50000);
    expect(parseApproxTraffic('2.5M+')).toBe(2500000);
    expect(parseApproxTraffic('1B+')).toBe(1000000000);
  });
  test('parses a bare number', () => {
    expect(parseApproxTraffic('1234')).toBe(1234);
  });
  test('returns null for missing/invalid', () => {
    expect(parseApproxTraffic('')).toBeNull();
    expect(parseApproxTraffic(undefined)).toBeNull();
    expect(parseApproxTraffic('n/a')).toBeNull();
  });
});

describe('decodeXmlEntities', () => {
  test('decodes common entities', () => {
    expect(decodeXmlEntities('Acme &amp; Co')).toBe('Acme & Co');
    expect(decodeXmlEntities('it&#39;s &quot;hot&quot;')).toBe('it\'s "hot"');
  });
});

describe('parseTrendsRss', () => {
  test('extracts keyword + traffic from items (incl. CDATA and entities)', () => {
    const items = parseTrendsRss(SAMPLE_RSS);
    expect(items.length).toBe(3);
    expect(items[0]).toEqual({ keyword: 'Acme & Co launch', approxTraffic: 200000 });
    expect(items[1]).toEqual({ keyword: 'New iPhone', approxTraffic: 50000 });
    expect(items[2]).toEqual({ keyword: 'quiet keyword', approxTraffic: null });
  });
  test('returns [] for empty/garbage input', () => {
    expect(parseTrendsRss('')).toEqual([]);
    expect(parseTrendsRss('<rss></rss>')).toEqual([]);
  });
});

describe('dedupeRssItems', () => {
  test('keeps the highest traffic per normalized keyword', () => {
    const out = dedupeRssItems([
      { keyword: 'AI', approxTraffic: 1000 },
      { keyword: 'ai', approxTraffic: 5000 },
      { keyword: 'Other', approxTraffic: null },
    ]);
    expect(out.length).toBe(2);
    const ai = out.find((i) => i.keyword.toLowerCase() === 'ai');
    expect(ai?.approxTraffic).toBe(5000);
  });
});

describe('estimateTrendGrowthRate', () => {
  test('is bounded to 74-100', () => {
    expect(estimateTrendGrowthRate(1)).toBeGreaterThanOrEqual(74);
    expect(estimateTrendGrowthRate(1)).toBeLessThanOrEqual(100);
    expect(estimateTrendGrowthRate(10_000_000)).toBe(100);
  });
});

describe('collected rows clear the BP picker threshold', () => {
  // Every realistic traffic tier (incl. the small fallback) must score > MIN_TREND_SCORE
  // so the cron picker can actually use freshly collected keywords.
  test.each([1000, 5000, 10000, 50000, 200000, 1000000])(
    'searchVolume %i scores above MIN_TREND_SCORE',
    (sv) => {
      const row = mapRssItemToRow({ keyword: 'k', approxTraffic: sv }, 'US');
      expect(row.category).toBe(COLLECTOR_CATEGORY);
      const score = computeTrendHotwordScore({ searchVolume: row.searchVolume, growthRate: row.growthRate });
      expect(score).toBeGreaterThan(MIN_TREND_SCORE);
    }
  );

  test('missing traffic falls back to a usable volume that still scores', () => {
    const row = mapRssItemToRow({ keyword: 'k', approxTraffic: null }, 'GB');
    expect(row.searchVolume).toBeGreaterThan(0);
    const score = computeTrendHotwordScore({ searchVolume: row.searchVolume, growthRate: row.growthRate });
    expect(score).toBeGreaterThan(MIN_TREND_SCORE);
  });
});

describe('clampBatchSize', () => {
  test('defaults on non-numeric / empty', () => {
    expect(clampBatchSize(undefined)).toBe(DEFAULT_BP_BATCH_SIZE);
    expect(clampBatchSize('')).toBe(DEFAULT_BP_BATCH_SIZE);
    expect(clampBatchSize('abc')).toBe(DEFAULT_BP_BATCH_SIZE);
  });
  test('clamps to [1, MAX]', () => {
    expect(clampBatchSize('0')).toBe(1);
    expect(clampBatchSize(-5)).toBe(1);
    expect(clampBatchSize(100)).toBe(MAX_BP_BATCH_SIZE);
    expect(clampBatchSize('7')).toBe(7);
    expect(clampBatchSize(3.9)).toBe(3);
  });
});
