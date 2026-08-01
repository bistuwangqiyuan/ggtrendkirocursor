/**
 * The eleven tables this site owns, as executable DDL.
 *
 * Single source of truth, shared by `/api/db-init` (provision / repair), the
 * maintenance job (which backfills tables missing in production) and
 * `scripts/neon-migrate.mjs` (which recreates the schema in a new Neon project).
 * Keeping one copy is the point: when these lists lived only inside the db-init
 * endpoint, the production database drifted from them silently — that is how
 * `newsletter_subscribers` ended up defined but never created.
 *
 * The Neon project also hosts a sibling application's tables. Nothing here
 * touches a table this site does not own.
 */

/** Tables owned by this application, parents before children. */
export const OWNED_TABLES = [
  'users',
  'sessions',
  'feedback',
  'google_trends',
  'bp_reports',
  'bp_report_opportunities',
  'newsletter_subscribers',
  'monitored_sites',
  'site_checks',
  'ops_alerts',
  'orders',
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];

/**
 * Columns added after the tables were first provisioned.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new column
 * never reaches a live database through the base DDL alone — that is how
 * production drifts. These run on every db-init and on every maintenance pass,
 * so the migration applies itself with no manual step.
 *
 * The trends table is one of two names depending on how the database was
 * provisioned (see getTrendsTableName); the statement for whichever is absent
 * fails harmlessly and is reported as skipped.
 */
export const ADDITIVE_STATEMENTS = [
  `ALTER TABLE google_trends ADD COLUMN IF NOT EXISTS topic_class VARCHAR(20)`,
  `ALTER TABLE trends_trending_now ADD COLUMN IF NOT EXISTS topic_class VARCHAR(20)`,
];

/**
 * Incidents that must outlive the storage they describe.
 *
 * The day log lives in Netlify Blobs, so it cannot record the one failure that
 * hides best: Blobs being unreachable from the scheduled job that writes
 * everything. Postgres is the only store that job is proven able to write in
 * that state, so a handful of rows go here instead. Written rarely and read only
 * on request, so it costs no routine database wake-up.
 */
export const OPS_ALERT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ops_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source VARCHAR(64) NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ops_alerts_created_at ON ops_alerts(created_at DESC)`,
];

/**
 * Paid downloads.
 *
 * The money itself is held by a merchant-of-record platform (Creem, or Lemon
 * Squeezy when Creem cannot open a session), so this table is not an accounting
 * ledger — it is the record of who is entitled to download what, plus enough
 * provider detail to reconcile against their dashboard.
 *
 * `provider_order_id` is UNIQUE because that is what makes the webhook safe:
 * providers retry deliveries, and a payment recorded twice would look like two
 * purchases. `ON CONFLICT (provider_order_id)` turns every retry into an update
 * of the same row.
 *
 * `user_id` is nullable on purpose. Most buyers of a one-dollar file will never
 * create an account, so orders exist independently of `users`, and a logged-in
 * purchase simply also carries the account. `email` is the identity that always
 * exists, which is why the guest lookup is keyed on it.
 */
export const ORDER_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(20) NOT NULL,
    provider_order_id VARCHAR(200) UNIQUE,
    provider_checkout_id VARCHAR(200),
    -- Our own random reference for the attempt, handed to the provider and given
    -- back to the buyer in the success URL. It is how a guest with no account and
    -- no cookie proves, on return, which purchase is theirs.
    reference VARCHAR(64),
    product VARCHAR(40) NOT NULL DEFAULT 'bp_pdf',
    report_id UUID,
    email VARCHAR(255),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    amount_cents INT,
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    download_count INT NOT NULL DEFAULT 0,
    last_downloaded_at TIMESTAMP WITH TIME ZONE,
    paid_at TIMESTAMP WITH TIME ZONE,
    refunded_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  // Lower(email) rather than email: buyers type their address into the provider's
  // checkout and into the lookup form, and the two casings must find each other.
  `CREATE INDEX IF NOT EXISTS idx_orders_email_lower ON orders(LOWER(email))`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_report_id ON orders(report_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_checkout_id ON orders(provider_checkout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference)`,
];

export const NEWSLETTER_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email ON newsletter_subscribers(email)`,
];

// Base (idempotent) schema. Safe to run repeatedly; CREATE ... IF NOT EXISTS.
export const BASE_STATEMENTS = [
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
    topic_class VARCHAR(20),
    traffic_source TEXT,
    related_queries JSONB,
    trend_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  ...ADDITIVE_STATEMENTS,
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
  ...NEWSLETTER_STATEMENTS,
  // Site monitoring (uptime + SEO health of the user's own deployed sites).
  `CREATE TABLE IF NOT EXISTS monitored_sites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    url VARCHAR(500) UNIQUE NOT NULL,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS site_checks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    site_id UUID NOT NULL REFERENCES monitored_sites(id) ON DELETE CASCADE,
    ok BOOLEAN NOT NULL,
    http_status INT,
    response_ms INT,
    seo_score INT,
    seo_checks JSONB,
    error TEXT,
    checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_site_checks_site_id_checked_at ON site_checks(site_id, checked_at DESC)`,
  ...OPS_ALERT_STATEMENTS,
  ...ORDER_STATEMENTS,
];

// Columns the application code requires on each table.
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'username', 'email', 'password_hash', 'locale', 'created_at', 'updated_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token', 'expires_at', 'created_at', 'ip_address', 'user_agent'],
  feedback: ['id', 'user_id', 'name', 'email', 'subject', 'message', 'status', 'created_at'],
  bp_reports: ['id', 'keyword', 'keyword_norm', 'source_trend_id', 'search_volume', 'growth_rate', 'category', 'time_range', 'region', 'rank', 'status', 'title', 'summary', 'selected_opportunity', 'content_json', 'business_model_norm', 'canonical_report_id', 'model', 'tokens_used', 'error', 'user_id', 'created_at', 'updated_at'],
  bp_report_opportunities: ['id', 'report_id', 'name', 'description', 'score_market', 'score_roi', 'score_onlineability', 'score_feasibility', 'score_speed', 'score_moat', 'weighted_score', 'is_selected', 'rank', 'created_at'],
  newsletter_subscribers: ['id', 'email', 'created_at'],
  monitored_sites: ['id', 'name', 'url', 'enabled', 'created_at'],
  site_checks: ['id', 'site_id', 'ok', 'http_status', 'response_ms', 'seo_score', 'seo_checks', 'error', 'checked_at'],
  ops_alerts: ['id', 'source', 'message', 'context', 'created_at'],
  orders: ['id', 'provider', 'provider_order_id', 'provider_checkout_id', 'reference', 'product', 'report_id', 'email', 'user_id', 'amount_cents', 'currency', 'status', 'download_count', 'last_downloaded_at', 'paid_at', 'refunded_at', 'created_at', 'updated_at'],
};

// Destructive recreate of the auth/feedback tables (drops mismatched legacy schema).
// Order matters: drop FK-dependent tables before the referenced `users` table.
export const RECREATE_STATEMENTS = [
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
export const RECREATE_BP_STATEMENTS = [
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
