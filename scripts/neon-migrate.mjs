#!/usr/bin/env node
/**
 * Copy this site's nine tables into a fresh Neon project, so its compute quota
 * stops being shared with the sibling application.
 *
 * WHY THIS EXISTS
 * Neon's 100 CU-hours/month allowance is per PROJECT. The current project holds
 * 19 tables, 10 of which belong to another application that is still active
 * (verified by comparing the repo's 2026-07-04 health snapshot against a live
 * one: `bp_opportunities_legacy` appeared in between). Every saving this refactor
 * makes can be eaten by that app, and acceptance criterion #4 ("observe a full
 * billing period under 100 CU-h") cannot be attributed to either app while they
 * share a meter.
 *
 * WHY NOT pg_dump
 * pg_dump must match the server's major version and is not installed on most
 * Windows dev machines. This script uses the same `pg` client the app already
 * depends on, so it runs anywhere `npm install` has run. It only ever reads from
 * the source: nothing is dropped or modified there.
 *
 * Usage (PowerShell):
 *   $env:SOURCE_DATABASE_URL="postgresql://...old-project..."
 *   $env:TARGET_DATABASE_URL="postgresql://...new-project..."
 *   node scripts/neon-migrate.mjs --dry-run   # counts only, writes nothing
 *   node scripts/neon-migrate.mjs             # create schema + copy rows
 *   node scripts/neon-migrate.mjs --verify    # re-compare row counts afterwards
 *
 * Then set DATABASE_URL to the new project in the Netlify dashboard and redeploy.
 * Keep the old project untouched until the new one has served a full cron cycle.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const BATCH_ROWS = 500;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const VERIFY_ONLY = args.has('--verify');

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;

/** Load the schema DDL from the app's single source of truth. */
async function loadSchema() {
  // tsx registers a TypeScript loader; run this script through `npx tsx` if the
  // plain `node` import of a .ts module fails on your Node version.
  const url = new URL('../src/lib/db/schema.ts', import.meta.url).href;
  try {
    return await import(url);
  } catch (error) {
    console.error(
      'Could not import src/lib/db/schema.ts directly.\n' +
      'Re-run with: npx tsx scripts/neon-migrate.mjs\n' +
      'Original error: ' + error.message
    );
    process.exit(2);
  }
}

function connect(url) {
  // Neon requires TLS; its certificate chain is standard, but sslmode in the URL
  // is honoured by pg only for `require`, so be explicit.
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function tableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function rowCount(client, table) {
  try {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0].n;
  } catch {
    return null; // table absent
  }
}

async function copyTable(source, target, table) {
  const srcCols = await tableColumns(source, table);
  const dstCols = await tableColumns(target, table);
  if (srcCols.length === 0) return { copied: 0, note: 'absent in source' };
  if (dstCols.length === 0) return { copied: 0, note: 'absent in target (schema step failed?)' };

  // Only columns present on both sides, so a schema that has drifted in either
  // direction degrades to a partial copy instead of failing the whole run.
  const cols = srcCols.filter((c) => dstCols.includes(c));
  const skipped = srcCols.filter((c) => !dstCols.includes(c));
  const colList = cols.map((c) => `"${c}"`).join(', ');

  let copied = 0;
  let offset = 0;
  for (;;) {
    // Ordering by ctid keeps pagination stable without assuming a sortable key.
    const { rows } = await source.query(
      `SELECT ${colList} FROM ${table} ORDER BY ctid LIMIT ${BATCH_ROWS} OFFSET ${offset}`
    );
    if (rows.length === 0) break;

    const values = [];
    const tuples = rows.map((row, i) => {
      const placeholders = cols.map((_, j) => `$${i * cols.length + j + 1}`);
      for (const c of cols) values.push(row[c]);
      return `(${placeholders.join(', ')})`;
    });
    // ON CONFLICT DO NOTHING makes the whole script re-runnable: an interrupted
    // copy can simply be started again.
    await target.query(
      `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values
    );
    copied += rows.length;
    offset += rows.length;
    process.stdout.write(`\r  ${table}: ${copied} rows`);
  }
  if (copied) process.stdout.write('\n');
  return { copied, note: skipped.length ? `skipped columns: ${skipped.join(', ')}` : '' };
}

async function main() {
  if (!SOURCE_URL) {
    console.error('SOURCE_DATABASE_URL (or DATABASE_URL) is required.');
    process.exit(2);
  }
  if (!TARGET_URL && !DRY_RUN) {
    console.error('TARGET_DATABASE_URL is required (or pass --dry-run).');
    process.exit(2);
  }

  const { BASE_STATEMENTS, OWNED_TABLES } = await loadSchema();

  const source = connect(SOURCE_URL);
  await source.connect();
  console.log('Connected to SOURCE.');

  const before = {};
  for (const table of OWNED_TABLES) before[table] = await rowCount(source, table);
  console.log('\nSource row counts (only tables this site owns):');
  for (const [t, n] of Object.entries(before)) {
    console.log(`  ${t.padEnd(26)} ${n === null ? 'ABSENT' : n}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing was written. Set TARGET_DATABASE_URL and re-run to migrate.');
    await source.end();
    return;
  }

  const target = connect(TARGET_URL);
  await target.connect();
  console.log('\nConnected to TARGET.');

  if (!VERIFY_ONLY) {
    console.log('\nCreating schema in TARGET (idempotent)...');
    for (const stmt of BASE_STATEMENTS) {
      const label = stmt.split('\n')[0].trim().slice(0, 62);
      try {
        await target.query(stmt);
      } catch (e) {
        console.log(`  SKIP ${label} -> ${e.message}`);
      }
    }

    console.log('\nCopying rows (parents before children, so foreign keys hold)...');
    for (const table of OWNED_TABLES) {
      const { copied, note } = await copyTable(source, target, table);
      if (!copied) console.log(`  ${table.padEnd(26)} 0 rows${note ? ' (' + note + ')' : ''}`);
      else if (note) console.log(`  ${table}: ${note}`);
    }
  }

  console.log('\nVerification (source -> target):');
  let mismatch = 0;
  for (const table of OWNED_TABLES) {
    const src = before[table];
    const dst = await rowCount(target, table);
    const ok = src === null ? dst === null || dst === 0 : dst >= src;
    if (!ok) mismatch++;
    console.log(`  ${table.padEnd(26)} ${src ?? 'ABSENT'} -> ${dst ?? 'ABSENT'}  ${ok ? 'OK' : 'MISMATCH'}`);
  }

  await source.end();
  await target.end();

  if (mismatch) {
    console.error(`\n${mismatch} table(s) did not fully copy. Re-run the script; it is idempotent.`);
    process.exit(1);
  }
  console.log('\nAll owned tables copied.\n\nNext steps (manual, by design):');
  console.log('  1. Set DATABASE_URL to the new project in the Netlify dashboard.');
  console.log('  2. Redeploy, then POST /api/db-init?secret=$ADMIN_SECRET to confirm the schema.');
  console.log('  3. Trigger one cron cycle and check /api/snapshots/status is fresh.');
  console.log('  4. Leave the old project untouched for a few days as a rollback path.');
}

main().catch((e) => {
  console.error('\nMigration failed:', e.message);
  process.exit(1);
});
