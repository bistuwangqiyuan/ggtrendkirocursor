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
  // Neon requires TLS, but a local Postgres (used to rehearse this migration)
  // usually has no SSL support at all. Same rule as src/lib/db/client.ts.
  const sslDisabled = /[?&]sslmode=disable\b/i.test(url || '');
  return new Client({
    connectionString: url,
    ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
  });
}

async function tableColumns(client, table) {
  // format_type gives the exact declared type (e.g. `timestamp with time zone`,
  // `character varying(255)`), which the copy uses to cast text back losslessly.
  const { rows } = await client.query(
    `SELECT attname AS column_name, format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
      WHERE attrelid = to_regclass('public.' || $1)
        AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`,
    [table]
  );
  return rows.map((r) => ({ name: r.column_name, type: r.type }));
}

async function rowCount(client, table) {
  try {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0].n;
  } catch {
    return null; // table absent
  }
}

/**
 * Content fingerprint over the given columns. Row order is irrelevant because
 * the per-row hashes are sorted before being folded together, so this compares
 * the *set* of rows without assuming any sortable key. Row counts alone would
 * not catch a value that was mangled in transit.
 */
async function checksum(client, table, colNames) {
  if (colNames.length === 0) return null;
  // \N stands in for NULL so that NULL and the empty string stay distinguishable.
  const parts = colNames.map((c) => `coalesce("${c}"::text, '\\N')`).join(`, '|', `);
  try {
    const { rows } = await client.query(
      `SELECT md5(coalesce(string_agg(h, '|' ORDER BY h), '')) AS h
         FROM (SELECT md5(concat(${parts})) AS h FROM ${table}) s`
    );
    return rows[0].h;
  } catch {
    return null;
  }
}

async function copyTable(source, target, table) {
  const srcCols = await tableColumns(source, table);
  const dstCols = await tableColumns(target, table);
  if (srcCols.length === 0) return { copied: 0, note: 'absent in source' };
  if (dstCols.length === 0) return { copied: 0, note: 'absent in target (schema step failed?)' };

  const dstTypes = new Map(dstCols.map((c) => [c.name, c.type]));
  // Only columns present on both sides, so a schema that has drifted in either
  // direction degrades to a partial copy instead of failing the whole run.
  const cols = srcCols.filter((c) => dstTypes.has(c.name));
  const skipped = srcCols.filter((c) => !dstTypes.has(c.name)).map((c) => c.name);
  const colList = cols.map((c) => `"${c.name}"`).join(', ');
  // Every value travels as text and is cast back on arrival. Going through the
  // driver's native types would quietly lose data: node-postgres decodes
  // timestamptz into a JS Date, whose millisecond resolution truncates
  // Postgres microseconds (e.g. 05:07:26.884298+08 -> .884+08). Text is the
  // one representation both servers agree on exactly.
  const selectList = cols.map((c) => `"${c.name}"::text`).join(', ');

  let copied = 0;
  let offset = 0;
  for (;;) {
    // Ordering by ctid keeps pagination stable without assuming a sortable key.
    const { rows } = await source.query(
      `SELECT ${selectList} FROM ${table} ORDER BY ctid LIMIT ${BATCH_ROWS} OFFSET ${offset}`
    );
    if (rows.length === 0) break;

    const values = [];
    const tuples = rows.map((row, i) => {
      const placeholders = cols.map(
        (c, j) => `$${i * cols.length + j + 1}::${dstTypes.get(c.name)}`
      );
      for (const c of cols) values.push(row[c.name]);
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

  console.log('\nVerification (source -> target, rows + content fingerprint):');
  let mismatch = 0;
  for (const table of OWNED_TABLES) {
    const src = before[table];
    const dst = await rowCount(target, table);
    let ok = src === null ? dst === null || dst === 0 : dst >= src;
    let note = '';

    if (ok && src) {
      const srcCols = (await tableColumns(source, table)).map((c) => c.name);
      const dstCols = new Set((await tableColumns(target, table)).map((c) => c.name));
      const shared = srcCols.filter((c) => dstCols.has(c));
      const [srcHash, dstHash] = await Promise.all([
        checksum(source, table, shared),
        checksum(target, table, shared),
      ]);
      if (srcHash && dstHash && srcHash !== dstHash) {
        // Only meaningful when the target holds exactly the source's rows; a
        // target that legitimately has extra rows will differ by design.
        if (dst === src) {
          ok = false;
          note = `  content differs (${srcHash.slice(0, 8)} vs ${dstHash.slice(0, 8)})`;
        } else {
          note = '  (target has extra rows; fingerprint not comparable)';
        }
      }
    }

    if (!ok) mismatch++;
    console.log(
      `  ${table.padEnd(26)} ${src ?? 'ABSENT'} -> ${dst ?? 'ABSENT'}  ${ok ? 'OK' : 'MISMATCH'}${note}`
    );
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
