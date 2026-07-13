// List all bp_opportunities-like tables across schemas + current search_path.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });

console.log('search_path:', (await pool.query('SHOW search_path')).rows[0].search_path);
console.log('current_database:', (await pool.query('SELECT current_database() db')).rows[0].db);

const r = await pool.query(
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE 'bp_opportunit%' ORDER BY 1,2`,
);
console.table(r.rows);

for (const row of r.rows) {
    const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
        [row.table_schema, row.table_name],
    );
    const cnt = await pool.query(`SELECT COUNT(*)::int c FROM "${row.table_schema}"."${row.table_name}"`);
    console.log(`${row.table_schema}.${row.table_name} (${cnt.rows[0].c} rows):`, cols.rows.map((c) => c.column_name).join(', '));
}
await pool.end();
