#!/usr/bin/env node
/**
 * Neon control-plane helper: measure consumption, create an isolated project,
 * and fetch connection strings.
 *
 * `scripts/neon-audit.mjs` looks *inside* a database and can only infer compute
 * pressure from table contents. This talks to the Neon API instead, which
 * reports the two numbers the free allowance is actually spent on:
 *
 *   cpu_used_sec — compute-unit-seconds; 100 CU-hours = 360,000 of these
 *   active_time  — wall-clock seconds the compute was awake
 *
 * Both are per project and reset at `quota_reset_at`, so `list` answers "are we
 * over budget, and which project is spending it" without guessing.
 *
 * Commands:
 *   list                      consumption and settings for every project (default)
 *   create [name]             create an isolated project sized for this site
 *   uri <project_id>          print pooled and direct connection strings
 *
 * Usage (PowerShell):
 *   $env:NEON_API_KEY="napi_..."
 *   node scripts/neon-provision.mjs list
 *   node scripts/neon-provision.mjs create ggtrendkirocursor
 *   node scripts/neon-provision.mjs uri <project_id>
 *
 * Only `create` writes anything, and it never touches an existing project.
 */

const API = 'https://console.neon.tech/api/v2';
const KEY = process.env.NEON_API_KEY;

if (!KEY) {
  console.error('NEON_API_KEY is required. Create one at https://console.neon.tech/app/settings/api-keys');
  process.exit(2);
}

// The free allowance, from https://neon.com/faqs/free-plan-limits-and-quotas.
const FREE_CU_HOURS = 100;
const FREE_STORAGE_BYTES = 512 * 1024 * 1024;

// Matches the shared project so a migration stays in-region (fast copy, and no
// change in latency from the Netlify functions that talk to it).
const DEFAULTS = {
  region: process.env.NEON_REGION || 'aws-ap-southeast-1',
  pgVersion: Number(process.env.NEON_PG_VERSION) || 17,
  // 0.25 CU is the smallest Neon bills, and it is what the budget model in
  // scripts/neon-budget.py assumes. Capping the max at 1 keeps a runaway query
  // from autoscaling through the month's allowance in an afternoon.
  minCu: 0.25,
  maxCu: 1,
  // 300s is the free plan's fixed autosuspend; stated explicitly so the value
  // this site is budgeted against is visible rather than inherited.
  suspendSeconds: 300,
};

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      ...init.headers,
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: an error page */ }
  if (!res.ok) {
    const detail = json?.message || text.slice(0, 300) || '(empty body)';
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}

function cuHours(cpuUsedSec) {
  return cpuUsedSec / 3600;
}

function fmtHours(sec) {
  return (sec / 3600).toFixed(1);
}

async function listProjects() {
  const { projects } = await api('/projects?limit=400');
  return projects ?? [];
}

async function cmdList() {
  const projects = await listProjects();
  if (!projects.length) {
    console.log('No projects on this account.');
    return;
  }

  console.log('project id                      | name                 | region            | pg | CU-h used | awake h | storage MB | quota resets');
  let totalCu = 0;
  for (const p of projects) {
    const cu = cuHours(p.cpu_used_sec ?? 0);
    totalCu += cu;
    console.log(
      `${String(p.id).padEnd(31)} | ${String(p.name).slice(0, 20).padEnd(20)} | ` +
      `${String(p.region_id).padEnd(17)} | ${String(p.pg_version).padStart(2)} | ` +
      `${cu.toFixed(2).padStart(9)} | ${fmtHours(p.active_time ?? 0).padStart(7)} | ` +
      `${((p.synthetic_storage_size ?? 0) / 1048576).toFixed(1).padStart(10)} | ` +
      `${p.quota_reset_at ?? '-'}`
    );
  }

  // The allowance is per project, so a total over 100 is only a problem if a
  // single project is over. Both numbers are worth seeing.
  console.log(
    `\nAllowance is ${FREE_CU_HOURS} CU-hours and ${(FREE_STORAGE_BYTES / 1048576).toFixed(0)} MB ` +
    `PER PROJECT on the free plan.`
  );
  for (const p of projects) {
    const cu = cuHours(p.cpu_used_sec ?? 0);
    const pct = (cu / FREE_CU_HOURS) * 100;
    const storagePct = ((p.synthetic_storage_size ?? 0) / FREE_STORAGE_BYTES) * 100;
    const flag = pct >= 100 ? 'OVER QUOTA' : pct >= 80 ? 'near quota' : 'ok';
    console.log(
      `  ${p.id}: ${cu.toFixed(2)}/${FREE_CU_HOURS} CU-h (${pct.toFixed(0)}%), ` +
      `storage ${storagePct.toFixed(0)}% — ${flag}`
    );
  }
  console.log(`  across all projects: ${totalCu.toFixed(2)} CU-hours this period`);

  const settings = projects.filter((p) => (p.default_endpoint_settings?.autoscaling_limit_min_cu ?? 0) > 0.25);
  if (settings.length) {
    console.log(
      '\nProjects whose default compute floor is above 0.25 CU burn the allowance faster\n' +
      'for the same awake time: ' +
      settings.map((p) => `${p.id}=${p.default_endpoint_settings.autoscaling_limit_min_cu}CU`).join(', ')
    );
  }
}

async function cmdCreate(name) {
  const projectName = name || process.env.NEON_PROJECT_NAME || 'ggtrendkirocursor';

  const existing = (await listProjects()).find((p) => p.name === projectName);
  if (existing) {
    console.log(`Project "${projectName}" already exists (${existing.id}); not creating a second one.`);
    await cmdUri(existing.id);
    return;
  }

  const body = {
    project: {
      name: projectName,
      pg_version: DEFAULTS.pgVersion,
      region_id: DEFAULTS.region,
      default_endpoint_settings: {
        autoscaling_limit_min_cu: DEFAULTS.minCu,
        autoscaling_limit_max_cu: DEFAULTS.maxCu,
        suspend_timeout_seconds: DEFAULTS.suspendSeconds,
      },
    },
  };

  console.log(
    `Creating "${projectName}" in ${DEFAULTS.region}, Postgres ${DEFAULTS.pgVersion}, ` +
    `${DEFAULTS.minCu}-${DEFAULTS.maxCu} CU, autosuspend ${DEFAULTS.suspendSeconds}s...`
  );
  const created = await api('/projects', { method: 'POST', body: JSON.stringify(body) });

  const project = created.project;
  console.log(`\nCreated ${project.id} (${project.name})`);
  console.log(`  region      ${project.region_id}`);
  console.log(`  pg_version  ${project.pg_version}`);
  console.log(`  branch      ${created.branch?.name} (${created.branch?.id})`);
  console.log(`  database    ${created.databases?.[0]?.name}`);
  console.log(`  role        ${created.roles?.[0]?.name}`);

  console.log('\nConnection strings:');
  for (const c of created.connection_uris ?? []) {
    const pooled = c.connection_uri.includes('-pooler.');
    console.log(`  ${pooled ? 'pooled ' : 'direct '} ${c.connection_uri}`);
  }
  console.log(
    '\nUse the POOLED string for DATABASE_URL (the app opens short-lived connections\n' +
    'from serverless functions). Keep the direct one for migrations and psql.'
  );
}

async function cmdUri(projectId) {
  if (!projectId) {
    console.error('Usage: node scripts/neon-provision.mjs uri <project_id>');
    process.exit(2);
  }
  const { branches } = await api(`/projects/${projectId}/branches`);
  const branch = branches.find((b) => b.default) ?? branches[0];
  const { databases } = await api(`/projects/${projectId}/branches/${branch.id}/databases`);
  const db = databases[0];

  for (const pooled of [true, false]) {
    const q = new URLSearchParams({
      branch_id: branch.id,
      database_name: db.name,
      role_name: db.owner_name,
      pooled: String(pooled),
    });
    const { uri } = await api(`/projects/${projectId}/connection_uri?${q}`);
    console.log(`${pooled ? 'pooled ' : 'direct '} ${uri}`);
  }
}

const [command = 'list', arg] = process.argv.slice(2);
try {
  if (command === 'list') await cmdList();
  else if (command === 'create') await cmdCreate(arg);
  else if (command === 'uri') await cmdUri(arg);
  else {
    console.error(`Unknown command "${command}". Expected: list | create | uri`);
    process.exit(2);
  }
} catch (error) {
  console.error(`\n${error.message}`);
  if (/401|403/.test(error.message)) {
    console.error('Check that NEON_API_KEY is valid and, for an org account, that it has project permissions.');
  }
  process.exit(1);
}
