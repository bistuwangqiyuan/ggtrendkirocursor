// Quick check: bp_reports rows created in the last N minutes (default 30).
import { readFileSync } from 'node:fs';
import pg from 'pg';

const minutes = Number(process.argv[2] || 30);
const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });
const r = await pool.query(
    `SELECT id, keyword, status, LEFT(error, 160) err, model, created_at, updated_at
     FROM bp_reports WHERE created_at > NOW() - make_interval(mins => $1) OR updated_at > NOW() - make_interval(mins => $1)
     ORDER BY updated_at DESC LIMIT 20`,
    [minutes],
);
console.table(r.rows);
await pool.end();
