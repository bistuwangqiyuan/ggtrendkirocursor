/**
 * Render public/og-image.png (1200x630) for social sharing cards.
 * SVG og:images are ignored by Facebook/Twitter/WeChat crawlers, so we render
 * a real PNG with headless Chromium. Re-run after changing the card design:
 *   node scripts/render-og-image.mjs
 */
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og-image.png');

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: linear-gradient(135deg, #0a0a0f 0%, #111827 100%);
    font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', Arial, sans-serif;
    color: #fff; position: relative;
  }
  .brand { position: absolute; top: 150px; left: 90px; display: flex; align-items: center; gap: 30px; }
  .logo {
    width: 86px; height: 86px; border-radius: 16px; background: #2563eb;
    display: flex; align-items: center; justify-content: center;
    font-size: 56px; font-weight: 800;
  }
  .name { font-size: 64px; font-weight: 800; }
  .headline { position: absolute; top: 315px; left: 90px; font-size: 46px; font-weight: 700; color: #e5e7eb; }
  .subhead { position: absolute; top: 385px; left: 90px; font-size: 30px; font-weight: 400; color: #9ca3af; max-width: 620px; }
  .bar { position: absolute; top: 470px; left: 90px; width: 380px; height: 8px; border-radius: 4px;
    background: linear-gradient(90deg, #3b82f6, #06b6d4); }
  .chart { position: absolute; top: 150px; left: 760px; width: 300px; height: 300px; opacity: 0.9; }
  .chart div { position: absolute; bottom: 0; width: 44px; border-radius: 6px; }
</style>
</head>
<body>
  <div class="brand">
    <div class="logo">T</div>
    <div class="name">Trend Now</div>
  </div>
  <div class="headline">从谷歌热搜到 AI 商业计划书</div>
  <div class="subhead">Real-time Google Trends · AI opportunity analysis · Business plans</div>
  <div class="bar"></div>
  <div class="chart">
    <div style="left:0;   height:120px; background:#1f2937"></div>
    <div style="left:64px; height:180px; background:#334155"></div>
    <div style="left:128px;height:240px; background:#3b82f6"></div>
    <div style="left:192px;height:280px; background:#06b6d4"></div>
    <div style="left:256px;height:210px; background:#334155"></div>
  </div>
</body>
</html>`;

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: outPath, type: 'png' });
  console.log('Wrote', outPath);
} finally {
  await browser.close();
}
