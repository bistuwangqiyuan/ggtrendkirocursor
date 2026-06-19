import type { APIRoute } from 'astro';
import { pool, isDbDown } from '../../lib/db/client';
import { APP_VERSION } from '../../version';

export const GET: APIRoute = async () => {
  const dbUrl = process.env.DATABASE_URL
    || process.env.NETLIFY_DATABASE_URL
    || process.env.NEON_DATABASE_URL;

  let dbConnected = false;
  let dbError: string | null = null;
  let tableCount = 0;
  let tables: string[] = [];
  let trendsInfo: any = null;

  if (dbUrl) {
    try {
      const tablesResult = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      );
      tables = tablesResult.rows.map((r: any) => r.table_name);
      tableCount = tables.length;
      dbConnected = true;

      // Check for trends data in known table
      for (const tableName of tables) {
        if (tableName.includes('trend')) {
          const colsResult = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
            [tableName]
          );
          const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
          const sampleResult = await pool.query(`SELECT * FROM "${tableName}" LIMIT 3`);
          const distinctTimeRange = await pool.query(
            `SELECT DISTINCT time_range, COUNT(*) as cnt FROM "${tableName}" GROUP BY time_range`
          ).catch(() => ({ rows: [] }));

          trendsInfo = {
            tableName,
            columns: colsResult.rows,
            rowCount: parseInt(countResult.rows[0]?.cnt ?? '0', 10),
            sampleRows: sampleResult.rows,
            timeRangeDistribution: distinctTimeRange.rows
          };
          break;
        }
      }
    } catch (e: any) {
      dbError = e.message;
    }
  }

  return new Response(JSON.stringify({
    status: dbConnected ? 'ok' : 'degraded',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    env: {
      hasDbUrl: !!dbUrl,
      dbUrlPattern: dbUrl ? dbUrl.replace(/\/\/.*@/, '//***@') : null,
      nodeEnv: process.env.NODE_ENV
    },
    database: {
      connected: dbConnected,
      dbDown: isDbDown(),
      tableCount,
      tables,
      error: dbError
    },
    trends: trendsInfo
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

