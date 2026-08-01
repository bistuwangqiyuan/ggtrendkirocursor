#!/usr/bin/env node
/**
 * Move the public domain to whichever deployment is actually serving.
 *
 * WHY THIS EXISTS
 * The site runs on two Netlify accounts because one account is a single point of
 * failure for reasons that have nothing to do with the code: in July 2026 an
 * exhausted credit balance blocked every deploy for a month. A standby account
 * only helps if traffic can be moved to it, and moving traffic needs two changes,
 * not one:
 *   1. Netlify: a custom domain may belong to only one site, so it must be
 *      released by the failing site before the standby can claim it. Skipping
 *      this yields a certificate for a site that no longer answers.
 *   2. DNS: the apex and www records are CNAMEs to a per-site *.netlify.app
 *      hostname, so they have to point at the standby's hostname.
 *
 * WHAT COUNTS AS DOWN
 * Only hard unavailability — connection failures, timeouts, 5xx — confirmed by
 * several probes spaced apart, because a domain flip is disruptive and a single
 * failed request is usually a blip. Stale content is deliberately NOT a trigger:
 * both deployments read the same database, so staleness is almost always a
 * pipeline problem that a flip would carry along with it. The publish workflow
 * already reports that separately.
 *
 * The flip is also refused unless the standby is proven healthy, since replacing
 * a broken site with a broken site only adds a DNS propagation delay to an
 * existing outage.
 *
 * Usage:
 *   node scripts/failover.mjs              # probe, act only if needed
 *   node scripts/failover.mjs --dry-run    # report the decision, change nothing
 *   node scripts/failover.mjs --to=standby # deliberate switch (drills, maintenance)
 *
 * Environment:
 *   DOMAIN                     apex domain, e.g. ioni.top
 *   NETLIFY_TOKEN_PRIMARY      PAT for the account owning the primary site
 *   NETLIFY_SITE_ID_PRIMARY    site id (see .netlify/state.json)
 *   NETLIFY_TOKEN_STANDBY      PAT for the second account
 *   NETLIFY_SITE_ID_STANDBY    site id of the standby
 *   ALIYUN_ACCESS_KEY_ID       optional: without these the Netlify half is done
 *   ALIYUN_ACCESS_KEY_SECRET   and the DNS half is printed for a manual edit
 *   PROBES / PROBE_INTERVAL_MS / PROBE_TIMEOUT_MS   defaults 3 / 10000 / 15000
 */

import { createHmac, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCED = (args.find((a) => a.startsWith('--to=')) || '').split('=')[1] || '';

const DOMAIN = (process.env.DOMAIN || 'ioni.top').replace(/^https?:\/\//, '').replace(/\/$/, '');
const PROBES = Number(process.env.PROBES) || 3;
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS) || 10_000;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15_000;

const SITES = {
  primary: {
    token: process.env.NETLIFY_TOKEN_PRIMARY,
    siteId: process.env.NETLIFY_SITE_ID_PRIMARY,
  },
  standby: {
    token: process.env.NETLIFY_TOKEN_STANDBY,
    siteId: process.env.NETLIFY_SITE_ID_STANDBY,
  },
};

const log = (...m) => console.log(...m);
const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// --- Netlify ---------------------------------------------------------------

async function netlify(role, path, init = {}) {
  const { token } = SITES[role];
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Netlify returns HTML for some error states */
  }
  if (!res.ok) {
    throw new Error(`Netlify ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return json;
}

async function siteInfo(role) {
  const site = await netlify(role, `/sites/${SITES[role].siteId}`);
  return {
    role,
    name: site.name,
    // The per-site hostname DNS must point at, e.g. mysite.netlify.app.
    netlifyHost: (site.default_domain || `${site.name}.netlify.app`).replace(/\/$/, ''),
    customDomain: site.custom_domain || null,
    aliases: site.domain_aliases || [],
    directUrl: `https://${site.default_domain || `${site.name}.netlify.app`}`,
  };
}

async function setDomain(role, customDomain, aliases) {
  return netlify(role, `/sites/${SITES[role].siteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ custom_domain: customDomain, domain_aliases: aliases }),
  });
}

// --- Aliyun DNS (RPC style, HMAC-SHA1) -------------------------------------

/** Aliyun's percent-encoding differs from encodeURIComponent in three characters. */
function aliEncode(value) {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function alidns(action, params = {}) {
  const keyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const keySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('ALIYUN_ACCESS_KEY_ID/SECRET not set');

  const query = {
    Action: action,
    Format: 'JSON',
    Version: '2015-01-09',
    AccessKeyId: keyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...params,
  };

  const canonical = Object.keys(query)
    .sort()
    .map((k) => `${aliEncode(k)}=${aliEncode(String(query[k]))}`)
    .join('&');
  const stringToSign = `GET&${aliEncode('/')}&${aliEncode(canonical)}`;
  const signature = createHmac('sha1', `${keySecret}&`).update(stringToSign).digest('base64');

  const res = await fetch(`https://alidns.aliyuncs.com/?${canonical}&Signature=${aliEncode(signature)}`);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Aliyun ${action} -> ${res.status} ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return json;
}

/**
 * Point one hostname at the standby. `@` is the apex; Aliyun stores the record
 * name relative to the zone.
 */
async function pointRecord(rr, target) {
  const list = await alidns('DescribeDomainRecords', { DomainName: DOMAIN, RRKeyWord: rr });
  const records = (list?.DomainRecords?.Record || []).filter((r) => r.RR === rr);
  const cname = records.find((r) => r.Type === 'CNAME');

  if (cname) {
    if (cname.Value.replace(/\.$/, '') === target) return `${rr}: already -> ${target}`;
    await alidns('UpdateDomainRecord', {
      RecordId: cname.RecordId,
      RR: rr,
      Type: 'CNAME',
      Value: target,
      TTL: 600,
    });
    return `${rr}: CNAME ${cname.Value} -> ${target}`;
  }

  // An apex served by A records cannot become a CNAME while they exist.
  const conflicting = records.filter((r) => r.Type === 'A' || r.Type === 'AAAA');
  for (const r of conflicting) {
    await alidns('DeleteDomainRecord', { RecordId: r.RecordId });
  }
  await alidns('AddDomainRecord', { DomainName: DOMAIN, RR: rr, Type: 'CNAME', Value: target, TTL: 600 });
  return `${rr}: created CNAME -> ${target}${conflicting.length ? ` (removed ${conflicting.length} A/AAAA)` : ''}`;
}

// --- Health ----------------------------------------------------------------

async function probeOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'ioni-failover-probe' },
      cache: 'no-store',
    });
    // 4xx means the app answered and routed; only 5xx and transport errors are
    // this script's business.
    return { ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** One answered probe is enough to count as healthy, and so to refuse a flip. */
async function health(url, label) {
  const results = [];
  for (let i = 0; i < PROBES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    const r = await probeOnce(url);
    results.push(r);
    log(`  probe ${label} ${i + 1}/${PROBES}: ${r.ok ? 'ok' : 'FAIL'} status=${r.status} ${r.ms}ms${r.error ? ` (${r.error})` : ''}`);
    if (r.ok && i === 0) break; // healthy on the first try: no need to keep asking
  }
  return { ok: results.some((r) => r.ok), results };
}

// --- Decide and act --------------------------------------------------------

for (const [role, cfg] of Object.entries(SITES)) {
  if (!cfg.token || !cfg.siteId) {
    fail(`Missing NETLIFY_TOKEN_${role.toUpperCase()} / NETLIFY_SITE_ID_${role.toUpperCase()}`, 2);
  }
}

const [primary, standby] = await Promise.all([siteInfo('primary'), siteInfo('standby')]);
log(`primary: ${primary.name} custom=${primary.customDomain || 'none'} host=${primary.netlifyHost}`);
log(`standby: ${standby.name} custom=${standby.customDomain || 'none'} host=${standby.netlifyHost}`);

const holder = [primary, standby].find((s) => s.customDomain === DOMAIN) || null;
log(`${DOMAIN} is currently bound to: ${holder ? holder.role : 'neither site'}`);

let target = null;
let reason = '';

if (FORCED) {
  if (!['primary', 'standby'].includes(FORCED)) fail(`--to must be primary or standby`, 2);
  target = FORCED === 'primary' ? primary : standby;
  reason = `forced switch to ${FORCED}`;
} else if (!holder) {
  target = primary;
  reason = 'domain bound to neither site';
} else {
  log(`probing the live domain https://${DOMAIN}`);
  const live = await health(`https://${DOMAIN}/`, DOMAIN);
  if (live.ok) {
    log(`\nno action: ${DOMAIN} is served by ${holder.role} and healthy`);
    process.exit(0);
  }
  const other = holder.role === 'primary' ? standby : primary;
  log(`live domain is down; probing the alternative ${other.directUrl}`);
  const alt = await health(`${other.directUrl}/`, other.role);
  if (!alt.ok) {
    // Both down is an application or database problem; moving the domain would
    // only hide which deployment to debug.
    fail(`\nBOTH DEPLOYMENTS ARE DOWN — not flipping. Investigate the app, not the domain.`, 1);
  }
  target = other;
  reason = `${holder.role} unreachable, ${other.role} healthy`;
}

if (holder && target.role === holder.role) {
  log(`\nno action: ${DOMAIN} already points at ${target.role}`);
  process.exit(0);
}

const aliases = [`www.${DOMAIN}`];
log(`\nDECISION: move ${DOMAIN} -> ${target.role} (${target.netlifyHost}) because ${reason}`);

if (DRY_RUN) {
  log('--dry-run: no changes made');
  process.exit(0);
}

// Release first: Netlify refuses a domain that another site still claims.
if (holder) {
  await setDomain(holder.role, null, holder.aliases.filter((a) => !a.endsWith(DOMAIN)));
  log(`released ${DOMAIN} from ${holder.role}`);
}
await setDomain(target.role, DOMAIN, aliases);
log(`bound ${DOMAIN} (+ ${aliases.join(', ')}) to ${target.role}`);

if (process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET) {
  for (const rr of ['@', 'www']) {
    try {
      log(`dns ${await pointRecord(rr, target.netlifyHost)}`);
    } catch (e) {
      console.error(`dns ${rr}: FAILED ${e.message}`);
      console.error(`MANUAL STEP: set ${rr === '@' ? DOMAIN : `www.${DOMAIN}`} CNAME -> ${target.netlifyHost}`);
      process.exitCode = 1;
    }
  }
} else {
  log('\nAliyun credentials not set — the Netlify half is done, DNS is manual:');
  log(`  ${DOMAIN}      CNAME -> ${target.netlifyHost}`);
  log(`  www.${DOMAIN}  CNAME -> ${target.netlifyHost}`);
  process.exitCode = 1;
}

log(`\nfailover to ${target.role} complete; certificate provisioning can take a few minutes`);
