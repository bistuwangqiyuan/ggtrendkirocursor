// QA: 截取每个 .page 的 A4 截图，便于肉眼校验排版/溢出/图片。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'assets', 'qa');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 240000, args: ['--no-sandbox'] });
const page = await browser.newPage();
// A4 @ 96dpi ≈ 794 x 1123 px
await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.4 });
await page.goto(pathToFileURL(join(__dirname, 'business-plan.html')).href, { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => { await Promise.all(Array.from(document.images).map(i => i.complete ? 0 : new Promise(r => i.onload = i.onerror = r))); });
try { await Promise.race([page.evaluate(() => document.fonts.ready), new Promise(r => setTimeout(r, 4000))]); } catch {}

const count = await page.$$eval('.page', els => els.length);
const overflow = await page.$$eval('.page', els => els.map((e, i) => ({ i: i + 1, oh: e.scrollHeight, ch: e.clientHeight, over: e.scrollHeight - e.clientHeight })).filter(x => x.over > 4));
console.log('页面块数(.page):', count);
console.log('可能溢出的页:', JSON.stringify(overflow));

const pick = [9, 13, 15, 19, 23];
const handles = await page.$$('.page');
for (const n of pick) {
  const h = handles[n - 1];
  if (!h) continue;
  await h.screenshot({ path: join(outDir, `page-${String(n).padStart(2, '0')}.png`) });
  console.log('截图:', `page-${n}.png`);
}
await browser.close();
console.log('完成。输出目录:', outDir);
