#!/usr/bin/env node
/**
 * DB-outage drill: hard proof that the read path has no Postgres dependency.
 *
 * Boots the app with a DATABASE_URL that cannot resolve, backed only by fixture
 * snapshots on the filesystem, then asserts every read-only route returns 200
 * AND renders the fixture data. A route that still queried the database would
 * either 500 or lose its content here.
 *
 * This is acceptance criterion #1 of the Neon budget plan. It runs entirely
 * locally, needs no credentials, and is safe to run in CI.
 *
 * Usage:
 *   node tests/e2e/db-outage-drill.mjs
 *   DRILL_PORT=4331 node tests/e2e/db-outage-drill.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const PORT = Number(process.env.DRILL_PORT || 4331);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 120_000;

// A host in the reserved TEST-NET-1 range: guaranteed unroutable, so the pg
// client fails to connect rather than hitting a real database.
const BROKEN_DATABASE_URL = 'postgresql://drill:drill@192.0.2.1:5432/nope?sslmode=disable';

const KEYWORD = 'drill fixture keyword';
const SLUG = 'drill-fixture-keyword';
const BP_ID = '11111111-2222-3333-4444-555555555555';
const NOW = new Date().toISOString();

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' -> ' + detail : ''}`);
}

/** Write a fixture snapshot in the same envelope shape snapshot.ts produces. */
async function writeFixture(dir, key, data) {
  const file = join(dir, ...key.split('/').map(encodeURIComponent)) + '.json';
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ generatedAt: NOW, version: 'drill', data }), 'utf8');
}

async function seedSnapshots(dir) {
  const trendRow = {
    id: 'drill-trend-1',
    keyword: KEYWORD,
    searchVolume: 123456,
    growthRate: 42,
    category: 'trending',
    timeRange: '4h',
    region: 'US',
    trafficSource: 'drill',
    relatedQueries: [],
    timestamp: NOW,
    createdAt: NOW,
  };
  await writeFixture(dir, 'trends/top', { rows: [trendRow], totalRows: 1, truncated: false });
  await writeFixture(dir, 'trends/categories', ['trending']);

  const landingKeyword = {
    keyword: KEYWORD,
    slug: SLUG,
    searchVolume: 123456,
    growthRate: 42,
    region: 'US',
    lastSeen: NOW,
    appearances: 3,
  };
  await writeFixture(dir, 'landing/index', { keywords: [landingKeyword] });
  await writeFixture(dir, `landing/detail/${SLUG}`, {
    keyword: landingKeyword,
    history: [{ searchVolume: 123456, growthRate: 42, region: 'US', collectedAt: NOW }],
    bp: { id: BP_ID, title: 'Drill fixture plan', status: 'completed', selectedOpportunity: 'Drill opportunity' },
  });

  const bpListItem = {
    id: BP_ID,
    keyword: KEYWORD,
    title: 'Drill fixture plan',
    status: 'completed',
    selectedOpportunity: 'Drill opportunity',
    riskAdjustedAnnualized: '40%',
    riskAdjustedNum: 40,
    createdAt: NOW,
  };
  await writeFixture(dir, 'bp/list', { reports: [bpListItem] });

  // A full contentJson, so the drill exercises the real completed-report render
  // path rather than the "pending" placeholder.
  const opportunities = Array.from({ length: 5 }, (_, i) => ({
    name: `Drill opportunity ${i + 1}`,
    description: `Drill opportunity description ${i + 1}`,
    scores: { market: 8, roi: 8, onlineability: 9, feasibility: 7, speed: 7, moat: 6 },
    weightedScore: 8 - i * 0.1,
    isSelected: i === 0,
    rank: i + 1,
  }));
  const contentJson = {
    title: 'Drill fixture plan',
    summary: 'Drill fixture executive summary with a 40% risk-adjusted figure.',
    selectedOpportunity: 'Drill opportunity 1',
    businessModel: 'Drill fixture business model.',
    opportunities,
    market: { tam: '$1B', sam: '$100M', som: '$10M', notes: 'Drill market note' },
    financials: { years: [{ year: 1, revenue: '1', cost: '1', profit: '0', margin: '0%' }] },
    seedReturn: {
      annualizedBook: '80%',
      winRate: '15%',
      profitLossRatio: '3:1',
      expectedValueMOIC: '2.1x',
      riskAdjustedAnnualized: '40%',
      bookRoiByYear: [1, 2, 3, 4, 5],
      notes: 'Drill seed note',
    },
  };
  await writeFixture(dir, `bp/detail/${BP_ID}`, {
    report: {
      id: BP_ID,
      keyword: KEYWORD,
      keywordNorm: KEYWORD,
      status: 'completed',
      title: 'Drill fixture plan',
      summary: contentJson.summary,
      selectedOpportunity: 'Drill opportunity 1',
      searchVolume: 123456,
      growthRate: 42,
      category: 'trending',
      timeRange: '4h',
      region: 'US',
      rank: 1,
      contentJson,
      opportunities,
      model: 'drill',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  await writeFixture(dir, 'monitor/latest', {
    sites: [
      {
        id: 'drill-site-1',
        name: 'Drill fixture site',
        url: 'https://example.com',
        enabled: true,
        createdAt: NOW,
        lastCheck: {
          ok: true,
          httpStatus: 200,
          responseMs: 120,
          seoScore: 90,
          seoChecks: {},
          error: null,
          checkedAt: NOW,
        },
      },
    ],
  });
}

function startServer(snapshotDir) {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'astro', 'astro.js'), 'dev', '--port', String(PORT), '--host', '127.0.0.1'],
    {
      env: {
        ...process.env,
        DATABASE_URL: BROKEN_DATABASE_URL,
        SNAPSHOT_BACKEND: 'fs',
        SNAPSHOT_DIR: snapshotDir,
        // The drill fails if a page quietly reverts to querying Postgres.
        ALLOW_DB_READ_FALLBACK: 'false',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }
  );
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

async function waitForServer() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/robots.txt`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function get(path) {
  try {
    const res = await fetch(BASE + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { Cookie: 'locale=zh' },
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: '', error: String(e?.message || e) };
  }
}

async function run() {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'drill-snapshots-'));
  await seedSnapshots(snapshotDir);
  console.log(`\n=== DB-outage drill ===\nDATABASE_URL: ${BROKEN_DATABASE_URL}\nSnapshots:    ${snapshotDir}\n`);

  const { child, log } = startServer(snapshotDir);
  let exitCode = 0;
  try {
    if (!(await waitForServer())) {
      console.error('Server did not start within the timeout. Output:\n' + log.join(''));
      return 2;
    }

    // Every read-only route: 200, plus a content assertion that only passes if
    // the fixture data actually made it onto the page.
    const routes = [
      ['/', 'data-page="marketing-home"', null],
      ['/trends', 'data-page="trends"', KEYWORD],
      ['/t', 'data-page="landing-index"', KEYWORD],
      [`/t/${SLUG}`, 'data-page="landing-keyword"', KEYWORD],
      ['/bp', 'data-page="bp-list"', 'Drill fixture plan'],
      // bp-report only exists when the completed-report body actually rendered.
      [`/bp/${BP_ID}`, 'bp-report', 'Drill fixture plan'],
      ['/monitor', 'data-page="monitor"', 'Drill fixture site'],
    ];
    for (const [path, marker, content] of routes) {
      const r = await get(path);
      const has = (needle) => !needle || r.body.includes(needle);
      const ok = r.status === 200 && has(marker) && has(content);
      record(
        `${path} renders from snapshot`,
        ok,
        ok ? 'status=200' : `status=${r.status}${r.error ? ' error=' + r.error : ''} marker=${has(marker)} content=${has(content)}`
      );
    }

    const sitemap = await get('/sitemap.xml');
    record(
      '/sitemap.xml lists snapshot routes',
      sitemap.status === 200 && sitemap.body.includes(SLUG) && sitemap.body.includes(BP_ID),
      `status=${sitemap.status}`
    );

    const status = await get('/api/snapshots/status');
    let statusJson = null;
    try { statusJson = JSON.parse(status.body); } catch { /* reported below */ }
    record(
      '/api/snapshots/status answers during outage',
      status.status === 200 && statusJson?.snapshots?.trendsTop?.present === true,
      `status=${status.status} ok=${statusJson?.ok}`
    );

    // Read-only JSON APIs.
    for (const [path, needle] of [
      ['/api/trends/list?pageSize=5', KEYWORD],
      ['/api/bp/list?pageSize=5', 'Drill fixture plan'],
      [`/api/bp/${BP_ID}`, 'Drill fixture plan'],
    ]) {
      const r = await get(path);
      record(`${path} serves from snapshot`, r.status === 200 && r.body.includes(needle), `status=${r.status}`);
    }

    // An unknown slug must still 404 rather than 500 while the DB is unreachable:
    // otherwise crawlers would index placeholder pages during an outage.
    const unknown = await get('/t/no-such-slug-in-any-snapshot');
    record('unknown landing slug still 404s', unknown.status === 404, `status=${unknown.status}`);

    // Sanity check the premise: the database really is unreachable, so the 200s
    // above cannot be explained by a working connection.
    const health = await get('/api/health');
    let healthJson = null;
    try { healthJson = JSON.parse(health.body); } catch { /* reported below */ }
    record(
      'database is genuinely unreachable (drill premise)',
      healthJson?.database?.connected === false,
      `connected=${healthJson?.database?.connected} error=${String(healthJson?.database?.error || '').slice(0, 60)}`
    );

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
      console.log('\nServer output (tail):\n' + log.join('').slice(-4000));
      exitCode = 1;
    }
  } finally {
    child.kill('SIGTERM');
    // Windows sometimes leaves the port bound if the child ignores SIGTERM.
    setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
    await rm(snapshotDir, { recursive: true, force: true });
  }
  return exitCode;
}

run().then(
  (code) => process.exit(code),
  (e) => { console.error('Drill crashed:', e); process.exit(2); }
);
