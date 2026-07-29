#!/usr/bin/env node
/**
 * Assert, from outside the site, that the pages readers see are current.
 *
 * The site already watches its own snapshots and answers 503 on
 * `/api/snapshots/status` when they go stale, but a watchdog that lives in the
 * thing it watches has a blind spot: on 2026-07-26 the write pipeline could not
 * reach the snapshot store at all, so it could neither refresh the pages nor log
 * why, and the freeze lasted 44 hours. This check computes the ages itself, so
 * it also holds against a deploy that predates that status code.
 *
 * Exits 1 when anything is missing or older than MAX_AGE_MINUTES, which is what
 * turns a scheduled GitHub Actions run into an alert.
 *
 * Usage:
 *   BASE_URL=https://ioni.top MAX_AGE_MINUTES=240 node scripts/snapshot-freshness.mjs
 */

const BASE = (process.env.BASE_URL || 'https://ioni.top').replace(/\/$/, '');
const MAX_AGE_MINUTES = Number(process.env.MAX_AGE_MINUTES) || 240;

const res = await fetch(`${BASE}/api/snapshots/status`, {
  headers: { 'Cache-Control': 'no-cache' },
});
// 503 is this endpoint's own stale signal; the ages below say which sections.
if (res.status !== 200 && res.status !== 503) {
  console.error(`status endpoint answered ${res.status}`);
  process.exit(1);
}
const body = await res.json();

const now = Date.now();
const missing = [];
const stale = [];
for (const [name, snapshot] of Object.entries(body.snapshots ?? {})) {
  if (!snapshot?.present || !snapshot.generatedAt) {
    missing.push(name);
    continue;
  }
  const ageMinutes = Math.round((now - new Date(snapshot.generatedAt).getTime()) / 60_000);
  console.log(`${name}: ${ageMinutes}min old, ${snapshot.items ?? '?'} items`);
  if (ageMinutes > MAX_AGE_MINUTES) stale.push(`${name} (${ageMinutes}min)`);
}

if (missing.length) console.error(`MISSING: ${missing.join(', ')}`);
if (stale.length) console.error(`STALE beyond ${MAX_AGE_MINUTES}min: ${stale.join(', ')}`);
if (missing.length || stale.length) process.exit(1);
console.log(`read side is fresh (limit ${MAX_AGE_MINUTES}min)`);
