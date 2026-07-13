// Export a compact, committable snapshot of all completed BP reports for the
// opportunity-analysis report. Usage: node scripts/export-bp-snapshot.mjs
// Writes docs/data/bp-snapshot-YYYY-MM-DD.json (fields only, no full prose).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const pool = new pg.Pool({ connectionString: env.NETLIFY_DATABASE_URL, max: 1 });

const { rows } = await pool.query(`
  SELECT r.id, r.keyword, r.title, r.selected_opportunity, r.created_at,
         COALESCE(r.content_json, c.content_json) AS content
  FROM bp_reports r
  LEFT JOIN bp_reports c ON r.canonical_report_id = c.id
  WHERE r.status = 'completed'
  ORDER BY r.created_at ASC
`);

const num = (s) => {
    if (typeof s === 'number') return s;
    if (typeof s !== 'string') return null;
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
};

const reports = rows.map((r) => {
    const c = r.content || {};
    const sr = c.seedReturn || {};
    const opps = Array.isArray(c.opportunities) ? c.opportunities : [];
    const winNums = String(sr.winRate ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return {
        id: r.id,
        keyword: r.keyword,
        title: r.title,
        selectedOpportunity: r.selected_opportunity,
        createdAt: r.created_at,
        // Deterministic inputs for Python-side recomputation:
        bookRoiByYear: Array.isArray(sr.bookRoiByYear) ? sr.bookRoiByYear.map(num) : null,
        winRateRange: winNums.length ? [Math.min(...winNums), Math.max(...winNums)] : null,
        // LLM self-reported figures (kept for honesty comparison, NOT used as truth):
        reportedEvMoic: num(sr.expectedValueMOIC),
        reportedRiskAdjustedPct: num(sr.riskAdjustedAnnualized),
        opportunities: opps.map((o) => ({
            name: o.name,
            weightedScore: num(o.weightedScore ?? o.totalScore),
            isSelected: !!o.isSelected,
            scores: {
                market: num(o.scores?.market ?? o.scores?.marketSize ?? o.scoreMarket),
                roi: num(o.scores?.roi ?? o.scoreRoi),
                onlineability: num(o.scores?.onlineability ?? o.scoreOnlineability),
                feasibility: num(o.scores?.feasibility ?? o.scoreFeasibility),
                speed: num(o.scores?.speed ?? o.scoreSpeed),
                moat: num(o.scores?.moat ?? o.scoreMoat),
            },
        })),
    };
});

mkdirSync('docs/data', { recursive: true });
const date = new Date().toISOString().slice(0, 10);
const file = `docs/data/bp-snapshot-${date}.json`;
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), source: 'bp_reports (status=completed)', count: reports.length, reports }, null, 1));
console.log(`wrote ${file}: ${reports.length} completed reports`);
await pool.end();
