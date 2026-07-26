#!/usr/bin/env node
/**
 * Fill the snapshot store from an empty (or badly stale) state.
 *
 * `/api/snapshots/rebuild` is a synchronous function, so it stops at its own
 * time budget and reports which sections were `truncated`. One call therefore
 * cannot cover thousands of landing pages and hundreds of BP reports from cold.
 * This drives it in a loop until nothing is left over — needed after a first
 * deploy, after switching DATABASE_URL to a new Neon project, or after a
 * snapshot store is wiped.
 *
 * Every pass wakes Neon, so this is a bootstrap tool, not a routine one: the
 * scheduled job keeps snapshots current within its normal window.
 *
 * Usage (PowerShell):
 *   $env:BASE_URL="https://ioni.top"; $env:CRON_SECRET="..."
 *   node scripts/snapshot-bootstrap.mjs
 */

const BASE = (process.env.BASE_URL || 'https://ioni.top').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET || process.env.ADMIN_SECRET;
const MAX_PASSES = Number(process.env.MAX_PASSES) || 60;

if (!SECRET) {
  console.error('CRON_SECRET (or ADMIN_SECRET) is required.');
  process.exit(2);
}
const headers = { Authorization: `Bearer ${SECRET}`, Origin: BASE };

async function rebuild(sections) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/snapshots/rebuild?sections=${sections}`, {
      method: 'POST',
      headers,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an error page, not a report */ }
    return { status: res.status, ms: Date.now() - started, json, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, json: null, text: e.message };
  }
}

async function status() {
  const res = await fetch(`${BASE}/api/snapshots/status`);
  return res.json();
}

// Sections are driven one at a time: each has its own manifest, and finishing
// one before starting the next keeps the per-pass report easy to read.
let failures = 0;
// Stats last: it counts what the earlier sections just wrote.
for (const section of ['trends', 'landing', 'bp', 'monitor', 'stats']) {
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const r = await rebuild(section);
    if (r.status !== 200 || !r.json?.report) {
      console.log(`${section} pass ${pass}: FAILED ${r.status} ${r.text.slice(0, 160)}`);
      failures++;
      break;
    }
    const { written, truncated, errors } = r.json.report;
    const s = await status();
    console.log(
      `${section} pass ${pass}: ${r.ms}ms written=${JSON.stringify(written)} ` +
      `truncated=${JSON.stringify(truncated)} details=${JSON.stringify(s.detailCounts ?? {})}`
    );
    if (Object.keys(errors ?? {}).length) {
      console.log(`  errors: ${JSON.stringify(errors)}`);
      failures++;
      break;
    }
    if (!truncated.includes(section)) break;
    if (pass === MAX_PASSES) {
      console.log(`  ${section} still truncated after ${MAX_PASSES} passes; raise MAX_PASSES.`);
      failures++;
    }
  }
}

const final = await status();
console.log(
  '\nfinal: ' +
  Object.entries(final.snapshots)
    .map(([k, v]) => `${k}=${v.present ? v.items ?? 'present' : 'MISSING'}`)
    .join(' ') +
  ` details=${JSON.stringify(final.detailCounts ?? {})}`
);

const missing = Object.entries(final.snapshots).filter(([, v]) => !v.present).map(([k]) => k);
if (missing.length) console.log(`MISSING snapshots: ${missing.join(', ')}`);
process.exit(failures || missing.length ? 1 : 0);
