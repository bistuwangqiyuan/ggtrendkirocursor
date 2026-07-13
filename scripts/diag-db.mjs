// One-off production DB diagnostics for the BP pipeline outage investigation.
// Read-only. Usage: node scripts/diag-db.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 2 });

const q = async (label, sql, params = []) => {
    const r = await pool.query(sql, params);
    console.log(`\n=== ${label} ===`);
    console.table(r.rows);
};

await q('bp_reports by status', `SELECT status, COUNT(*) cnt, MIN(created_at) first, MAX(created_at) last FROM bp_reports GROUP BY status ORDER BY cnt DESC`);
await q(
    'last 15 bp_reports',
    `SELECT id, keyword, status, LEFT(error, 100) err, created_at, updated_at FROM bp_reports ORDER BY created_at DESC LIMIT 15`,
);
await q(
    'daily bp production (last 30d)',
    `SELECT DATE(created_at) AS day, COUNT(*) total, COUNT(*) FILTER (WHERE status='completed') completed, COUNT(*) FILTER (WHERE status='failed') failed
     FROM bp_reports WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1 DESC`,
);
await q(
    'recent failed reports w/ errors',
    `SELECT keyword, status, LEFT(error, 160) err, created_at FROM bp_reports WHERE status='failed' ORDER BY created_at DESC LIMIT 25`,
);
await q(
    'trends: latest collected',
    `SELECT keyword, search_volume, region, time_range, trend_timestamp, created_at FROM google_trends ORDER BY created_at DESC LIMIT 8`,
);
await q(
    'trends: seed-like rows count',
    `SELECT COUNT(*) cnt FROM google_trends WHERE keyword ~ '\\((4h|24h|48h)\\)$'`,
);
await q(
    'trends daily collection (last 30d)',
    `SELECT DATE(created_at) AS day, COUNT(*) cnt FROM google_trends WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
);
await pool.end();
