/**
 * Post-migration acceptance check.
 *
 * Points a running dev server at the *migrated* database, rebuilds every
 * snapshot from it, and then asserts the public read paths render real content.
 * Row counts alone cannot prove a migration succeeded: the app has to be able
 * to read what was copied. Run this against the new Neon project before
 * switching production's DATABASE_URL.
 *
 * Usage:
 *   BASE_URL=http://localhost:4399 ADMIN_SECRET=... node tests/e2e/migrated-db-check.mjs
 */

const BASE = (process.env.BASE_URL || 'http://localhost:4399').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'localtest';

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

async function get(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log(`Base: ${BASE}\n`);

  const rebuild = await get('/api/snapshots/rebuild', {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
  });
  check('snapshot rebuild from migrated DB', rebuild.status === 200, `HTTP ${rebuild.status}`);
  let written = 0;
  try {
    const json = JSON.parse(rebuild.body);
    written = Object.values(json.report?.written || {}).reduce((a, b) => a + b, 0);
  } catch {
    /* reported below via written === 0 */
  }
  check('rebuild wrote snapshots', written > 0, `${written} keys`);

  const status = await get('/api/snapshots/status');
  let snaps = {};
  try {
    snaps = JSON.parse(status.body).snapshots || {};
  } catch {
    /* reported below */
  }
  check('trendsTop snapshot present', snaps.trendsTop?.present === true, JSON.stringify(snaps.trendsTop || {}));
  check('trendsTop has rows', (snaps.trendsTop?.items ?? 0) > 0, `${snaps.trendsTop?.items ?? 0} items`);
  check('bpList snapshot present', snaps.bpList?.present === true, `${snaps.bpList?.items ?? 0} items`);

  // Read paths must render from those snapshots.
  const routes = [
    ['/', 200],
    ['/trends', 200],
    ['/t', 200],
    ['/bp', 200],
    ['/monitor', 200],
    ['/sitemap.xml', 200],
    ['/api/trends/list', 200],
    ['/api/bp/list', 200],
  ];
  for (const [path, expect] of routes) {
    const res = await get(path);
    const pending = res.body.includes('data-testid="degraded-notice"');
    check(`GET ${path}`, res.status === expect && !pending, `HTTP ${res.status}${pending ? ' (degraded)' : ''}`);
  }

  // A real keyword from the migrated data must have a working landing page.
  const list = await get('/api/trends/list');
  let keyword = null;
  try {
    keyword = JSON.parse(list.body).data?.trends?.[0]?.keyword ?? null;
  } catch {
    /* reported below */
  }
  check('trends API returned a keyword', Boolean(keyword), keyword || '');

  // A landing page linked from the index must render from the migrated rows too.
  const index = await get('/t');
  const slug = index.body.match(/href="\/t\/([^"?#]+)"/)?.[1] ?? null;
  check('landing index links a keyword page', Boolean(slug), slug || '');
  if (slug) {
    const detail = await get(`/t/${slug}`);
    const pending = detail.body.includes('data-testid="degraded-notice"');
    check(`GET /t/${slug}`, detail.status === 200 && !pending, `HTTP ${detail.status}${pending ? ' (degraded)' : ''}`);
  }

  const bp = await get('/api/bp/list');
  let bpId = null;
  try {
    bpId = JSON.parse(bp.body).data?.reports?.[0]?.id ?? null;
  } catch {
    /* reported below */
  }
  check('bp list API returned a report', Boolean(bpId), bpId || '');
  if (bpId) {
    const detail = await get(`/api/bp/${bpId}`);
    check(`GET /api/bp/${bpId}`, detail.status === 200, `HTTP ${detail.status}`);
    const page = await get(`/bp/${bpId}`);
    check(`GET /bp/${bpId}`, page.status === 200, `HTTP ${page.status}`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Check run failed:', e);
  process.exit(1);
});
