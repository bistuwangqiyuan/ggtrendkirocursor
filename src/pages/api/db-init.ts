import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';
import { authorizeAdminRequest } from '../../lib/utils/adminAuth';

// Base (idempotent) schema. Safe to run repeatedly; CREATE ... IF NOT EXISTS.
const BASE_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    locale VARCHAR(5) DEFAULT 'zh',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)`,
  // Trends storage. Production Neon happened to have this table pre-created by
  // a sibling app; a fresh database (e.g. local real-function testing) did not,
  // which 500'd the collector. Schema matches the production google_trends
  // table (trend_timestamp column) that the app auto-detects.
  `CREATE TABLE IF NOT EXISTS google_trends (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword TEXT NOT NULL,
    search_volume BIGINT NOT NULL DEFAULT 0,
    growth_rate NUMERIC(10, 2) DEFAULT 0,
    time_range VARCHAR(20),
    category TEXT,
    region VARCHAR(10) DEFAULT 'US',
    traffic_source TEXT,
    related_queries JSONB,
    trend_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_created_at ON google_trends(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_search_volume ON google_trends(search_volume)`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_time_range ON google_trends(time_range)`,
  `CREATE INDEX IF NOT EXISTS idx_google_trends_keyword ON google_trends(keyword)`,
  // Hot word -> BP feature tables (additive; do not modify existing tables).
  `CREATE TABLE IF NOT EXISTS bp_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword VARCHAR(200) NOT NULL,
    keyword_norm VARCHAR(200),
    source_trend_id VARCHAR(100),
    search_volume BIGINT,
    growth_rate NUMERIC,
    category VARCHAR(100),
    time_range VARCHAR(20),
    region VARCHAR(50),
    rank INT,
    status VARCHAR(20) DEFAULT 'pending',
    title TEXT,
    summary TEXT,
    selected_opportunity TEXT,
    content_json JSONB,
    business_model_norm VARCHAR(300),
    canonical_report_id UUID,
    model VARCHAR(100),
    tokens_used INT,
    error TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE bp_reports ADD COLUMN IF NOT EXISTS business_model_norm VARCHAR(300)`,
  `ALTER TABLE bp_reports ADD COLUMN IF NOT EXISTS canonical_report_id UUID`,
  // NOTE: named bp_report_opportunities (NOT bp_opportunities) — a sibling app
  // sharing this Neon database periodically recreates `bp_opportunities` with
  // its own legacy schema (plan_id/scores jsonb), which clobbered our data.
  `CREATE TABLE IF NOT EXISTS bp_report_opportunities (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_keyword_norm ON bp_reports(keyword_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_status ON bp_reports(status)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_created_at ON bp_reports(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_user_id ON bp_reports(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_business_model_norm ON bp_reports(business_model_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_report_opportunities_report_id ON bp_report_opportunities(report_id)`,
  `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email ON newsletter_subscribers(email)`,
];

// Columns the application code requires on each table.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'username', 'email', 'password_hash', 'locale', 'created_at', 'updated_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token', 'expires_at', 'created_at', 'ip_address', 'user_agent'],
  feedback: ['id', 'user_id', 'name', 'email', 'subject', 'message', 'status', 'created_at'],
  bp_reports: ['id', 'keyword', 'keyword_norm', 'source_trend_id', 'search_volume', 'growth_rate', 'category', 'time_range', 'region', 'rank', 'status', 'title', 'summary', 'selected_opportunity', 'content_json', 'business_model_norm', 'canonical_report_id', 'model', 'tokens_used', 'error', 'user_id', 'created_at', 'updated_at'],
  bp_report_opportunities: ['id', 'report_id', 'name', 'description', 'score_market', 'score_roi', 'score_onlineability', 'score_feasibility', 'score_speed', 'score_moat', 'weighted_score', 'is_selected', 'rank', 'created_at'],
  newsletter_subscribers: ['id', 'email', 'created_at'],
};

// Destructive recreate of the auth/feedback tables (drops mismatched legacy schema).
// Order matters: drop FK-dependent tables before the referenced `users` table.
const RECREATE_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `DROP TABLE IF EXISTS sessions CASCADE`,
  `DROP TABLE IF EXISTS feedback CASCADE`,
  `DROP TABLE IF EXISTS users CASCADE`,
  `CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    locale VARCHAR(5) DEFAULT 'zh',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
  )`,
  `CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT
  )`,
  `CREATE TABLE feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)`,
];

// Destructive recreate of the BP feature tables (drops child before parent).
// Only OUR tables are dropped — bp_opportunities belongs to a sibling app
// sharing this database and must not be touched.
const RECREATE_BP_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  `DROP TABLE IF EXISTS bp_report_opportunities CASCADE`,
  `DROP TABLE IF EXISTS bp_reports CASCADE`,
  `CREATE TABLE bp_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword VARCHAR(200) NOT NULL,
    keyword_norm VARCHAR(200),
    source_trend_id VARCHAR(100),
    search_volume BIGINT,
    growth_rate NUMERIC,
    category VARCHAR(100),
    time_range VARCHAR(20),
    region VARCHAR(50),
    rank INT,
    status VARCHAR(20) DEFAULT 'pending',
    title TEXT,
    summary TEXT,
    selected_opportunity TEXT,
    content_json JSONB,
    business_model_norm VARCHAR(300),
    canonical_report_id UUID,
    model VARCHAR(100),
    tokens_used INT,
    error TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE bp_report_opportunities (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_keyword_norm ON bp_reports(keyword_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_status ON bp_reports(status)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_created_at ON bp_reports(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_user_id ON bp_reports(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_reports_business_model_norm ON bp_reports(business_model_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_bp_report_opportunities_report_id ON bp_report_opportunities(report_id)`,
];

async function inspectColumns(client: any): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    try {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      out[table] = cols.rows.map((r: any) => r.column_name);
    } catch (e: any) {
      out[table] = [`<error: ${e.message}>`];
    }
  }
  return out;
}

function detectMismatches(before: Record<string, string[]>): Record<string, string[]> {
  const mismatches: Record<string, string[]> = {};
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const have = before[table] ?? [];
    const missing = required.filter((c) => !have.includes(c));
    if (missing.length > 0) mismatches[table] = missing;
  }
  return mismatches;
}

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status });
  }

  const migrateParam = url.searchParams.get('migrate'); // 'auth' | 'bp' | null

  let client: any;
  try {
    client = await pool.connect();

    const before = await inspectColumns(client);
    const mismatches = detectMismatches(before);

    const statements = migrateParam === 'auth'
      ? RECREATE_STATEMENTS
      : migrateParam === 'bp'
        ? RECREATE_BP_STATEMENTS
        : BASE_STATEMENTS;
    const results: string[] = [];
    for (const stmt of statements) {
      const label = stmt.split('\n').find((l) => l.trim())?.trim().substring(0, 60) ?? '';
      try {
        await client.query(stmt);
        results.push(`OK: ${label}`);
      } catch (e: any) {
        results.push(`SKIP: ${label} -> ${e.message}`);
      }
    }

    const after = await inspectColumns(client);

    return new Response(JSON.stringify({
      success: true,
      mode: migrateParam === 'auth' ? 'recreate-auth' : migrateParam === 'bp' ? 'recreate-bp' : 'idempotent',
      detectedMismatches: mismatches,
      before,
      after,
      details: results,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('DB init error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      detail: error.detail || null,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } finally {
    if (client) client.release();
  }
};
