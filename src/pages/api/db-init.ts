import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';

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
];

// Columns the application code requires on each table.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'username', 'email', 'password_hash', 'locale', 'created_at', 'updated_at', 'last_login_at'],
  sessions: ['id', 'user_id', 'token', 'expires_at', 'created_at', 'ip_address', 'user_agent'],
  feedback: ['id', 'user_id', 'name', 'email', 'subject', 'message', 'status', 'created_at'],
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

async function inspectColumns(client: any): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of ['users', 'sessions', 'feedback']) {
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
  if (url.searchParams.get('secret') !== 'trendnow-seed') {
    return new Response('Unauthorized', { status: 401 });
  }

  const migrate = url.searchParams.get('migrate') === 'auth';

  let client: any;
  try {
    client = await pool.connect();

    const before = await inspectColumns(client);
    const mismatches = detectMismatches(before);

    const statements = migrate ? RECREATE_STATEMENTS : BASE_STATEMENTS;
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
      mode: migrate ? 'recreate-auth' : 'idempotent',
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
