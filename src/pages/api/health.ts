import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';

export const GET: APIRoute = async () => {
  const dbUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  let dbConnected = false;
  let dbError: string | null = null;
  let tableCount = 0;

  if (dbUrl) {
    try {
      const result = await pool.query(
        `SELECT count(*) as cnt FROM information_schema.tables WHERE table_schema = 'public'`
      );
      tableCount = parseInt(result.rows[0]?.cnt ?? '0', 10);
      dbConnected = true;
    } catch (e: any) {
      dbError = e.message;
    }
  }

  return new Response(JSON.stringify({
    status: dbConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    env: {
      hasDbUrl: !!dbUrl,
      nodeEnv: process.env.NODE_ENV
    },
    database: {
      connected: dbConnected,
      tableCount,
      error: dbError
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

