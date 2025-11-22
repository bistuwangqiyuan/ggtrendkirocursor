import pg from 'pg';
const { Pool } = pg;

let poolInstance: pg.Pool | null = null;

function getPool() {
  if (!poolInstance) {
    const connectionString = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    
    if (!connectionString) {
      console.error('DB Connection string missing');
      // Don't throw here, let the query fail gracefully
    }

    // Optimized for serverless
    poolInstance = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 2, // Keep connections low for serverless
      idleTimeoutMillis: 5000, // Close idle quickly
      connectionTimeoutMillis: 3000, // Fail fast
    });
    
    poolInstance.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      poolInstance = null; // Reset on error
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
    console.error('Database query error', { text: text.substring(0, 50), error: (error as Error).message });
    // Return empty array on error to prevent crash
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
