import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';

const INIT_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  locale VARCHAR(5) DEFAULT 'zh',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

CREATE TABLE IF NOT EXISTS trends_trending_now (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword VARCHAR(255) NOT NULL,
  search_volume BIGINT NOT NULL,
  growth_rate DECIMAL(10, 2),
  category VARCHAR(100),
  time_range VARCHAR(50),
  region VARCHAR(10) DEFAULT 'US',
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trends_trending_now_timestamp ON trends_trending_now(timestamp);
CREATE INDEX IF NOT EXISTS idx_trends_trending_now_time_range ON trends_trending_now(time_range);
CREATE INDEX IF NOT EXISTS idx_trends_trending_now_category ON trends_trending_now(category);
CREATE INDEX IF NOT EXISTS idx_trends_trending_now_search_volume ON trends_trending_now(search_volume);
`;

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get('secret') !== 'trendnow-seed') {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const client = await pool.connect();

    const statements = INIT_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const results: string[] = [];
    for (const stmt of statements) {
      await client.query(stmt);
      const firstLine = stmt.split('\n').find(l => l.trim())?.trim() ?? '';
      results.push(`OK: ${firstLine.substring(0, 60)}`);
    }

    // Verify table structures
    const verify: Record<string, any> = {};
    for (const table of ['users', 'sessions', 'feedback', 'trends_trending_now']) {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table]
      );
      verify[table] = cols.rows.map((r: any) => r.column_name);
    }

    client.release();

    return new Response(JSON.stringify({
      success: true,
      message: `Executed ${results.length} statements`,
      details: results,
      tables: verify
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('DB init error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      detail: error.detail || null
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
