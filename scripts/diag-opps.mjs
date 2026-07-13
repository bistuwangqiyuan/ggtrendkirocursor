// Inspect current bp_opportunities / _legacy contents to understand which
// dataset each holds.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });

for (const t of ['bp_opportunities', 'bp_opportunities_legacy']) {
    const r = await pool.query(`SELECT * FROM "${t}" ORDER BY created_at DESC LIMIT 3`);
    console.log(`--- ${t} newest 3 rows ---`);
    for (const row of r.rows) {
        console.log(JSON.stringify(row).slice(0, 220));
    }
    const range = await pool.query(`SELECT MIN(created_at) min, MAX(created_at) max, COUNT(*)::int c FROM "${t}"`);
    console.log('range:', JSON.stringify(range.rows[0]));
}
await pool.end();
