// Create the app-owned bp_report_opportunities table (idempotent).
// Named distinctly from `bp_opportunities`, which belongs to a sibling app
// sharing this Neon database and is periodically dropped/recreated by it.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });

await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
await pool.query(`CREATE TABLE IF NOT EXISTS bp_report_opportunities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id UUID NOT NULL REFERENCES bp_reports(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    score_market NUMERIC,
    score_roi NUMERIC,
    score_onlineability NUMERIC,
    score_feasibility NUMERIC,
    score_speed NUMERIC,
    score_moat NUMERIC,
    weighted_score NUMERIC,
    is_selected BOOLEAN DEFAULT false,
    rank INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
)`);
await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_bp_report_opportunities_report_id ON bp_report_opportunities(report_id)`,
);
const r = await pool.query(`SELECT COUNT(*)::int c FROM bp_report_opportunities`);
console.log('bp_report_opportunities ready, rows:', r.rows[0].c);
await pool.end();
