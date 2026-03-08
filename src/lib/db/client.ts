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
