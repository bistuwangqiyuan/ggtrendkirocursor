#!/usr/bin/env node
/**
 * Put the right environment on the standby deployment, in one command.
 *
 * WHY A SCRIPT
 * The second Netlify account has to end up with roughly twenty variables, and two
 * of them decide whether the site is harmless or expensive: `SITE_ROLE` must be
 * `reader` (otherwise a second copy of the batch wakes Neon and buys the same LLM
 * tokens twice), and every payment key must match the primary exactly (otherwise a
 * webhook signed for one deployment is rejected by the other). Typing that into a
 * web form twice is how one of them ends up wrong.
 *
 * WHY IT READS FROM A FILE AND NOT FROM THE PRIMARY SITE
 * Netlify's API does not return the value of a variable marked secret. A copy
 * routine would therefore appear to work and quietly leave the secrets empty —
 * the worst possible outcome for a payment key. So the values come from a local
 * file (or the shell), and anything required but absent is reported by name.
 *
 * Usage:
 *   node scripts/standby-env.mjs --from=.env.standby --dry-run
 *   node scripts/standby-env.mjs --from=.env.standby
 *
 * Environment:
 *   NETLIFY_TOKEN_STANDBY    PAT for the second account
 *   NETLIFY_SITE_ID_STANDBY  the standby site's id (Site configuration -> General)
 *
 * Values are never printed. Only key names, and whether each was created,
 * updated, already correct, or missing.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FROM = (args.find((a) => a.startsWith('--from=')) || '').split('=')[1] || '';

const TOKEN = process.env.NETLIFY_TOKEN_STANDBY;
const SITE_ID = process.env.NETLIFY_SITE_ID_STANDBY;

/**
 * What the standby needs, and why. `required: true` means the deployment is
 * broken or dangerous without it; the rest degrade a feature and say so.
 */
const KEYS = [
  { key: 'SITE_ROLE', required: true, fixed: 'reader', why: 'no cron on the standby; a writer copy doubles Neon and LLM spend' },
  { key: 'DATABASE_URL', required: true, why: 'same database as the primary' },
  { key: 'SESSION_SECRET', required: true, why: 'sessions must survive a domain move between deployments' },
  { key: 'CRON_SECRET', required: true, why: 'snapshot rebuild + canary authentication' },
  { key: 'ADMIN_SECRET', required: false, why: 'ops endpoints; falls back to CRON_SECRET' },
  { key: 'LLM_API_ENDPOINTS', required: false, why: 'only used if this site is ever promoted to writer' },
  { key: 'LLM_API_KEY', required: false, why: 'single-endpoint alternative to LLM_API_ENDPOINTS' },
  { key: 'PAYMENT_TOKEN_SECRET', required: false, why: 'download links; MUST equal the primary or emailed links break on failover' },
  { key: 'CREEM_API_KEY', required: false, why: 'primary payment provider' },
  { key: 'CREEM_PRODUCT_ID', required: false, why: 'the $1 product' },
  { key: 'CREEM_WEBHOOK_SECRET', required: false, why: 'without it Creem is not offered at all' },
  { key: 'LEMONSQUEEZY_API_KEY', required: false, why: 'fallback provider' },
  { key: 'LEMONSQUEEZY_STORE_ID', required: false },
  { key: 'LEMONSQUEEZY_VARIANT_ID', required: false },
  { key: 'LEMONSQUEEZY_WEBHOOK_SECRET', required: false, why: 'without it Lemon Squeezy is not offered at all' },
  { key: 'RESEND_API_KEY', required: false, why: 'guest download-link recovery emails' },
  { key: 'EMAIL_FROM', required: false },
  { key: 'PAYMENT_PRICE_CENTS', required: false, why: 'display only; keep equal to the provider product' },
  { key: 'SNAPSHOT_MAX_AGE_SECONDS', required: false },
  { key: 'PIPELINE_RECOVERY_ENABLED', required: false, why: 'leave unset: the reader keeps the snapshot watchdog' },
];

const log = (...m) => console.log(...m);
const die = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

/** Minimal dotenv: KEY=value, `export` prefix and surrounding quotes tolerated. */
function readEnvFile(path) {
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function netlify(path, init = {}) {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Netlify answers HTML for some error states */
  }
  if (!res.ok) throw new Error(`Netlify ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

if (!TOKEN || !SITE_ID) die('Set NETLIFY_TOKEN_STANDBY and NETLIFY_SITE_ID_STANDBY', 2);

const fileValues = FROM ? readEnvFile(FROM) : {};
const site = await netlify(`/sites/${SITE_ID}`);
const accountId = site.account_slug || site.account_id;
if (!accountId) die('Could not determine the account for this site', 1);
log(`site: ${site.name} (${SITE_ID}) account=${accountId}`);
log(`values from: ${FROM || 'process environment only'}${DRY_RUN ? '  [dry run]' : ''}\n`);

const existing = await netlify(`/accounts/${accountId}/env?site_id=${SITE_ID}`);
const current = new Map((existing || []).map((v) => [v.key, v]));

const plan = { create: [], update: [], unchanged: [], missing: [] };

for (const spec of KEYS) {
  const value = spec.fixed ?? fileValues[spec.key] ?? process.env[spec.key] ?? '';
  if (!value) {
    if (spec.required) plan.missing.push(spec);
    continue;
  }
  const found = current.get(spec.key);
  if (!found) {
    plan.create.push({ spec, value });
    continue;
  }
  // A secret's stored value is not readable, so "same" cannot be established;
  // rewriting it is harmless and keeps the two deployments in step.
  const readable = (found.values || []).find((v) => v.context === 'all' || v.context === 'production');
  if (readable && readable.value === value) plan.unchanged.push(spec);
  else plan.update.push({ spec, value });
}

for (const { spec } of plan.create) log(`create   ${spec.key}${spec.why ? `   (${spec.why})` : ''}`);
for (const { spec } of plan.update) log(`update   ${spec.key}`);
for (const spec of plan.unchanged) log(`ok       ${spec.key}`);
for (const spec of plan.missing) console.error(`MISSING  ${spec.key}   required: ${spec.why || ''}`);

if (plan.missing.length > 0) {
  die(`\n${plan.missing.length} required variable(s) have no value. Add them to ${FROM || 'the environment'} and re-run.`, 1);
}

if (DRY_RUN) {
  log(`\n--dry-run: nothing written (${plan.create.length} to create, ${plan.update.length} to update)`);
  process.exit(0);
}

if (plan.create.length > 0) {
  await netlify(`/accounts/${accountId}/env?site_id=${SITE_ID}`, {
    method: 'POST',
    body: JSON.stringify(
      plan.create.map(({ spec, value }) => ({
        key: spec.key,
        // Build AND runtime: the pipeline reads these in functions, and Astro
        // reads a few at build time.
        scopes: ['builds', 'functions', 'runtime'],
        values: [{ context: 'all', value }],
      }))
    ),
  });
  log(`\ncreated ${plan.create.length} variable(s)`);
}

for (const { spec, value } of plan.update) {
  await netlify(`/accounts/${accountId}/env/${encodeURIComponent(spec.key)}?site_id=${SITE_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      key: spec.key,
      scopes: ['builds', 'functions', 'runtime'],
      values: [{ context: 'all', value }],
    }),
  });
  log(`updated ${spec.key}`);
}

log(`
Next:
  1. Trigger a deploy (Netlify only injects environment at deploy time).
  2. Fill the standby's own snapshot store, which starts empty:
       BASE_URL=https://${site.name}.netlify.app CRON_SECRET=... node scripts/snapshot-bootstrap.mjs
  3. Verify: BASE_URL=https://${site.name}.netlify.app node tests/e2e/live-smoke.mjs
  4. Confirm the role took effect: the standby's bp-scheduled log must say
     "role=reader; the writer deployment owns this batch".`);
