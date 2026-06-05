import pg from 'pg';
const { Pool } = pg;

let poolInstance: pg.Pool | null = null;

function getConnectionString(): string | undefined {
  return process.env.DATABASE_URL
    || process.env.NETLIFY_DATABASE_URL
    || process.env.NEON_DATABASE_URL;
}

function getPool() {
  if (!poolInstance) {
    const connectionString = getConnectionString();
    
    if (!connectionString) {
      console.error('[DB] Connection string missing. Checked: DATABASE_URL, NETLIFY_DATABASE_URL, NEON_DATABASE_URL');
    } else {
      console.log('[DB] Connecting with URL pattern:', connectionString.replace(/\/\/.*@/, '//***@'));
    }

    poolInstance = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });
    
    poolInstance.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
      poolInstance = null;
    });
  }
  return poolInstance;
}

export const pool = {
  query: (text: string, params?: any[]) => {
      const p = getPool();
      if (!p) throw new Error('Pool not initialized');
      return p.query(text, params);
  },
  connect: () => {
      const p = getPool();
      if (!p) throw new Error('Pool not initialized');
      return p.connect();
  },
  end: async () => {
      if (poolInstance) {
          await poolInstance.end();
          poolInstance = null;
      }
  }
};

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  try {
    const res = await pool.query(text, params);
    return res.rows;
  } catch (error) {
    console.error('[DB] Query error:', {
      sql: text.substring(0, 100),
      params: params?.map(p => typeof p === 'string' && p.length > 50 ? p.substring(0, 50) + '...' : p),
      error: (error as Error).message,
      stack: (error as Error).stack?.split('\n').slice(0, 3).join('\n')
    });
    return [];
  }
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function getClient() {
  return await pool.connect();
}

/** Resolve trends table name: env TRENDS_TABLE, or trends_trending_now (preferred), else google_trends. */
let cachedTrendsTableName: string | null = null;

export async function getTrendsTableName(): Promise<string> {
  if (cachedTrendsTableName) return cachedTrendsTableName;
  const fromEnv = process.env.TRENDS_TABLE?.trim();
  if (fromEnv) {
    cachedTrendsTableName = fromEnv;
    return cachedTrendsTableName;
  }
  try {
    const p = getPool();
    if (!p) {
      cachedTrendsTableName = 'google_trends';
      return cachedTrendsTableName;
    }
    // Find which candidate tables exist.
    const existing = await p.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' AND table_name IN ('trends_trending_now', 'google_trends')`
    );
    const names: string[] = existing.rows.map((r: any) => r.table_name);

    if (names.length === 0) {
      cachedTrendsTableName = 'google_trends';
      return cachedTrendsTableName;
    }
    if (names.length === 1) {
      cachedTrendsTableName = names[0];
      return cachedTrendsTableName;
    }

    // Both exist: pick the one that actually has rows, preferring google_trends.
    const counts = new Map<string, number>();
    for (const name of names) {
      try {
        const c = await p.query(`SELECT COUNT(*)::int AS cnt FROM "${name}"`);
        counts.set(name, c.rows[0]?.cnt ?? 0);
      } catch {
        counts.set(name, -1); // table unusable (e.g. wrong schema)
      }
    }
    const preference = ['google_trends', 'trends_trending_now'];
    const populated = preference.filter((n) => (counts.get(n) ?? -1) > 0);
    cachedTrendsTableName = populated[0]
      ?? preference.find((n) => (counts.get(n) ?? -1) === 0)
      ?? 'google_trends';
  } catch {
    cachedTrendsTableName = 'google_trends';
  }
  return cachedTrendsTableName;
}

/** Resolve timestamp column name for trends table (timestamp or trend_timestamp). Cached per table. */
const cachedTimestampColumn = new Map<string, string>();

export async function getTimestampColumnName(tableName: string): Promise<string> {
  if (cachedTimestampColumn.has(tableName)) return cachedTimestampColumn.get(tableName)!;
  try {
    const p = getPool();
    if (!p) {
      cachedTimestampColumn.set(tableName, 'timestamp');
      return 'timestamp';
    }
    const res = await p.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('timestamp', 'trend_timestamp') 
       ORDER BY CASE column_name WHEN 'timestamp' THEN 0 ELSE 1 END LIMIT 1`,
      [tableName]
    );
    const col = res.rows[0]?.column_name || 'timestamp';
    cachedTimestampColumn.set(tableName, col);
    return col;
  } catch {
    cachedTimestampColumn.set(tableName, 'timestamp');
    return 'timestamp';
  }
}
