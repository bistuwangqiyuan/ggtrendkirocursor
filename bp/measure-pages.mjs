// Measure each .page block height in print media to compute the true PDF page
// each logical section starts on (the deck reserves a 14mm footer margin).
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 240000, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulateMediaType('print');
await page.goto(pathToFileURL(join(__dirname, 'business-plan.html')).href, { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => { await Promise.all(Array.from(document.images).map(i => i.complete ? 0 : new Promise(r => i.onload = i.onerror = r))); });
try { await Promise.race([page.evaluate(() => document.fonts.ready), new Promise(r => setTimeout(r, 4000))]); } catch {}

const data = await page.evaluate(() => {
  // A4 at 96dpi = 1123px tall. Empirically (validated against the rendered PDF
  // page count) each .page is min-height:297mm and consumes one A4 page unless
  // its content grows beyond 1123px, in which case it spills to a 2nd page.
  const pageH = 1123;
  const els = Array.from(document.querySelectorAll('.page'));
  let startPage = 1;
  return els.map((e, i) => {
    const h = e.getBoundingClientRect().height;
    const pages = Math.max(1, Math.ceil((h - 4) / pageH));
    const head = e.querySelector('.sec-no');
    const title = e.querySelector('h2.sec');
    const rec = {
      block: i + 1,
      startPage,
      pages,
      h: Math.round(h),
      secNo: head ? head.textContent.trim() : (i === 0 ? 'COVER' : ''),
      title: title ? title.textContent.trim() : (i === 0 ? '封面' : ''),
    };
    startPage += pages;
    return rec;
  });
});

console.log('total computed pages:', data.reduce((a, r) => a + r.pages, 0));
for (const r of data) {
  console.log(`block ${String(r.block).padStart(2)} | pdfPage ${String(r.startPage).padStart(2)} | spans ${r.pages} | h=${r.h} | ${r.secNo} ${r.title}`);
}
await browser.close();
