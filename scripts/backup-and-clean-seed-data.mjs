// Backup, then delete synthetic seed data from the production database:
//   1. google_trends rows whose keyword ends in "(4h)"/"(24h)"/"(48h)" —
//      one-off fabricated seed rows from 2026-06-05 with multi-million fake
//      search volumes that dominated the dashboard's default sort and wedged
//      the BP picker (the July 2026 "AI breakthrough (4h)" stuck-report loop).
//   2. bp_reports rows generated FROM those fake keywords (all failed/stuck;
//      no completed real content is touched).
//
// Backups are written to backups/ as timestamped JSON before any DELETE.
// Usage: node scripts/backup-and-clean-seed-data.mjs [--apply]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import pg from 'pg';

const apply = process.argv.includes('--apply');
const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });

const SEED_KEYWORD_RE = '\\((4h|24h|48h)\\)$';

const seedTrends = await pool.query(
    `SELECT * FROM google_trends WHERE keyword ~ $1 ORDER BY created_at`,
    [SEED_KEYWORD_RE],
);
const seedReports = await pool.query(
    `SELECT * FROM bp_reports WHERE keyword ~ $1 ORDER BY created_at`,
    [SEED_KEYWORD_RE],
);
console.log(`seed google_trends rows: ${seedTrends.rows.length}`);
console.log(`seed bp_reports rows: ${seedReports.rows.length} (statuses: ${[...new Set(seedReports.rows.map((r) => r.status))].join(', ')})`);

const completedSeedReports = seedReports.rows.filter((r) => r.status === 'completed');
if (completedSeedReports.length > 0) {
    console.log(`NOTE: ${completedSeedReports.length} seed reports are 'completed' — these will be backed up and deleted too (content derived from fake keywords).`);
}

if (!apply) {
    console.log('dry run only. Re-run with --apply to backup + delete.');
    await pool.end();
    process.exit(0);
}

mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`backups/seed-google-trends-${stamp}.json`, JSON.stringify(seedTrends.rows, null, 1));
writeFileSync(`backups/seed-bp-reports-${stamp}.json`, JSON.stringify(seedReports.rows, null, 1));
console.log(`backed up to backups/seed-*-${stamp}.json`);

const delReports = await pool.query(`DELETE FROM bp_reports WHERE keyword ~ $1 RETURNING id`, [SEED_KEYWORD_RE]);
const delTrends = await pool.query(`DELETE FROM google_trends WHERE keyword ~ $1 RETURNING id`, [SEED_KEYWORD_RE]);
console.log(`deleted ${delReports.rows.length} bp_reports rows and ${delTrends.rows.length} google_trends rows`);
await pool.end();
