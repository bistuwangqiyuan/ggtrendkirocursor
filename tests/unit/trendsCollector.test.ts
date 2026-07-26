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
import type { RssTrendItem } from '../../src/lib/services/trendsCollector';
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
    <ht:news_item>
      <ht:news_item_title>Some unrelated news headline</ht:news_item_title>
      <ht:news_item_url>https://example.com/story</ht:news_item_url>
      <ht:news_item_source>Example News</ht:news_item_source>
    </ht:news_item>
    <ht:news_item>
      <ht:news_item_title>A second headline</ht:news_item_title>
      <ht:news_item_source>Another Outlet</ht:news_item_source>
    </ht:news_item>
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

/** An RSS item with everything defaulted, so a test states only what it means. */
function rssItem(overrides: Partial<RssTrendItem> = {}): RssTrendItem {
  return { keyword: 'k', approxTraffic: null, newsTitles: [], newsSources: [], ...overrides };
}

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
    expect(items[0]).toMatchObject({ keyword: 'Acme & Co launch', approxTraffic: 200000 });
    expect(items[1]).toMatchObject({ keyword: 'New iPhone', approxTraffic: 50000 });
    expect(items[2]).toMatchObject({ keyword: 'quiet keyword', approxTraffic: null });
  });
  test('collects every news headline and publisher behind an item', () => {
    const [first] = parseTrendsRss(SAMPLE_RSS);
    expect(first.newsTitles).toEqual(['Some unrelated news headline', 'A second headline']);
    // URLs come along with publisher names: the host is often the clearer
    // signal ("sports.yahoo.com" vs "Yahoo Sports").
    expect(first.newsSources).toEqual([
      'Example News', 'Another Outlet', 'https://example.com/story',
    ]);
  });
  test('yields empty news arrays when the feed omits them', () => {
    const items = parseTrendsRss(SAMPLE_RSS);
    expect(items[2].newsTitles).toEqual([]);
    expect(items[2].newsSources).toEqual([]);
  });
  test('returns [] for empty/garbage input', () => {
    expect(parseTrendsRss('')).toEqual([]);
    expect(parseTrendsRss('<rss></rss>')).toEqual([]);
  });
});

describe('dedupeRssItems', () => {
  test('keeps the highest traffic per normalized keyword', () => {
    const out = dedupeRssItems([
      { keyword: 'AI', approxTraffic: 1000, newsTitles: [], newsSources: [] },
      { keyword: 'ai', approxTraffic: 5000, newsTitles: [], newsSources: [] },
      { keyword: 'Other', approxTraffic: null, newsTitles: [], newsSources: [] },
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
      const row = mapRssItemToRow(rssItem({ approxTraffic: sv }), 'US');
      expect(row.category).toBe(COLLECTOR_CATEGORY);
      const score = computeTrendHotwordScore({ searchVolume: row.searchVolume, growthRate: row.growthRate });
      expect(score).toBeGreaterThan(MIN_TREND_SCORE);
    }
  );

  test('missing traffic falls back to a usable volume that still scores', () => {
    const row = mapRssItemToRow(rssItem({ approxTraffic: null }), 'GB');
    expect(row.searchVolume).toBeGreaterThan(0);
    const score = computeTrendHotwordScore({ searchVolume: row.searchVolume, growthRate: row.growthRate });
    expect(score).toBeGreaterThan(MIN_TREND_SCORE);
  });
});

describe('mapRssItemToRow classification', () => {
  test('tags a sports hotword from its news publishers, not the keyword', () => {
    // "brickyard 400" says nothing on its own; the publishers settle it.
    const row = mapRssItemToRow(
      rssItem({
        keyword: 'brickyard 400',
        newsTitles: ['What to Watch: Brickyard 400 demands perfection'],
        newsSources: ['NASCAR.com', 'https://sports.yahoo.com/articles/x'],
      }),
      'US'
    );
    expect(row.topicClass).toBe('sports');
  });

  test('tags an entertainment hotword the same way', () => {
    const row = mapRssItemToRow(
      rssItem({
        keyword: 'ana de armas',
        newsTitles: ['Actress opens up about her new film'],
        newsSources: ['Variety.com', 'TMZ'],
      }),
      'US'
    );
    expect(row.topicClass).toBe('entertainment');
  });

  test('leaves an ordinary hotword analysable', () => {
    const row = mapRssItemToRow(
      rssItem({
        keyword: 'irs tax refund status',
        newsTitles: ['How to check your refund online'],
        newsSources: ['Reuters'],
      }),
      'US'
    );
    expect(row.topicClass).toBe('general');
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
