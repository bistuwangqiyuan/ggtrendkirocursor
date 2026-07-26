#!/usr/bin/env node
/**
 * Read-only audit of the shared Neon project.
 *
 * Answers the question the migration plan hinges on: is the sibling application
 * still active, how much of the shared project does it hold, and is any table
 * genuinely co-owned? Neon's free allowance (100 CU-hours + 0.5 GB) is per
 * PROJECT, so anything the sibling does is charged against this site's budget.
 *
 * Writes nothing. Run it before and after a migration.
 *
 * Usage (PowerShell):
 *   $env:AUDIT_DATABASE_URL="postgresql://...";  node scripts/neon-audit.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const URL_ = process.env.AUDIT_DATABASE_URL || process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
if (!URL_) {
  console.error('AUDIT_DATABASE_URL (or DATABASE_URL) is required.');
  process.exit(2);
}

const { OWNED_TABLES } = await import(new URL('../src/lib/db/schema.ts', import.meta.url).href)
  .catch(() => {
    console.error('Run through tsx: npx tsx scripts/neon-audit.mjs');
    process.exit(2);
  });
const OURS = new Set(OWNED_TABLES);

const sslDisabled = /[?&]sslmode=disable\b/i.test(URL_);
const client = new Client({
  connectionString: URL_,
  ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
});
await client.connect();

// ---- 1. Who owns what, how big, and how recently written --------------------

const { rows: tables } = await client.query(
  `SELECT c.relname AS table, c.reltuples::bigint AS est_rows,
          pg_total_relation_size(c.oid) AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`
);

const { rows: tsCols } = await client.query(
  `SELECT table_name, column_name
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type LIKE 'timestamp%'
      AND column_name IN ('created_at', 'updated_at', 'checked_at', 'timestamp')`
);
const colsByTable = new Map();
for (const r of tsCols) {
  colsByTable.set(r.table_name, [...(colsByTable.get(r.table_name) ?? []), r.column_name]);
}

let oursBytes = 0, theirsBytes = 0;
const report = [];
for (const t of tables) {
  const cols = colsByTable.get(t.table) ?? [];
  let last = null;
  if (cols.length) {
    const expr = cols.map((c) => `MAX("${c}")`).join(', ');
    const { rows } = await client.query(
      `SELECT ${cols.length > 1 ? `GREATEST(${expr})` : expr} AS last FROM "${t.table}"`
    );
    last = rows[0]?.last ?? null;
  }
  const mine = OURS.has(t.table);
  mine ? (oursBytes += Number(t.bytes)) : (theirsBytes += Number(t.bytes));
  report.push({
    table: t.table,
    owner: mine ? 'ours' : 'sibling',
    rows: Number(t.est_rows),
    mb: +(Number(t.bytes) / 1048576).toFixed(2),
    lastWrite: last ? new Date(last).toISOString() : null,
  });
}

report.sort((a, b) => (b.lastWrite ?? '').localeCompare(a.lastWrite ?? ''));
console.log('owner    | table                      | rows    | MB     | last write');
for (const r of report) {
  console.log(
    `${r.owner.padEnd(8)} | ${r.table.padEnd(26)} | ${String(r.rows).padStart(7)} | ` +
    `${String(r.mb).padStart(6)} | ${r.lastWrite ?? '-'}`
  );
}

const totalMb = (oursBytes + theirsBytes) / 1048576;
console.log(
  `\nstorage: ours=${(oursBytes / 1048576).toFixed(1)}MB sibling=${(theirsBytes / 1048576).toFixed(1)}MB ` +
  `total=${totalMb.toFixed(1)}MB of 512MB free-plan cap ` +
  `(sibling holds ${((theirsBytes / (oursBytes + theirsBytes)) * 100).toFixed(0)}%)`
);

const now = Date.now();
const siblingRecent = report.filter(
  (r) => r.owner === 'sibling' && r.lastWrite && now - Date.parse(r.lastWrite) < 7 * 86400e3
);
console.log(
  `sibling tables written in the last 7 days: ${siblingRecent.length}` +
  (siblingRecent.length ? ` (${siblingRecent.map((r) => r.table).join(', ')})` : '')
);
console.log(
  siblingRecent.length
    ? 'VERDICT: the sibling application is active. Every write of theirs wakes the shared\n' +
      '         compute and resets its 5-minute idle timer, so this site cannot be held to a\n' +
      '         compute budget while the project is shared.'
    : 'VERDICT: no recent sibling writes detected in this window.'
);

// ---- 2. Co-ownership: foreign keys that cross the app boundary ---------------

const { rows: fks } = await client.query(
  `SELECT tc.table_name AS child, ccu.table_name AS parent, kcu.column_name AS col
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
);
const crossing = fks.filter((fk) => OURS.has(fk.child) !== OURS.has(fk.parent));
console.log('\nforeign keys crossing the app boundary:');
if (!crossing.length) console.log('  (none)');
for (const fk of crossing) {
  console.log(
    `  ${fk.child}.${fk.col} -> ${fk.parent}  ` +
    `(${OURS.has(fk.child) ? 'ours' : 'sibling'} -> ${OURS.has(fk.parent) ? 'ours' : 'sibling'})`
  );
}
if (crossing.length) {
  console.log(
    '  A crossing key means the table is co-owned. Migrating it forks the data: each\n' +
    '  side keeps a full copy and they stop converging. Confirm that is intended.'
  );
}

await client.end();
