// Verify a report end-to-end at the DB level: report row + its opportunity
// rows in bp_report_opportunities. Usage: node scripts/diag-report-detail.mjs <id>
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
const r = await pool.query(`SELECT id, keyword, status, title, business_model_norm, model, tokens_used FROM bp_reports WHERE id=$1`, [id]);
console.log(JSON.stringify(r.rows[0], null, 1).slice(0, 600));
const o = await pool.query(
    `SELECT rank, name, weighted_score, is_selected FROM bp_report_opportunities WHERE report_id=$1 ORDER BY rank`,
    [id],
);
console.table(o.rows);
await pool.end();
