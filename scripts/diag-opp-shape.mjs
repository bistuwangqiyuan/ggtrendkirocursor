import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });
const r = await pool.query(
    `SELECT content_json->'opportunities'->0 AS o FROM bp_reports
     WHERE status='completed' AND content_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
);
console.log(JSON.stringify(r.rows[0].o, null, 1));
await pool.end();
