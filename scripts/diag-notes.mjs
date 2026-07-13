// Print seedReturn from a report's content_json. Usage: node scripts/diag-notes.mjs <id>
import { readFileSync } from 'node:fs';
import pg from 'pg';

const id = process.argv[2];
const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });
const r = await pool.query(`SELECT content_json->'seedReturn' seed FROM bp_reports WHERE id=$1`, [id]);
console.log(JSON.stringify(r.rows[0]?.seed, null, 1));
await pool.end();
