// Print column definitions for a table. Usage: node scripts/diag-schema.mjs bp_reports
import { readFileSync } from 'node:fs';
import pg from 'pg';

const table = process.argv[2] || 'bp_reports';
const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });
const r = await pool.query(
    `SELECT column_name, data_type, character_maximum_length
     FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
);
for (const row of r.rows) console.log(row.column_name, row.data_type, row.character_maximum_length ?? '');
await pool.end();
