#!/usr/bin/env node
/**
 * Live smoke / end-to-end test harness for the deployed Trend Now site.
 *
 * Usage:
 *   BASE_URL=https://ggtrendkirocursor.netlify.app node tests/e2e/live-smoke.mjs
 *
 * Status legend per check:
 *   PASS    - feature verified working on the live deployment
 *   FAIL    - code-level defect (counts as a bug to fix)
 *   BLOCKED - cannot verify because an external dependency (Neon DB quota) is down
 *
 * Exit code is non-zero only when there is at least one FAIL, so DB-BLOCKED
 * items do not break the fix loop.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'https://ggtrendkirocursor.netlify.app').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 25000);

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
function record(req, name, status, detail) {
  results.push({ req, name, status, detail });
  const tag = status === 'PASS' ? 'PASS ' : status === 'FAIL' ? 'FAIL ' : 'BLOCK';
  console.log(`[${tag}] (${req}) ${name}${detail ? ' -> ' + detail : ''}`);
}

async function http(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Mirror a real browser: same-origin POST/PUT/etc. always send an Origin header,
  // which Astro's CSRF origin check requires.
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  if (method !== 'GET' && method !== 'HEAD' && !headers.Origin) headers.Origin = BASE_URL;
  try {
    const res = await fetch(BASE_URL + path, { redirect: 'manual', signal: controller.signal, ...opts, headers });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: '', error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function jsonOf(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function expect(cond, req, name, okDetail, failDetail) {
  if (cond) record(req, name, 'PASS', okDetail);
  else record(req, name, 'FAIL', failDetail);
  return cond;
}

let DB_UP = false;
let authCookie = '';

async function run() {
  console.log(`\n=== Trend Now live smoke test ===\nTarget: ${BASE_URL}\nTime:   ${new Date().toISOString()}\n`);

  // ---- Req 9/15: health + DB status ----
  const health = await http('/api/health');
  const healthJson = jsonOf(health.body);
  expect(health.status === 200 && !!healthJson, 'R15', 'health endpoint reachable',
    `status=${health.status} version=${healthJson?.version ?? 'n/a'}`,
    `status=${health.status} error=${health.error || 'no json'}`);
  if (healthJson) {
    DB_UP = healthJson?.database?.connected === true;
    record('R9', 'database connectivity', DB_UP ? 'PASS' : 'BLOCKED',
      DB_UP ? `tables=${healthJson.database.tableCount}` : `error=${healthJson?.database?.error || 'not connected'}`);
  }

  // ---- Req 2/7/13: homepage SSR ----
  const home = await http('/', { headers: { Cookie: 'locale=zh' } });
  expect(home.status === 200, 'R2', 'homepage returns 200', `status=${home.status}`, `status=${home.status}`);
  expect(/<html[^>]*lang=/.test(home.body), 'R5', 'homepage has html lang attribute', 'lang present', 'missing lang');
  expect(home.body.includes('data-page="marketing-home"') || home.body.includes('从热搜发现机会'),
    'R2', 'homepage SSR renders marketing landing (zh)', 'hero found', 'marketing hero missing');
  expect(home.body.includes('Trend Now'), 'R7', 'homepage renders header brand', 'brand found', 'brand missing');
  expect(home.body.includes('/privacy') && home.body.includes('/terms'), 'R7', 'homepage renders footer links', 'footer links found', 'footer links missing');
  expect(/<meta[^>]+name=["']viewport["']/.test(home.body), 'R6', 'homepage has responsive viewport meta', 'viewport present', 'viewport missing');

  // ---- Req 5: SEO meta / structured data ----
  expect(/<meta[^>]+name=["']description["']/.test(home.body), 'R5', 'has meta description', 'present', 'missing meta description');
  expect(/<title>[^<]*Trend Now[^<]*<\/title>/.test(home.body), 'R5', 'has title tag with brand', 'present', 'missing/short title');
  expect(/property=["']og:/.test(home.body), 'R5', 'has Open Graph tags', 'og tags present', 'no og: tags');
  expect(/application\/ld\+json/.test(home.body), 'R5', 'has JSON-LD structured data', 'json-ld present', 'no JSON-LD');
  expect(/<link[^>]+rel=["']canonical["']/.test(home.body), 'R5', 'has canonical link', 'canonical present', 'no canonical');

  // ---- Req 4: i18n ----
  // Use the <title> tag (locale-specific) to avoid matching the bilingual keywords meta tag.
  const homeEn = await http('/', { headers: { Cookie: 'locale=en' } });
  expect(homeEn.status === 200 && homeEn.body.includes('<title>Home | Trend Now</title>'),
    'R4', 'english locale renders english UI', 'en title rendered',
    `status=${homeEn.status} titleEn=${homeEn.body.includes('<title>Home | Trend Now</title>')}`);
  expect(home.body.includes('<title>首页 | Trend Now</title>') && home.body.includes('首页'),
    'R4', 'chinese locale renders chinese UI', 'zh title + nav found', 'zh title/nav missing');

  // ---- Req 7: static pages ----
  const staticPages = [
    ['/about', '关于我们', 'R7'],
    ['/contact', '联系我们', 'R8'],
    ['/privacy', null, 'R7'],
    ['/terms', null, 'R7'],
    ['/login', null, 'R1'],
    ['/register', null, 'R1'],
  ];
  for (const [path, mustContain, req] of staticPages) {
    const r = await http(path, { headers: { Cookie: 'locale=zh' } });
    const ok = r.status === 200 && (!mustContain || r.body.includes(mustContain));
    expect(ok, req, `static page ${path} loads`, `status=${r.status}`, `status=${r.status} contains=${mustContain ? r.body.includes(mustContain) : 'n/a'}`);
  }

  // ---- Req 8: contact email is shown ----
  const contactPage = await http('/contact', { headers: { Cookie: 'locale=zh' } });
  expect(contactPage.status === 200 && contactPage.body.includes('13426086861@139.com'),
    'R8', 'contact page shows real email', 'email present',
    `status=${contactPage.status} hasEmail=${contactPage.body.includes('13426086861@139.com')}`);

  // ---- Req 5: crawler assets (robots / sitemap / og image) ----
  const robots = await http('/robots.txt');
  expect(robots.status === 200 && /sitemap/i.test(robots.body), 'R5', 'robots.txt served with sitemap', `status=${robots.status}`, `status=${robots.status}`);
  const sitemap = await http('/sitemap.xml');
  expect(sitemap.status === 200 && sitemap.body.includes('<urlset'), 'R5', 'sitemap.xml served', `status=${sitemap.status}`, `status=${sitemap.status}`);
  const ogImg = await http('/og-image.png');
  expect(ogImg.status === 200, 'R5', 'og:image asset resolves (not 404)', `status=${ogImg.status}`, `status=${ogImg.status}`);

  // ---- Req 11: /error page renders ----
  const errPage = await http('/error', { headers: { Cookie: 'locale=zh' } });
  expect(errPage.status === 200 && errPage.body.includes('Trend Now'), 'R11', '/error page renders', `status=${errPage.status}`, `status=${errPage.status}`);

  // ---- Req 11: 404 handling ----
  const notFound = await http('/this-page-does-not-exist-xyz', { headers: { Cookie: 'locale=zh' } });
  expect(notFound.status === 404, 'R11', '404 page returns 404 status', `status=${notFound.status}`, `status=${notFound.status}`);
  expect(notFound.body.includes('404') || notFound.body.includes('Not Found'), 'R11', '404 page shows not-found content', 'content ok', 'no 404 content');

  // ---- Req 1/8/11: API input validation (no DB needed) ----
  const regMissing = await http('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  expect(regMissing.status === 400, 'R1', 'register rejects missing fields (400)', `status=${regMissing.status}`, `status=${regMissing.status}`);

  const regInvalid = await http('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ab', email: 'bad', password: 'short' }) });
  expect(regInvalid.status === 400, 'R1', 'register rejects invalid input (400)', `status=${regInvalid.status}`, `status=${regInvalid.status}`);

  const loginMissing = await http('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  expect(loginMissing.status === 400, 'R1', 'login rejects missing fields (400)', `status=${loginMissing.status}`, `status=${loginMissing.status}`);

  const fbInvalid = await http('/api/feedback/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', email: 'bad', subject: '', message: '' }) });
  const fbJson = jsonOf(fbInvalid.body);
  expect(fbInvalid.status === 400 && !!fbJson?.validationErrors, 'R8', 'feedback rejects invalid input with field errors', `status=${fbInvalid.status}`, `status=${fbInvalid.status} hasErrors=${!!fbJson?.validationErrors}`);

  const logoutNoSession = await http('/api/auth/logout', { method: 'POST' });
  expect(logoutNoSession.status === 200, 'R1', 'logout without session returns 200', `status=${logoutNoSession.status}`, `status=${logoutNoSession.status}`);

  // ---- Req 2/3: trends API (DB dependent) ----
  const trends = await http('/api/trends/list?timeRange=4h&page=1');
  const trendsJson = jsonOf(trends.body);
  if (DB_UP) {
    expect(trends.status === 200 && trendsJson?.success === true && Array.isArray(trendsJson?.data?.trends),
      'R2', 'trends list API returns data', `count=${trendsJson?.data?.trends?.length}`,
      `status=${trends.status} success=${trendsJson?.success}`);
    expect((trendsJson?.data?.trends?.length || 0) > 0, 'R2', 'trends list has rows', `count=${trendsJson?.data?.trends?.length}`, 'empty result set');
    // sorting / pagination shape
    expect(!!trendsJson?.data?.pagination && typeof trendsJson.data.pagination.totalItems === 'number',
      'R13', 'trends pagination metadata present', 'pagination ok', 'no pagination metadata');
    // filtering by category
    const cat = await http('/api/trends/list?category=technology');
    const catJson = jsonOf(cat.body);
    expect(cat.status === 200 && catJson?.success === true, 'R3', 'category filter query works', `count=${catJson?.data?.trends?.length}`, `status=${cat.status}`);

    // ---- Req 3: data-collection-time range filter (collectedWithin) ----
    // Each window filters on the collection timestamp column. Counts must be
    // monotonically non-decreasing (6h <= 12h <= 24h <= 48h <= total) and the
    // queries must all succeed. (6h/12h may be 0 depending on data freshness.)
    const windows = ['6h', '12h', '24h', '48h'];
    const counts = {};
    let allSucceeded = true;
    for (const w of windows) {
      const r = await http(`/api/trends/list?collectedWithin=${w}&pageSize=100`);
      const j = jsonOf(r.body);
      if (!(r.status === 200 && j?.success === true && Array.isArray(j?.data?.trends))) {
        allSucceeded = false;
        counts[w] = `ERR(status=${r.status})`;
      } else {
        counts[w] = j.data.pagination?.totalItems ?? j.data.trends.length;
      }
    }
    const countsLabel = windows.map((w) => `${w}=${counts[w]}`).join(' ');
    expect(allSucceeded, 'R3', 'collectedWithin queries all succeed', countsLabel, countsLabel);

    const monotonic = allSucceeded
      && counts['6h'] <= counts['12h']
      && counts['12h'] <= counts['24h']
      && counts['24h'] <= counts['48h'];
    expect(monotonic, 'R3', 'collectedWithin counts are monotonic (6h<=12h<=24h<=48h)', countsLabel, countsLabel);

    // 48h is the widest collection window; against the current dataset it should return rows.
    expect(allSucceeded && counts['48h'] > 0, 'R3', 'collectedWithin=48h returns rows', `48h=${counts['48h']}`, `48h=${counts['48h']}`);
  } else {
    record('R2', 'trends list API returns data', 'BLOCKED', 'DB down (Neon quota)');
    record('R2', 'trends list has rows', 'BLOCKED', 'DB down (Neon quota)');
    record('R3', 'filter/sort/pagination results', 'BLOCKED', 'DB down (Neon quota)');
    record('R13', 'trends data formatting', 'BLOCKED', 'DB down (Neon quota)');
  }

  // ---- Req COL: trends RSS collector endpoint is auth-gated (fail closed) ----
  // Must never collect without a valid CRON_SECRET. 401 (secret set) or 503
  // (secret unset) are both acceptable; a 200 here would be a security bug.
  const collectNoAuth = await http('/api/trends/collect', { method: 'POST' });
  expect(collectNoAuth.status === 401 || collectNoAuth.status === 503,
    'R-COL1', 'POST /api/trends/collect rejects unauthenticated calls',
    `status=${collectNoAuth.status}`, `status=${collectNoAuth.status}`);
  const collectBadAuth = await http('/api/trends/collect', { method: 'POST', headers: { Authorization: 'Bearer wrong-secret' } });
  expect(collectBadAuth.status === 401 || collectBadAuth.status === 503,
    'R-COL1', 'POST /api/trends/collect rejects a bad secret',
    `status=${collectBadAuth.status}`, `status=${collectBadAuth.status}`);

  // ---- Req SEC: ops endpoints no longer accept the retired hard-coded secret ----
  // /api/db-init and /api/seed must reject the old published literal. 401
  // (env secret set) or 503 (fail-closed, no secret configured) are acceptable.
  const dbInitOldSecret = await http('/api/db-init?secret=trendnow-seed', { method: 'POST' });
  expect(dbInitOldSecret.status === 401 || dbInitOldSecret.status === 503,
    'R-SEC1', 'POST /api/db-init rejects the retired hard-coded secret',
    `status=${dbInitOldSecret.status}`, `status=${dbInitOldSecret.status}`);
  const seedOldSecret = await http('/api/seed?secret=trendnow-seed', { method: 'POST' });
  expect(seedOldSecret.status === 401 || seedOldSecret.status === 503,
    'R-SEC1', 'POST /api/seed rejects the retired hard-coded secret',
    `status=${seedOldSecret.status}`, `status=${seedOldSecret.status}`);

  // ---- Req 1/12: auth round-trip (DB dependent) ----
  if (DB_UP) {
    const uniq = Date.now();
    const cred = { username: `e2e_${uniq}`.slice(0, 20), email: `e2e_${uniq}@example.com`, password: 'TestPass123' };
    const reg = await http('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cred) });
    expect(reg.status === 201, 'R1', 'register creates user', `status=${reg.status}`, `status=${reg.status} body=${reg.body.slice(0, 120)}`);
    const login = await http('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cred.email, password: cred.password }) });
    const setCookie = login.headers.get('set-cookie') || '';
    expect(login.status === 200, 'R1', 'login succeeds with valid creds', `status=${login.status}`, `status=${login.status}`);
    expect(/httponly/i.test(setCookie), 'R12', 'session cookie is HttpOnly', 'httponly set', `set-cookie=${setCookie.slice(0, 80)}`);
    authCookie = (setCookie.match(/session_token=[^;]+/) || [''])[0];
    const badLogin = await http('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cred.email, password: 'WrongPass123' }) });
    expect(badLogin.status === 401, 'R1', 'login rejects wrong password (401)', `status=${badLogin.status}`, `status=${badLogin.status}`);
    const fb = await http('/api/feedback/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E Tester', email: 'e2e@example.com', subject: 'Automated test', message: 'This is an automated end-to-end feedback test message.' }) });
    expect(fb.status === 201, 'R8', 'feedback persists to DB', `status=${fb.status}`, `status=${fb.status}`);
  } else {
    record('R1', 'register/login round-trip', 'BLOCKED', 'DB down (Neon quota)');
    record('R12', 'session cookie security flags', 'BLOCKED', 'DB down (Neon quota)');
    record('R8', 'feedback persistence', 'BLOCKED', 'DB down (Neon quota)');
  }

  // ---- Hot word -> BP feature ----
  // List is public: must return 200 with paginated shape regardless of DB rows.
  const bpList = await http('/api/bp/list?page=1&pageSize=5');
  const bpListJson = jsonOf(bpList.body);
  if (DB_UP) {
    expect(bpList.status === 200 && bpListJson?.success === true && Array.isArray(bpListJson?.data?.reports),
      'R7', 'bp list API returns paginated reports', `count=${bpListJson?.data?.reports?.length}`,
      `status=${bpList.status} success=${bpListJson?.success}`);
  } else {
    record('R7', 'bp list API returns paginated reports', 'BLOCKED', 'DB down (Neon quota)');
  }

  // Unknown (well-formed) id returns 404, not 500.
  const bpMissing = await http('/api/bp/00000000-0000-0000-0000-000000000000');
  if (DB_UP) {
    expect(bpMissing.status === 404, 'R7', 'bp detail API returns 404 for unknown id', `status=${bpMissing.status}`, `status=${bpMissing.status}`);
  } else {
    record('R7', 'bp detail API returns 404 for unknown id', 'BLOCKED', 'DB down (Neon quota)');
  }

  // Generation requires auth: guest POST must be rejected with 401.
  const bpGenGuest = await http('/api/bp/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  expect(bpGenGuest.status === 401, 'R1', 'bp generate rejects guests (401)', `status=${bpGenGuest.status}`, `status=${bpGenGuest.status}`);

  // ---- BP scheduled auto-generation (cron) ----
  // R-BP1: /bp list page renders via SSR (DB-independent shell).
  const bpPage = await http('/bp', { headers: { Cookie: 'locale=zh' } });
  expect(bpPage.status === 200 && (bpPage.body.includes('历史商业计划书') || bpPage.body.includes('商业计划书')),
    'R-BP1', '/bp list page renders (SSR)', `status=${bpPage.status}`,
    `status=${bpPage.status}`);

  // R-BP16: /bp list sortable by risk-adjusted annualized (page + API).
  const bpSorted = await http('/bp?sort=riskAdjusted&order=desc', { headers: { Cookie: 'locale=zh' } });
  expect(bpSorted.status === 200 && bpSorted.body.includes('sort-risk-adjusted') && bpSorted.body.includes('风险调整年化'),
    'R-BP16', '/bp sorts by risk-adjusted annualized', `status=${bpSorted.status}`,
    `status=${bpSorted.status} marker=${bpSorted.body.includes('sort-risk-adjusted')}`);
  const bpListApiSorted = await http('/api/bp/list?sort=riskAdjusted&order=asc&pageSize=5');
  const bpListSortedJson = jsonOf(bpListApiSorted.body);
  expect(bpListApiSorted.status === 200 && bpListSortedJson?.success === true && Array.isArray(bpListSortedJson?.data?.reports),
    'R-BP16', 'bp list API accepts riskAdjusted sort', `count=${bpListSortedJson?.data?.reports?.length}`,
    `status=${bpListApiSorted.status}`);

  // R-BP2: header exposes the BP nav link.
  expect(home.body.includes('/bp') && (home.body.includes('商业计划书') || home.body.includes('Business Plans')),
    'R-BP2', 'header exposes BP nav link', 'nav present', 'nav missing');

  // R-BP3: /trends dashboard shows the generate-BP CTA when trend data is present.
  const trendsPage = await http('/trends', { headers: { Cookie: 'locale=zh' } });
  expect(trendsPage.status === 200 && trendsPage.body.includes('data-page="trends"'),
    'R-SITE1', '/trends dashboard renders', `status=${trendsPage.status}`, `status=${trendsPage.status}`);
  if (DB_UP) {
    expect(trendsPage.body.includes('generate-bp-btn') || trendsPage.body.includes('一键生成商业计划书'),
      'R-BP3', '/trends shows generate-BP CTA', 'cta present',
      'cta missing (no top trend?)');
  } else {
    record('R-BP3', '/trends shows generate-BP CTA', 'BLOCKED', 'DB down (Neon quota)');
  }

  // ---- Marketing site pages (zh + en) ----
  const marketingPages = [
    ['/product', 'data-page="product"', 'R-SITE2'],
    ['/pricing', 'data-page="pricing"', 'R-SITE3'],
    ['/faq', 'data-page="faq"', 'R-SITE4'],
  ];
  for (const [path, marker, req] of marketingPages) {
    const rZh = await http(path, { headers: { Cookie: 'locale=zh' } });
    expect(rZh.status === 200 && rZh.body.includes(marker), req, `${path} renders (zh)`, `status=${rZh.status}`, `status=${rZh.status}`);
    const rEn = await http(path, { headers: { Cookie: 'locale=en' } });
    expect(rEn.status === 200 && rEn.body.includes(marker), req, `${path} renders (en)`, `status=${rEn.status}`, `status=${rEn.status}`);
  }

  // Pricing tiers match deck numbers
  const pricingZh = await http('/pricing', { headers: { Cookie: 'locale=zh' } });
  expect(pricingZh.body.includes('¥99') && pricingZh.body.includes('¥299') && pricingZh.body.includes('¥39'),
    'R-SITE5', 'pricing page shows deck tier prices', 'prices present', 'pricing tiers missing');

  // Legal pages have fixed last-updated (not dynamic today-only)
  const privacyZh = await http('/privacy', { headers: { Cookie: 'locale=zh' } });
  expect(privacyZh.body.includes('2026年6月10日') && privacyZh.body.includes('data-page="privacy"'),
    'R-SITE6', 'privacy policy has fixed date + sections (zh)', 'ok', 'privacy incomplete');
  const termsEn = await http('/terms', { headers: { Cookie: 'locale=en' } });
  expect(termsEn.body.includes('June 10, 2026') && termsEn.body.includes('data-page="terms"'),
    'R-SITE7', 'terms has fixed date + sections (en)', 'ok', 'terms incomplete');

  // Removed Netlify starter demos return 404
  const edgeDemo = await http('/edge');
  expect(edgeDemo.status === 404, 'R-SITE8', '/edge starter removed (404)', `status=${edgeDemo.status}`, `status=${edgeDemo.status}`);
  const blobsDemo = await http('/blobs');
  expect(blobsDemo.status === 404, 'R-SITE9', '/blobs starter removed (404)', `status=${blobsDemo.status}`, `status=${blobsDemo.status}`);

  // Sitemap includes new routes
  expect(sitemap.body.includes('/trends') && sitemap.body.includes('/product') && sitemap.body.includes('/pricing') && sitemap.body.includes('/faq') && sitemap.body.includes('/bp'),
    'R-SITE10', 'sitemap lists marketing + product routes', 'routes present', 'sitemap stale');

  // Mobile menu toggle present in header
  expect(home.body.includes('mobile-menu-btn') && home.body.includes('mobile-menu'),
    'R-SITE11', 'header has mobile navigation', 'mobile nav present', 'mobile nav missing');

  // Hero marker on marketing homepage
  expect(home.body.includes('data-testid="hero-headline"'),
    'R-SITE12', 'marketing homepage hero marker', 'hero present', 'hero missing');

  // Nav includes Product and Pricing links
  expect(home.body.includes('/product') && home.body.includes('/pricing') && home.body.includes('/trends'),
    'R-SITE13', 'nav includes product/pricing/trends links', 'links present', 'nav links missing');


  // ---- Hotword SEO landing pages (/t) ----
  // R-LAND1: index page renders (DB-independent shell).
  const landIndex = await http('/t', { headers: { Cookie: 'locale=zh' } });
  expect(landIndex.status === 200 && landIndex.body.includes('data-page="landing-index"'),
    'R-LAND1', '/t landing index renders', `status=${landIndex.status}`, `status=${landIndex.status}`);

  // R-LAND2: a real keyword landing page renders with SEO structured data.
  if (DB_UP) {
    const anyTrend = jsonOf((await http('/api/trends/list?pageSize=1')).body);
    const kw = anyTrend?.data?.trends?.[0]?.keyword;
    if (kw) {
      const slug = kw.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
      const landPage = await http(`/t/${encodeURIComponent(slug)}`, { headers: { Cookie: 'locale=zh' } });
      const hasPage = landPage.status === 200 && landPage.body.includes('data-page="landing-keyword"');
      const hasFaqLd = landPage.body.includes('FAQPage') && landPage.body.includes('BreadcrumbList');
      const hasBpSection = landPage.body.includes('landing-bp-section');
      expect(hasPage && hasFaqLd && hasBpSection,
        'R-LAND2', 'keyword landing page renders with JSON-LD + BP section',
        `slug=${slug}`, `status=${landPage.status} page=${hasPage} ld=${hasFaqLd} bp=${hasBpSection}`);
    } else {
      record('R-LAND2', 'keyword landing page renders with JSON-LD + BP section', 'BLOCKED', 'no trends rows');
    }
  } else {
    record('R-LAND2', 'keyword landing page renders with JSON-LD + BP section', 'BLOCKED', 'DB down (Neon quota)');
  }

  // R-LAND3: unknown slug returns 404, not 500.
  const landMissing = await http('/t/this-slug-does-not-exist-xyz-123');
  expect(landMissing.status === 404, 'R-LAND3', 'unknown landing slug returns 404', `status=${landMissing.status}`, `status=${landMissing.status}`);

  // R-LAND4: sitemap includes the /t index route.
  expect(sitemap.body.includes('/t</loc>') || sitemap.body.includes('/t<'),
    'R-LAND4', 'sitemap lists /t landing index', 'listed', 'missing /t');

  // ---- Site monitoring system (/monitor) ----
  // R-MON1: dashboard page renders.
  const monPage = await http('/monitor', { headers: { Cookie: 'locale=zh' } });
  expect(monPage.status === 200 && monPage.body.includes('data-page="monitor"'),
    'R-MON1', '/monitor dashboard renders', `status=${monPage.status}`, `status=${monPage.status}`);

  // R-MON2: public GET lists sites (shape check).
  const monList = await http('/api/monitor/sites');
  const monListJson = jsonOf(monList.body);
  if (DB_UP) {
    expect(monList.status === 200 && monListJson?.success === true && Array.isArray(monListJson?.data?.sites),
      'R-MON2', 'monitor sites API returns list', `count=${monListJson?.data?.sites?.length}`,
      `status=${monList.status} success=${monListJson?.success}`);
  } else {
    record('R-MON2', 'monitor sites API returns list', 'BLOCKED', 'DB down (Neon quota)');
  }

  // R-MON3: mutating endpoints are admin-gated (fail closed).
  const monAddNoAuth = await http('/api/monitor/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', url: 'https://example.com' }) });
  expect(monAddNoAuth.status === 401 || monAddNoAuth.status === 503,
    'R-MON3', 'monitor site registration rejects unauthenticated calls',
    `status=${monAddNoAuth.status}`, `status=${monAddNoAuth.status}`);
  const monRunNoAuth = await http('/api/monitor/run', { method: 'POST' });
  expect(monRunNoAuth.status === 401 || monRunNoAuth.status === 503,
    'R-MON3', 'monitor run rejects unauthenticated calls',
    `status=${monRunNoAuth.status}`, `status=${monRunNoAuth.status}`);

  // R-MON4: full authenticated round-trip — register a site, run checks, read
  // the result back, then clean up. Uses this site itself as the probe target.
  if (process.env.E2E_CRON_SECRET && DB_UP) {
    const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` };
    const add = await http('/api/monitor/sites', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Trend Now (self)', url: BASE_URL }) });
    const addJson = jsonOf(add.body);
    const siteId = addJson?.data?.site?.id;
    expect(add.status === 201 && !!siteId, 'R-MON4', 'admin registers a monitored site', `id=${siteId}`, `status=${add.status} body=${add.body.slice(0, 120)}`);

    if (siteId) {
      const run = await http('/api/monitor/run', { method: 'POST', headers: adminHeaders });
      const runJson = jsonOf(run.body);
      expect(run.status === 200 && runJson?.success === true && runJson?.checked >= 1,
        'R-MON4', 'monitor run probes registered sites', `checked=${runJson?.checked} up=${runJson?.up}`,
        `status=${run.status} body=${run.body.slice(0, 160)}`);

      const after = jsonOf((await http('/api/monitor/sites')).body);
      const self = after?.data?.sites?.find((s) => s.id === siteId);
      expect(!!self?.lastCheck && typeof self.lastCheck.seoScore === 'number' && self.lastCheck.seoScore >= 50,
        'R-MON4', 'self-probe stores an SEO score >= 50', `score=${self?.lastCheck?.seoScore} ok=${self?.lastCheck?.ok}`,
        `lastCheck=${JSON.stringify(self?.lastCheck ?? null).slice(0, 160)}`);

      // Invalid URL rejected.
      const badAdd = await http('/api/monitor/sites', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'bad', url: 'not-a-url' }) });
      expect(badAdd.status === 400, 'R-MON5', 'monitor rejects invalid site URL', `status=${badAdd.status}`, `status=${badAdd.status}`);

      // Cleanup so repeated runs stay idempotent.
      const del = await http(`/api/monitor/sites?id=${siteId}`, { method: 'DELETE', headers: adminHeaders });
      expect(del.status === 200, 'R-MON4', 'admin removes the monitored site', `status=${del.status}`, `status=${del.status}`);
    }
  } else {
    const reason = !process.env.E2E_CRON_SECRET ? 'E2E_CRON_SECRET not set' : 'DB down (Neon quota)';
    record('R-MON4', 'monitor register/run/read round-trip', 'BLOCKED', reason);
    record('R-MON5', 'monitor rejects invalid site URL', 'BLOCKED', reason);
  }

  // R-BP4: cron without secret must be rejected (401 when secret configured, 503 when not).
  const cronNoAuth = await http('/api/bp/cron', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  expect(cronNoAuth.status === 401 || cronNoAuth.status === 503,
    'R-BP4', 'cron rejects unauthenticated call', `status=${cronNoAuth.status}`,
    `status=${cronNoAuth.status} (expected 401/503)`);

  // R-BP5: cron with a wrong secret must never be accepted.
  const cronBadAuth = await http('/api/bp/cron', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret-xyz' } });
  expect(cronBadAuth.status === 401 || cronBadAuth.status === 503,
    'R-BP5', 'cron rejects wrong secret', `status=${cronBadAuth.status}`,
    `status=${cronBadAuth.status} (expected 401/503)`);

  // R-BP6: bp tables exist (via health table list, if exposed).
  if (DB_UP) {
    const hasBpTables = Array.isArray(healthJson?.database?.tables)
      ? healthJson.database.tables.includes('bp_reports')
      : null;
    if (hasBpTables === null) {
      record('R-BP6', 'bp_reports table provisioned', 'BLOCKED', 'health does not list tables');
    } else {
      expect(hasBpTables, 'R-BP6', 'bp_reports table provisioned', 'table present',
        'bp_reports missing — run /api/db-init');
    }
  } else {
    record('R-BP6', 'bp_reports table provisioned', 'BLOCKED', 'DB down (Neon quota)');
  }

  // R-BP12: LLM rotation health endpoint is reachable and reports endpoints.
  const llmHealth = await http('/api/llm/health');
  const llmHealthJson = jsonOf(llmHealth.body);
  expect(llmHealth.status === 200 && llmHealthJson?.success === true && typeof llmHealthJson?.count === 'number',
    'R-BP12', 'LLM health endpoint reports rotation', `configured=${llmHealthJson?.configured} count=${llmHealthJson?.count}`,
    `status=${llmHealth.status}`);

  // R-BP14: guest access to the gated flagship deck must redirect to /login.
  const flagshipGuest = await http('/business-plan', { headers: { Cookie: 'locale=zh' } });
  const guestLoc = flagshipGuest.headers.get('location') || '';
  expect([301, 302, 307, 308].includes(flagshipGuest.status) && /\/login/.test(guestLoc),
    'R-BP14', 'guest /business-plan redirects to login', `status=${flagshipGuest.status} -> ${guestLoc}`,
    `status=${flagshipGuest.status} location=${guestLoc}`);

  // R-BP15: authenticated access returns the deck (200) with the 3-stage closed-loop narrative.
  if (DB_UP && authCookie) {
    const flagshipAuth = await http('/business-plan', { headers: { Cookie: `${authCookie}; locale=zh` } });
    const hasDeck = flagshipAuth.body.includes('谷歌热词全自动') && flagshipAuth.body.includes('商业计划书');
    const hasLoop = flagshipAuth.body.includes('AI 自动建站')
      || flagshipAuth.body.includes('商业闭环')
      || flagshipAuth.body.includes('Stage 3');
    const hasToolbar = flagshipAuth.body.includes('bp-toolbar');
    expect(flagshipAuth.status === 200 && hasDeck && hasLoop && hasToolbar,
      'R-BP15', 'authed /business-plan serves closed-loop deck', `deck=${hasDeck} loop=${hasLoop} toolbar=${hasToolbar}`,
      `status=${flagshipAuth.status} deck=${hasDeck} loop=${hasLoop} toolbar=${hasToolbar}`);
  } else {
    record('R-BP15', 'authed /business-plan serves closed-loop deck', 'BLOCKED',
      !authCookie ? 'no auth cookie (login blocked)' : 'DB down (Neon quota)');
  }

  // R-COL2: authenticated collector run (only with E2E_CRON_SECRET). The RSS
  // collector spends ZERO LLM tokens, so it is safe to actually trigger. After
  // it runs, fresh rows should exist within the 48h collection window.
  const E2E_CRON_SECRET = process.env.E2E_CRON_SECRET;
  if (E2E_CRON_SECRET && DB_UP) {
    const collect = await http('/api/trends/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E2E_CRON_SECRET}` },
    });
    const collectJson = jsonOf(collect.body);
    expect(collect.status === 200 && collectJson?.success === true && typeof collectJson?.inserted === 'number',
      'R-COL2', 'authenticated collector run succeeds',
      `inserted=${collectJson?.inserted} skipped=${collectJson?.skipped}`,
      `status=${collect.status}`);

    const fresh = await http('/api/trends/list?collectedWithin=48h&pageSize=100');
    const freshJson = jsonOf(fresh.body);
    expect(fresh.status === 200 && (freshJson?.data?.trends?.length || 0) > 0,
      'R-COL2', 'collected rows are visible within 48h window',
      `count=${freshJson?.data?.trends?.length}`, `count=${freshJson?.data?.trends?.length}`);
  } else {
    const reason = !E2E_CRON_SECRET ? 'E2E_CRON_SECRET not set' : 'DB down (Neon quota)';
    record('R-COL2', 'authenticated collector run succeeds', 'BLOCKED', reason);
  }

  // R-BP7/8/9: authenticated cron run (only when E2E_CRON_SECRET is provided).
  if (E2E_CRON_SECRET && DB_UP) {
    const cron = await http('/api/bp/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E2E_CRON_SECRET}` },
    });
    const cronJson = jsonOf(cron.body);
    const validAction = ['generated', 'skipped'].includes(cronJson?.action);
    // 200 = success; 503 = LLM not configured (acceptable infra gap, not a code fault).
    if (cron.status === 503) {
      record('R-BP7', 'authenticated cron triggers generation', 'BLOCKED', 'LLM not configured (503)');
      record('R-BP8', 'cron persists a BP report', 'BLOCKED', 'LLM not configured (503)');
      record('R-BP9', 'generated BP detail renders', 'BLOCKED', 'LLM not configured (503)');
      record('R-BP10', 'report has Export-PDF + print styles', 'BLOCKED', 'LLM not configured (503)');
      record('R-BP11', 'summary states seed-round return figures', 'BLOCKED', 'LLM not configured (503)');
      record('R-BP13', 'score matrix has ranked opportunities', 'BLOCKED', 'LLM not configured (503)');
    } else {
      expect(cron.status === 200 && cronJson?.success === true && validAction,
        'R-BP7', 'authenticated cron triggers generation', `action=${cronJson?.action}`,
        `status=${cron.status} action=${cronJson?.action}`);

      // R-BP8: the report id from cron should be retrievable.
      if (cron.status === 200 && cronJson?.reportId) {
        const detail = await http(`/api/bp/${cronJson.reportId}`);
        const detailJson = jsonOf(detail.body);
        expect(detail.status === 200 && detailJson?.success === true && detailJson?.data?.id === cronJson.reportId,
          'R-BP8', 'cron persists a BP report', `id=${cronJson.reportId} status=${detailJson?.data?.status}`,
          `status=${detail.status}`);

        // R-BP9: detail page SSR renders for a completed report.
        if (detailJson?.data?.status === 'completed') {
          const detailPage = await http(`/bp/${cronJson.reportId}`, { headers: { Cookie: 'locale=zh' } });
          expect(detailPage.status === 200 && detailPage.body.includes('执行摘要'),
            'R-BP9', 'generated BP detail renders', `status=${detailPage.status}`,
            `status=${detailPage.status}`);

          // R-BP10: report exposes an Export-PDF control + print styles (Apple report shell).
          const hasExport = detailPage.body.includes('bp-export-pdf');
          const hasPrintCss = detailPage.body.includes('@media print') && detailPage.body.includes('bp-report');
          expect(detailPage.status === 200 && hasExport && hasPrintCss,
            'R-BP10', 'report has Export-PDF + print styles', 'export+print present',
            `export=${hasExport} print=${hasPrintCss}`);

          // R-BP11: executive summary states seed-round returns (contains percentage figures).
          const summary = String(detailJson?.data?.contentJson?.summary || '');
          const hasPct = /\d+(?:\.\d+)?\s*%/.test(summary);
          expect(summary.length > 0 && hasPct,
            'R-BP11', 'summary states seed-round return figures', `len=${summary.length} hasPct=${hasPct}`,
            `len=${summary.length} hasPct=${hasPct}`);

          // R-BP13: opportunity score matrix is populated (>= 5 ranked opportunities).
          const opps = Array.isArray(detailJson?.data?.opportunities) ? detailJson.data.opportunities : [];
          const hasSelected = opps.some((o) => o.isSelected);
          expect(opps.length >= 5 && hasSelected,
            'R-BP13', 'score matrix has ranked opportunities', `count=${opps.length} selected=${hasSelected}`,
            `count=${opps.length} selected=${hasSelected}`);
        } else {
          record('R-BP9', 'generated BP detail renders', 'BLOCKED', `report status=${detailJson?.data?.status}`);
          record('R-BP10', 'report has Export-PDF + print styles', 'BLOCKED', `report status=${detailJson?.data?.status}`);
          record('R-BP11', 'summary states seed-round return figures', 'BLOCKED', `report status=${detailJson?.data?.status}`);
          record('R-BP13', 'score matrix has ranked opportunities', 'BLOCKED', `report status=${detailJson?.data?.status}`);
        }
      } else {
        record('R-BP8', 'cron persists a BP report', 'BLOCKED', `action=${cronJson?.action} (no reportId)`);
        record('R-BP9', 'generated BP detail renders', 'BLOCKED', 'no report to render');
        record('R-BP10', 'report has Export-PDF + print styles', 'BLOCKED', 'no report to render');
        record('R-BP11', 'summary states seed-round return figures', 'BLOCKED', 'no report to render');
        record('R-BP13', 'score matrix has ranked opportunities', 'BLOCKED', 'no report to render');
      }
    }
  } else {
    const reason = !E2E_CRON_SECRET ? 'E2E_CRON_SECRET not set' : 'DB down (Neon quota)';
    record('R-BP7', 'authenticated cron triggers generation', 'BLOCKED', reason);
    record('R-BP8', 'cron persists a BP report', 'BLOCKED', reason);
    record('R-BP9', 'generated BP detail renders', 'BLOCKED', reason);
    record('R-BP10', 'report has Export-PDF + print styles', 'BLOCKED', reason);
    record('R-BP11', 'summary states seed-round return figures', 'BLOCKED', reason);
    record('R-BP13', 'score matrix has ranked opportunities', 'BLOCKED', reason);
  }

  // ---- summary ----
  const counts = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  const pass = counts.PASS || 0, fail = counts.FAIL || 0, blocked = counts.BLOCKED || 0;
  console.log(`\n=== Summary: ${pass} PASS, ${fail} FAIL, ${blocked} BLOCKED (total ${results.length}) ===`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => r.status === 'FAIL')) console.log(`  - (${r.req}) ${r.name}: ${r.detail}`);
  }

  const out = { baseUrl: BASE_URL, timestamp: new Date().toISOString(), dbUp: DB_UP, version: healthJson?.version, counts: { pass, fail, blocked }, results };
  try {
    mkdirSync(__dirname, { recursive: true });
    writeFileSync(join(__dirname, 'last-run.json'), JSON.stringify(out, null, 2));

    // Human-readable markdown report.
    const md = [
      `# Live smoke test report`,
      ``,
      `- Target: ${BASE_URL}`,
      `- Time: ${out.timestamp}`,
      `- Version: ${out.version ?? 'n/a'}`,
      `- DB: ${DB_UP ? 'up' : 'down (Neon quota)'}`,
      `- Result: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED (total ${results.length})`,
      ``,
      `| Req | Check | Status | Detail |`,
      `| --- | --- | --- | --- |`,
      ...results.map((r) => `| ${r.req} | ${r.name} | ${r.status} | ${(r.detail ?? '').replace(/\|/g, '\\|')} |`),
    ].join('\n');
    writeFileSync(join(__dirname, 'last-run.md'), md);
  } catch (e) {
    console.error('Could not write report files:', e.message);
  }

  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Harness crashed:', e); process.exit(2); });
