#!/usr/bin/env node
/**
 * Create the reader (standby) Netlify site on the second account and wire it to
 * this GitHub repo, in one command.
 *
 * WHY A SCRIPT
 * Clicking through the Netlify UI for a second account is how SITE_ROLE ends up
 * still set to writer (and Neon/LLM spend doubles) or how the repo link is left
 * on the wrong branch. This creates the site, forces SITE_ROLE=reader, and
 * prints the exact next commands — nothing else.
 *
 * Usage:
 *   NETLIFY_TOKEN_STANDBY=<pat> node scripts/create-standby-site.mjs
 *   NETLIFY_TOKEN_STANDBY=<pat> node scripts/create-standby-site.mjs --name=ioni-standby
 *   NETLIFY_TOKEN_STANDBY=<pat> node scripts/create-standby-site.mjs --dry-run
 *
 * The PAT must belong to the SECOND Netlify account (13426086861@139.com).
 * After creation, fill env with scripts/standby-env.mjs and trigger a deploy.
 */

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NAME = (args.find((a) => a.startsWith('--name=')) || '').split('=')[1] || 'ioni-standby';
const REPO = 'bistuwangqiyuan/ggtrendkirocursor';
const TOKEN = process.env.NETLIFY_TOKEN_STANDBY;

const die = (m, c = 1) => {
  console.error(m);
  process.exit(c);
};
if (!TOKEN) die('Set NETLIFY_TOKEN_STANDBY to a Personal Access Token for the second Netlify account', 2);

async function api(path, init = {}) {
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
    /* HTML error pages */
  }
  if (!res.ok) throw new Error(`Netlify ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return json;
}

const me = await api('/user');
console.log(`authenticated as: ${me.email || me.full_name || me.id}`);

const accounts = await api('/accounts');
const account = Array.isArray(accounts) ? accounts[0] : null;
if (!account) die('No Netlify team/account visible to this token');
console.log(`account: ${account.name || account.slug} (${account.slug})`);

const existing = await api(`/sites?filter=all`);
const clash = (existing || []).find((s) => s.name === NAME || s.custom_domain === `${NAME}.netlify.app`);
if (clash) {
  console.log(`\nsite already exists: ${clash.name} id=${clash.id} url=${clash.ssl_url || clash.url}`);
  console.log(`\nNext:
  1. NETLIFY_TOKEN_STANDBY=... NETLIFY_SITE_ID_STANDBY=${clash.id} node scripts/standby-env.mjs --from=.env.standby
  2. Trigger a deploy in the Netlify UI (or push to main).
  3. BASE_URL=${clash.ssl_url || clash.url} CRON_SECRET=... node scripts/snapshot-bootstrap.mjs
  4. Set GitHub Variable STANDBY_BASE_URL=${clash.ssl_url || clash.url}
     and Secrets NETLIFY_TOKEN_STANDBY / NETLIFY_SITE_ID_STANDBY=${clash.id}`);
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`\n--dry-run: would create site "${NAME}" on account ${account.slug}, linked to ${REPO}`);
  process.exit(0);
}

const site = await api(`/sites`, {
  method: 'POST',
  body: JSON.stringify({
    name: NAME,
    account_slug: account.slug,
    repo: {
      provider: 'github',
      repo: REPO,
      private: false,
      branch: 'main',
      cmd: 'pnpm run build',
      dir: 'dist',
      // Netlify will ask the GitHub App to be installed on this account if it
      // is not already; the API call then fails with a clear message.
    },
  }),
});

console.log(`\ncreated: ${site.name}`);
console.log(`  id:   ${site.id}`);
console.log(`  url:  ${site.ssl_url || site.url}`);
console.log(`  repo: ${site.build_settings?.repo_url || '(link the GitHub repo in the UI if missing)'}`);

// Force the one variable that makes a second deployment expensive if wrong.
await api(`/accounts/${account.slug}/env?site_id=${site.id}`, {
  method: 'POST',
  body: JSON.stringify([
    {
      key: 'SITE_ROLE',
      scopes: ['builds', 'functions', 'runtime'],
      values: [{ context: 'all', value: 'reader' }],
    },
  ]),
});
console.log('  SITE_ROLE=reader set');

console.log(`
Next (do these in order):
  1. Put the rest of the env on this site (SITE_ROLE is already reader):
       NETLIFY_TOKEN_STANDBY=${TOKEN.slice(0, 6)}… NETLIFY_SITE_ID_STANDBY=${site.id} \\
         node scripts/standby-env.mjs --from=.env.standby
  2. In Netlify → Site configuration → Build & deploy, confirm the GitHub repo
     is linked and deploys on push to main. Trigger one deploy.
  3. Bootstrap its empty snapshot store:
       BASE_URL=${site.ssl_url || site.url} CRON_SECRET=... node scripts/snapshot-bootstrap.mjs
  4. Smoke-test:
       BASE_URL=${site.ssl_url || site.url} node tests/e2e/live-smoke.mjs
  5. GitHub repo Settings → Secrets and variables → Actions:
       Variable  STANDBY_BASE_URL = ${site.ssl_url || site.url}
       Secret    NETLIFY_TOKEN_STANDBY = <same PAT>
       Secret    NETLIFY_SITE_ID_STANDBY = ${site.id}
  6. Leave failover.yml alone until §10.6 pre-cutover verification is green.
`);
