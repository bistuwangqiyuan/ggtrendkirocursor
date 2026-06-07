// Render bp/business-plan.html -> high-fidelity A4 PDF using Puppeteer (headless Chromium).
// Usage: node bp/render-pdf.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, 'business-plan.html');
const outPath = join(__dirname, '谷歌热词AI-BP生成网站_商业计划书.pdf');

if (!existsSync(htmlPath)) {
  console.error('找不到 business-plan.html：', htmlPath);
  process.exit(1);
}

const footer = `
  <div style="width:100%; font-size:8px; color:#9a9aa0; font-family:'Inter',sans-serif;
              padding:0 14mm; display:flex; justify-content:space-between; align-items:center;">
    <span>谷歌热词全自动 AI BP 生成网站 · 商业计划书（保密）</span>
    <span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span>
  </div>`;

const run = async () => {
  console.log('启动 Chromium…');
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    await page.emulateMediaType('print');

    const url = pathToFileURL(htmlPath).href;
    console.log('加载页面：', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等待本地图片加载完成（PDF 需要图片就绪）
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map((img) => img.complete ? Promise.resolve()
        : new Promise((res) => { img.onload = img.onerror = res; })));
    });
    // 字体就绪，最多等 4 秒，超时则用系统字体回退
    try {
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch {}
    await new Promise((r) => setTimeout(r, 500));

    console.log('渲染 PDF…');
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footer,
      margin: { top: '0mm', bottom: '14mm', left: '0mm', right: '0mm' },
    });

    const kb = (statSync(outPath).size / 1024).toFixed(0);
    console.log(`✔ 已生成 PDF：${outPath}（${kb} KB）`);
  } finally {
    await browser.close();
  }
};

run().catch((e) => { console.error('渲染失败：', e); process.exit(1); });
