/**
 * The paid artifact: a typeset PDF of a completed business plan.
 *
 * WHY A RENDERER AND NOT "PRINT THIS PAGE"
 * The report page already prints, and the print button stays free — pretending
 * otherwise would be dishonest, and Ctrl+P cannot be taken away anyway. What is
 * sold here is a different object: a paginated document with a cover, running
 * headers, page numbers, tables that do not split across pages mid-row, and the
 * buyer's licence line. That is worth a dollar; a screenshot of a web page is not.
 *
 * WHY pdf-lib AND NOT A HEADLESS BROWSER
 * Chromium does not fit in a serverless function this site can afford, and a
 * 26-second SSR budget cannot absorb a browser launch. pdf-lib is pure JS,
 * renders this document in well under a second, and has no native dependencies to
 * break on a runtime upgrade.
 *
 * THE FONT
 * One embedded subset of Noto Sans SC (see scripts/build-pdf-font.py), because
 * the reports are bilingual and the PDF standard fonts have no Chinese glyphs.
 * Bold is drawn as a double strike rather than a second embedded weight: the
 * visual difference at heading sizes is small, and the file would otherwise be
 * twice the size for it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { BpContent, BpOpportunity, BpReport } from '../../types';
import { truncateToWidth, wrapText } from './layout';

const FONT_FILE = 'NotoSansSC-subset.ttf';

/** A4 in points, the paper the buyer will actually print on. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 64, right: 56, bottom: 62, left: 56 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const INK = rgb(0.114, 0.114, 0.122);
const SUBTLE = rgb(0.431, 0.431, 0.451);
const ACCENT = rgb(0.149, 0.388, 0.922);
const RULE = rgb(0.91, 0.91, 0.929);
const BAND = rgb(0.965, 0.972, 1);
const GREEN = rgb(0.082, 0.502, 0.239);
const AMBER = rgb(0.706, 0.325, 0.035);

/**
 * Read once per container. The file is ~2 MB and every download would otherwise
 * re-read and re-parse it.
 */
let fontBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Where the font can be found, in order of preference.
 *
 * In the Lambda the file arrives through netlify.toml `included_files`, relative
 * to the task root; in `astro dev` and in tests it is simply in the repo. The
 * process working directory differs between all three, so each is tried rather
 than assumed.
 */
function fontCandidates(): string[] {
  const relative = path.join('public', 'fonts', FONT_FILE);
  const candidates = [
    path.resolve(process.cwd(), relative),
    path.resolve(process.env.LAMBDA_TASK_ROOT || '/var/task', relative),
    // dist/ layout, when the client build has been published next to the server.
    path.resolve(process.cwd(), 'dist', 'client', 'fonts', FONT_FILE),
  ];
  return [...new Set(candidates)];
}

async function loadFontBytes(): Promise<Uint8Array> {
  if (!fontBytesPromise) {
    fontBytesPromise = (async () => {
      const tried: string[] = [];
      for (const candidate of fontCandidates()) {
        try {
          return new Uint8Array(await readFile(candidate));
        } catch {
          tried.push(candidate);
        }
      }
      throw new Error(`PDF font ${FONT_FILE} not found. Looked in: ${tried.join(', ')}`);
    })();
  }
  try {
    return await fontBytesPromise;
  } catch (error) {
    // Don't cache the failure: a missing file may be a deploy that is still
    // settling, and the next request should look again.
    fontBytesPromise = null;
    throw error;
  }
}

export interface PdfMeta {
  /** Shown in the footer so a leaked file is traceable to the purchase. */
  orderReference?: string;
  buyerEmail?: string;
  siteName?: string;
  siteUrl?: string;
  locale?: 'en' | 'zh';
}

interface Strings {
  cover: string;
  generated: string;
  sourceTrend: string;
  keyword: string;
  volume: string;
  category: string;
  window: string;
  region: string;
  summary: string;
  scoreMatrix: string;
  scores: Record<string, string>;
  weighted: string;
  selected: string;
  market: string;
  tam: string;
  sam: string;
  som: string;
  businessModel: string;
  financials: string;
  year: string;
  revenue: string;
  ebitda: string;
  seedReturn: string;
  annualized: string;
  winRate: string;
  plRatio: string;
  ev: string;
  riskAdjusted: string;
  roiByYear: string;
  disclaimerTitle: string;
  disclaimer: string;
  licensedTo: string;
  pageOf: (page: number, total: number) => string;
}

const EN: Strings = {
  cover: 'AI BUSINESS OPPORTUNITY REPORT',
  generated: 'Generated',
  sourceTrend: 'Source trend',
  keyword: 'Keyword',
  volume: 'Search volume',
  category: 'Category',
  window: 'Trending window',
  region: 'Region',
  summary: 'Executive summary',
  scoreMatrix: 'Opportunity score matrix',
  scores: {
    market: 'Market',
    roi: 'ROI',
    onlineability: 'Online',
    feasibility: 'Feasible',
    speed: 'Speed',
    moat: 'Moat',
  },
  weighted: 'Weighted',
  selected: 'Selected opportunity',
  market: 'Market sizing',
  tam: 'TAM',
  sam: 'SAM',
  som: 'SOM',
  businessModel: 'Business model',
  financials: 'Five-year financial projection',
  year: 'Year',
  revenue: 'Revenue',
  ebitda: 'EBITDA',
  seedReturn: 'Seed-round return profile',
  annualized: 'Annualized (book)',
  winRate: 'Win rate',
  plRatio: 'Profit/loss ratio',
  ev: 'Expected value (MOIC)',
  riskAdjusted: 'Risk-adjusted annualized',
  roiByYear: 'Book ROI by year',
  disclaimerTitle: 'About this report',
  disclaimer:
    'This report was produced automatically from public Google Trends data by a large language model. Figures are modelled estimates, not audited forecasts, and nothing here is investment advice. Verify every assumption before committing capital.',
  licensedTo: 'Licensed to',
  pageOf: (page, total) => `Page ${page} / ${total}`,
};

const ZH: Strings = {
  cover: 'AI 商业机会分析报告',
  generated: '生成时间',
  sourceTrend: '来源热词',
  keyword: '关键词',
  volume: '搜索量',
  category: '分类',
  window: '上升周期',
  region: '地区',
  summary: '摘要',
  scoreMatrix: '机会评分矩阵',
  scores: {
    market: '市场',
    roi: '回报',
    onlineability: '线上化',
    feasibility: '可行性',
    speed: '速度',
    moat: '护城河',
  },
  weighted: '加权得分',
  selected: '选定机会',
  market: '市场规模',
  tam: 'TAM',
  sam: 'SAM',
  som: 'SOM',
  businessModel: '商业模式',
  financials: '五年财务预测',
  year: '年份',
  revenue: '收入',
  ebitda: 'EBITDA',
  seedReturn: '种子轮回报测算',
  annualized: '账面年化',
  winRate: '胜率',
  plRatio: '盈亏比',
  ev: '期望值（MOIC）',
  riskAdjusted: '风险调整后年化',
  roiByYear: '各年账面 ROI',
  disclaimerTitle: '关于本报告',
  disclaimer:
    '本报告由大语言模型基于公开的 Google Trends 数据自动生成。所有数字均为模型估算，并非经审计的预测，也不构成任何投资建议。在投入资金之前，请自行核实每一项假设。',
  licensedTo: '授权给',
  pageOf: (page, total) => `第 ${page} 页 / 共 ${total} 页`,
};

/**
 * A cursor over a growing document.
 *
 * Written as a small class because every draw call needs the same four things —
 * the current page, the current y, the font, and the knowledge of when to break —
 * and threading those through a dozen free functions made the section code
 * unreadable.
 */
class Writer {
  private page: PDFPage;
  private y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly strings: Strings,
    private readonly meta: PdfMeta
  ) {
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN.top;
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(page);
    return page;
  }

  width(text: string, size: number): number {
    return this.font.widthOfTextAtSize(text, size);
  }

  /** Start a new page when `needed` points would not fit above the footer. */
  ensure(needed: number): void {
    if (this.y - needed >= MARGIN.bottom) return;
    this.page = this.newPage();
    this.y = PAGE.height - MARGIN.top;
  }

  gap(points: number): void {
    this.y -= points;
  }

  get cursor(): number {
    return this.y;
  }

  set cursor(value: number) {
    this.y = value;
  }

  get current(): PDFPage {
    return this.page;
  }

  text(
    value: string,
    options: {
      size?: number;
      color?: RGB;
      bold?: boolean;
      x?: number;
      maxWidth?: number;
      lineHeight?: number;
    } = {}
  ): void {
    const size = options.size ?? 10.5;
    const color = options.color ?? INK;
    const x = options.x ?? MARGIN.left;
    const maxWidth = options.maxWidth ?? CONTENT_WIDTH - (x - MARGIN.left);
    const lineHeight = options.lineHeight ?? size * 1.62;

    for (const line of wrapText(value, maxWidth, (t) => this.width(t, size))) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      if (line) this.draw(line, x, this.y, size, color, options.bold);
    }
  }

  /**
   * Faux bold: the same glyphs struck twice, a fifth of a point apart. A second
   * embedded font weight would double the deploy for a difference nobody would
   * notice at 11pt.
   */
  draw(text: string, x: number, y: number, size: number, color: RGB, bold = false): void {
    this.page.drawText(text, { x, y, size, font: this.font, color });
    if (bold) {
      this.page.drawText(text, { x: x + 0.22, y, size, font: this.font, color });
    }
  }

  heading(title: string): void {
    // Keep a heading with at least the first line of its section.
    this.ensure(58);
    this.gap(22);
    this.ensure(34);
    this.y -= 15;
    this.draw(title, MARGIN.left, this.y, 13.5, INK, true);
    this.y -= 8;
    this.page.drawRectangle({
      x: MARGIN.left,
      y: this.y,
      width: 30,
      height: 2.2,
      color: ACCENT,
    });
    this.y -= 12;
  }

  /** Footer on every page except the cover, added once the total is known. */
  finish(): void {
    const total = this.pages.length;
    const footerSize = 8;
    for (let i = 0; i < total; i++) {
      const page = this.pages[i];
      if (i > 0) {
        page.drawLine({
          start: { x: MARGIN.left, y: MARGIN.bottom + 22 },
          end: { x: PAGE.width - MARGIN.right, y: MARGIN.bottom + 22 },
          thickness: 0.5,
          color: RULE,
        });
      }
      const left = this.meta.siteUrl || '';
      const right = this.strings.pageOf(i + 1, total);
      if (left) {
        page.drawText(left, {
          x: MARGIN.left,
          y: MARGIN.bottom + 9,
          size: footerSize,
          font: this.font,
          color: SUBTLE,
        });
      }
      page.drawText(right, {
        x: PAGE.width - MARGIN.right - this.width(right, footerSize),
        y: MARGIN.bottom + 9,
        size: footerSize,
        font: this.font,
        color: SUBTLE,
      });
    }
  }
}

/** Replace codepoints the subset font cannot draw, so nothing renders blank. */
function sanitize(value: unknown, missing: Set<string>, supported: (cp: number) => boolean): string {
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    // Newlines and tabs are layout, not glyphs.
    if (char === '\n' || char === '\t') {
      out += char;
      continue;
    }
    if (cp < 0x20) continue;
    if (supported(cp)) {
      out += char;
    } else {
      missing.add(char);
      out += '?';
    }
  }
  return out;
}

function statBox(
  writer: Writer,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  color: RGB
): number {
  const page = writer.current;
  const height = 46;
  page.drawRectangle({
    x,
    y: y - height,
    width,
    height,
    color: BAND,
    borderColor: RULE,
    borderWidth: 0.6,
  });
  writer.draw(truncateToWidth(label, width - 16, (t) => writer.width(t, 8)), x + 8, y - 16, 8, SUBTLE);
  writer.draw(
    truncateToWidth(value || '—', width - 16, (t) => writer.width(t, 12)),
    x + 8,
    y - 34,
    12,
    color,
    true
  );
  return height;
}

/** Evenly spaced boxes across the content width. */
function statRow(
  writer: Writer,
  items: { label: string; value: string; color?: RGB }[]
): void {
  if (items.length === 0) return;
  writer.ensure(56);
  const gap = 10;
  const width = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
  const top = writer.cursor - 4;
  let height = 0;
  items.forEach((item, i) => {
    height = statBox(
      writer,
      MARGIN.left + i * (width + gap),
      top,
      width,
      item.label,
      item.value,
      item.color ?? INK
    );
  });
  writer.cursor = top - height - 6;
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

function table(writer: Writer, columns: Column[], rows: string[][], highlight?: (i: number) => boolean): void {
  const headerSize = 8;
  const bodySize = 9.5;
  const rowHeight = 20;

  const drawHeader = () => {
    writer.ensure(rowHeight * 2);
    let x = MARGIN.left;
    const y = writer.cursor - 12;
    for (const column of columns) {
      const label = truncateToWidth(column.header, column.width - 8, (t) => writer.width(t, headerSize));
      const offset = column.align === 'right' ? column.width - 4 - writer.width(label, headerSize) : 4;
      writer.draw(label, x + offset, y, headerSize, SUBTLE, true);
      x += column.width;
    }
    writer.cursor = y - 6;
    writer.current.drawLine({
      start: { x: MARGIN.left, y: writer.cursor },
      end: { x: MARGIN.left + columns.reduce((s, c) => s + c.width, 0), y: writer.cursor },
      thickness: 0.7,
      color: RULE,
    });
  };

  drawHeader();

  rows.forEach((row, index) => {
    const before = writer.cursor;
    writer.ensure(rowHeight + 4);
    // A page break inside a table needs the header repeated, or the numbers on
    // the new page have no meaning.
    if (writer.cursor > before) drawHeader();

    const top = writer.cursor;
    if (highlight?.(index)) {
      writer.current.drawRectangle({
        x: MARGIN.left - 4,
        y: top - rowHeight + 4,
        width: CONTENT_WIDTH + 8,
        height: rowHeight,
        color: BAND,
      });
    }

    let x = MARGIN.left;
    columns.forEach((column, columnIndex) => {
      const raw = row[columnIndex] ?? '';
      const label = truncateToWidth(raw, column.width - 8, (t) => writer.width(t, bodySize));
      const offset = column.align === 'right' ? column.width - 4 - writer.width(label, bodySize) : 4;
      writer.draw(label, x + offset, top - 13, bodySize, INK, columnIndex === 0 && !!highlight?.(index));
      x += column.width;
    });

    writer.cursor = top - rowHeight;
    writer.current.drawLine({
      start: { x: MARGIN.left, y: writer.cursor },
      end: { x: MARGIN.left + columns.reduce((s, c) => s + c.width, 0), y: writer.cursor },
      thickness: 0.4,
      color: RULE,
    });
  });
  writer.gap(4);
}

export interface RenderedPdf {
  bytes: Uint8Array;
  /** Characters the font could not draw. Empty in normal operation; a non-empty
   * set means the subset needs widening, which is worth knowing about. */
  missingGlyphs: string[];
}

/**
 * Render one completed report.
 *
 * Throws when the report has no structured content: a PDF of an empty template
 * is worse than an error, because the buyer would have paid for it.
 */
export async function renderBpPdf(report: BpReport, meta: PdfMeta = {}): Promise<RenderedPdf> {
  const content: BpContent | null | undefined = report.contentJson;
  if (!content) throw new Error(`Report ${report.id} has no content to render`);

  const locale = meta.locale === 'en' ? 'en' : 'zh';
  const strings = locale === 'en' ? EN : ZH;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = await loadFontBytes();
  // subset: true keeps only the glyphs this document uses, so a 2 MB font
  // contributes tens of kilobytes to the file the buyer downloads. Fall back to
  // the full font if subsetting throws — fontkit under some bundlers has been
  // seen to reject large CJK glyph sets while Latin-only subsets succeed.
  let font: PDFFont;
  try {
    font = await doc.embedFont(fontBytes, { subset: true });
  } catch (subsetError) {
    console.warn('[pdf] subset embed failed, embedding full font:', (subsetError as Error).message);
    font = await doc.embedFont(fontBytes, { subset: false });
  }

  const missing = new Set<string>();
  // fontkit is already loaded for embedding; asking it which codepoints exist is
  // how a missing glyph becomes a logged '?' instead of an invisible gap.
  const parsed = (fontkit as unknown as { create(b: Uint8Array): { hasGlyphForCodePoint(cp: number): boolean } }).create(
    fontBytes
  );
  const supported = (cp: number) => {
    try {
      return parsed.hasGlyphForCodePoint(cp);
    } catch {
      return true;
    }
  };
  const s = (value: unknown) => sanitize(value, missing, supported);

  const title = s(content.title || report.keyword);
  doc.setTitle(title);
  doc.setSubject(strings.cover);
  doc.setCreator(meta.siteName || 'ioni.top');
  doc.setProducer(meta.siteName || 'ioni.top');
  doc.setCreationDate(new Date());

  const writer = new Writer(doc, font, strings, { ...meta, locale });

  // --- Cover -------------------------------------------------------------
  const cover = writer.current;
  cover.drawRectangle({ x: 0, y: PAGE.height - 250, width: PAGE.width, height: 250, color: rgb(0.059, 0.09, 0.165) });
  writer.draw(strings.cover, MARGIN.left, PAGE.height - 92, 9.5, rgb(0.65, 0.72, 0.9), true);
  writer.cursor = PAGE.height - 122;
  writer.text(title, { size: 24, color: rgb(1, 1, 1), bold: true, lineHeight: 31 });
  writer.gap(6);
  writer.text(`#${report.rank} · ${s(report.keyword)}`, { size: 11, color: rgb(0.78, 0.83, 0.95) });

  writer.cursor = PAGE.height - 292;
  statRow(writer, [
    { label: strings.winRate, value: s(content.seedReturn?.winRate), color: GREEN },
    { label: strings.annualized, value: s(content.seedReturn?.annualizedBook) },
    { label: strings.plRatio, value: s(content.seedReturn?.profitLossRatio) },
    { label: strings.riskAdjusted, value: s(content.seedReturn?.riskAdjustedAnnualized), color: AMBER },
  ]);

  writer.heading(strings.sourceTrend);
  table(
    writer,
    [
      { header: strings.keyword, width: CONTENT_WIDTH * 0.34 },
      { header: strings.volume, width: CONTENT_WIDTH * 0.18, align: 'right' },
      { header: strings.category, width: CONTENT_WIDTH * 0.2 },
      { header: strings.window, width: CONTENT_WIDTH * 0.14 },
      { header: strings.region, width: CONTENT_WIDTH * 0.14 },
    ],
    [
      [
        s(report.keyword),
        Number(report.searchVolume || 0).toLocaleString('en-US'),
        s(report.category || '—'),
        s(report.timeRange || '—'),
        s(report.region || '—'),
      ],
    ]
  );

  writer.heading(strings.summary);
  writer.text(s(content.summary), { size: 10.5, color: rgb(0.23, 0.23, 0.25) });

  // --- Score matrix ------------------------------------------------------
  const opportunities: BpOpportunity[] = (report.opportunities?.length ? report.opportunities : content.opportunities) || [];
  if (opportunities.length > 0) {
    writer.heading(strings.scoreMatrix);
    const scoreKeys = ['market', 'roi', 'onlineability', 'feasibility', 'speed', 'moat'] as const;
    const nameWidth = CONTENT_WIDTH * 0.3;
    const numberWidth = (CONTENT_WIDTH - nameWidth) / (scoreKeys.length + 1);
    table(
      writer,
      [
        { header: strings.selected, width: nameWidth },
        ...scoreKeys.map((key) => ({ header: strings.scores[key], width: numberWidth, align: 'right' as const })),
        { header: strings.weighted, width: numberWidth, align: 'right' as const },
      ],
      opportunities.map((o) => [
        `${o.isSelected ? '★ ' : ''}${s(o.name)}`,
        ...scoreKeys.map((key) => String(o.scores?.[key] ?? '—')),
        String(o.weightedScore ?? '—'),
      ]),
      (i) => !!opportunities[i]?.isSelected
    );
  }

  // --- Selected opportunity ---------------------------------------------
  writer.heading(strings.selected);
  writer.text(s(content.selectedOpportunity), { size: 13, color: ACCENT, bold: true, lineHeight: 19 });
  const selected = opportunities.find((o) => o.isSelected);
  if (selected?.description) {
    writer.gap(4);
    writer.text(s(selected.description), { size: 10.5, color: rgb(0.23, 0.23, 0.25) });
  }

  // --- Market ------------------------------------------------------------
  writer.heading(strings.market);
  statRow(writer, [
    { label: strings.tam, value: s(content.market?.tam) },
    { label: strings.sam, value: s(content.market?.sam) },
    { label: strings.som, value: s(content.market?.som) },
  ]);
  if (content.market?.notes) {
    writer.text(s(content.market.notes), { size: 10, color: rgb(0.29, 0.29, 0.31) });
  }

  if (content.businessModel) {
    writer.heading(strings.businessModel);
    writer.text(s(content.businessModel), { size: 10.5, color: rgb(0.23, 0.23, 0.25) });
  }

  // --- Financials --------------------------------------------------------
  if (content.financials?.years?.length) {
    writer.heading(strings.financials);
    table(
      writer,
      [
        { header: strings.year, width: CONTENT_WIDTH * 0.2 },
        { header: strings.revenue, width: CONTENT_WIDTH * 0.4, align: 'right' },
        { header: strings.ebitda, width: CONTENT_WIDTH * 0.4, align: 'right' },
      ],
      content.financials.years.map((y) => [String(y.year), s(y.revenue || '—'), s(y.ebitda || '—')])
    );
  }

  // --- Seed return -------------------------------------------------------
  if (content.seedReturn) {
    writer.heading(strings.seedReturn);
    statRow(writer, [
      { label: strings.annualized, value: s(content.seedReturn.annualizedBook) },
      { label: strings.winRate, value: s(content.seedReturn.winRate), color: GREEN },
      { label: strings.plRatio, value: s(content.seedReturn.profitLossRatio) },
    ]);
    statRow(writer, [
      { label: strings.ev, value: s(content.seedReturn.expectedValueMOIC) },
      { label: strings.riskAdjusted, value: s(content.seedReturn.riskAdjustedAnnualized), color: AMBER },
    ]);
    const roi = content.seedReturn.bookRoiByYear || [];
    if (roi.length > 0) {
      writer.gap(8);
      table(
        writer,
        [
          { header: strings.roiByYear, width: CONTENT_WIDTH * 0.4 },
          ...roi.map((_, i) => ({
            header: `Y${i + 1}`,
            width: (CONTENT_WIDTH * 0.6) / roi.length,
            align: 'right' as const,
          })),
        ],
        [['ROI %', ...roi.map((v) => String(v))]]
      );
    }
    if (content.seedReturn.notes) {
      writer.text(s(content.seedReturn.notes), { size: 9.5, color: SUBTLE });
    }
  }

  // --- Disclaimer and licence -------------------------------------------
  writer.heading(strings.disclaimerTitle);
  writer.text(strings.disclaimer, { size: 9.5, color: SUBTLE, lineHeight: 15 });
  const stamp = [
    meta.buyerEmail ? `${strings.licensedTo} ${s(meta.buyerEmail)}` : '',
    meta.orderReference ? `#${s(meta.orderReference)}` : '',
    `${strings.generated}: ${new Date(report.createdAt).toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join('   ·   ');
  writer.gap(6);
  writer.text(stamp, { size: 8.5, color: SUBTLE, lineHeight: 13 });

  writer.finish();

  return { bytes: await doc.save(), missingGlyphs: [...missing] };
}

/** A filename a buyer can find again on their disk. */
export function pdfFilename(report: BpReport): string {
  const slug = (report.contentJson?.title || report.keyword || 'report')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const date = new Date(report.createdAt).toISOString().slice(0, 10);
  return `${slug || 'report'}-${date}.pdf`;
}

/**
 * `Content-Disposition` value that survives Chinese (and any non-ASCII) titles.
 *
 * HTTP header values are ByteStrings: a filename containing 付 (code point
 * 20184) throws in undici/Node before the PDF bytes ever leave the function —
 * which is exactly how a successfully rendered Chinese report came back as
 * `render_failed` while the English twin downloaded fine. The ASCII `filename`
 * is the fallback for old clients; `filename*` carries the real UTF-8 name.
 */
export function contentDisposition(filename: string): string {
  const ascii =
    filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'report.pdf';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
