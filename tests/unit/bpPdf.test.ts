import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { contentDisposition, pdfFilename, renderBpPdf } from '../../src/lib/pdf/bpPdf';
import { truncateToWidth, tokenize, wrapText } from '../../src/lib/pdf/layout';
import type { BpContent, BpReport } from '../../src/types';

/** Rough measurer: 10pt per CJK character, 5pt per Latin one, like a real font. */
const measure = (text: string) =>
  [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 10 : 5), 0);

function content(overrides: Partial<BpContent> = {}): BpContent {
  return {
    title: '在线宠物营养订阅服务 · Online Pet Nutrition Subscription',
    summary:
      '围绕热词「宠物营养」构建的在线订阅服务：以配方问卷驱动个性化配方，配合内容社区降低获客成本。' +
      'The English half is here so the mixed-script line breaking is exercised too.',
    selectedOpportunity: '个性化宠物营养订阅',
    opportunities: [
      {
        name: '个性化宠物营养订阅',
        description: '按宠物体重、年龄与过敏史生成配方，按月配送。',
        scores: { market: 8, roi: 7, onlineability: 9, feasibility: 7, speed: 8, moat: 6 },
        weightedScore: 7.6,
        isSelected: true,
        rank: 1,
      },
      {
        name: 'Vet-reviewed content hub',
        description: 'SEO content that feeds the subscription funnel.',
        scores: { market: 7, roi: 6, onlineability: 9, feasibility: 8, speed: 9, moat: 4 },
        weightedScore: 7.1,
        isSelected: false,
        rank: 2,
      },
    ],
    market: { tam: '$4.2B', sam: '$820M', som: '$61M', notes: '以中国与东南亚市场为主。' },
    businessModel: '月度订阅 + 一次性诊断问卷，毛利率约 62%。',
    financials: {
      years: [
        { year: 1, revenue: '$120K', ebitda: '-$40K' },
        { year: 2, revenue: '$610K', ebitda: '$55K' },
        { year: 3, revenue: '$2.1M', ebitda: '$390K' },
        { year: 4, revenue: '$4.4M', ebitda: '$920K' },
        { year: 5, revenue: '$7.8M', ebitda: '$1.9M' },
      ],
    },
    seedReturn: {
      bookRoiByYear: [50, 140, 380, 495, 665],
      annualizedBook: '61%',
      winRate: '28%',
      profitLossRatio: '4.1',
      expectedValueMOIC: '2.3x',
      riskAdjustedAnnualized: '34%',
      notes: '按种子轮 12% 股权、5 年退出测算。',
    },
    ...overrides,
  };
}

function report(overrides: Partial<BpReport> = {}): BpReport {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    keyword: '宠物营养',
    keywordNorm: '宠物营养',
    searchVolume: 120_000,
    growthRate: 180,
    category: 'Pets',
    timeRange: 'now 7-d',
    region: 'US',
    rank: 3,
    status: 'completed',
    contentJson: content(),
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  } as BpReport;
}

describe('layout helpers', () => {
  it('breaks CJK between any two characters and Latin only at spaces', () => {
    const tokens = tokenize('订阅服务 subscription service');
    expect(tokens).toContain('订');
    expect(tokens).toContain('subscription');
  });

  it('wraps to the given width without dropping text', () => {
    const text = 'The quick brown fox jumps over the lazy dog again and again';
    const lines = wrapText(text, 100, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(100);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });

  it('wraps CJK, which has no spaces to break at', () => {
    const lines = wrapText('个性化宠物营养订阅服务按月配送', 40, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('个性化宠物营养订阅服务按月配送');
  });

  it('hard-splits a token too long to fit on any line', () => {
    // A long URL would otherwise run off the edge of a paid document.
    const lines = wrapText('https://example.com/an/extremely/long/path/segment', 50, measure);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(50);
  });

  it('truncates table cells with an ellipsis rather than overflowing', () => {
    const truncated = truncateToWidth('a very long cell value indeed', 40, measure);
    expect(measure(truncated)).toBeLessThanOrEqual(40);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncateToWidth('short', 100, measure)).toBe('short');
  });

  it('keeps closing punctuation attached to the line it belongs to', () => {
    const lines = wrapText('结果很好。', 30, measure);
    expect(lines.at(-1)?.endsWith('。')).toBe(true);
  });
});

// Embedding and subsetting a 2 MB CJK font is the slow part, and it happens once
// per process rather than per render, so the first case pays for all of them.
const RENDER_TIMEOUT_MS = 60_000;

describe('renderBpPdf', () => {
  it('renders a Chinese report to a real, multi-page PDF', { timeout: RENDER_TIMEOUT_MS }, async () => {
    const rendered = await renderBpPdf(report(), {
      locale: 'zh',
      buyerEmail: 'buyer@example.com',
      orderReference: 'ref-1',
      siteName: 'ioni.top',
      siteUrl: 'https://ioni.top',
    });

    expect(rendered.bytes.length).toBeGreaterThan(5_000);
    expect(Buffer.from(rendered.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');

    // Parsed back rather than pattern-matched: this proves the file a buyer
    // receives actually opens, and that a cover plus the body needs more than
    // one page.
    const reloaded = await PDFDocument.load(rendered.bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
    const [first] = reloaded.getPages();
    expect(Math.round(first.getWidth())).toBe(595);
    expect(Math.round(first.getHeight())).toBe(842);
  });

  it('draws every character the reports actually use', { timeout: RENDER_TIMEOUT_MS }, async () => {
    // A non-empty list means a buyer saw '?' in a document they paid for, so the
    // committed font subset needs widening.
    const rendered = await renderBpPdf(report(), { locale: 'zh' });
    expect(rendered.missingGlyphs).toEqual([]);
  });

  it('renders the English locale too', { timeout: RENDER_TIMEOUT_MS }, async () => {
    const rendered = await renderBpPdf(report(), { locale: 'en' });
    expect(Buffer.from(rendered.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('refuses to sell a PDF of an empty report', async () => {
    await expect(renderBpPdf(report({ contentJson: null }))).rejects.toThrow(/no content/);
  });

  it('names the file after the report and its date', () => {
    expect(pdfFilename(report())).toMatch(/-2026-08-01\.pdf$/);
    // No path separators or quotes can reach Content-Disposition.
    expect(pdfFilename(report())).not.toMatch(/["/\\]/);
  });

  it('falls back to a usable filename when there is no title', () => {
    const name = pdfFilename(report({ contentJson: null, keyword: '///' }));
    expect(name).toBe('report-2026-08-01.pdf');
  });

  it('keeps Content-Disposition ASCII-safe for Chinese titles', () => {
    // undici throws if a header value contains a code point > 255 — that is what
    // made every Chinese PDF download return render_failed after a successful render.
    const header = contentDisposition(pdfFilename(report()));
    for (let i = 0; i < header.length; i++) {
      expect(header.charCodeAt(i)).toBeLessThanOrEqual(255);
    }
    expect(header).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    expect(header).toContain(encodeURIComponent(pdfFilename(report())));
  });
});
