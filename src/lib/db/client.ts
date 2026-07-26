import pg from 'pg';
import { recordDbWake, recordError } from '../observability/errorLog';
import { currentDbContext } from '../observability/dbContext';
const { Pool } = pg;

let poolInstance: pg.Pool | null = null;

/**
 * Neon's free plan auto-suspends the compute after 5 minutes of inactivity and
 * bills only while it is awake. A query arriving after a gap longer than that
 * therefore *woke* the instance and started a fresh billed window; queries inside
 * the window are effectively free. Metering wake-ups (not queries) is what makes
 * the quota measurable.
 */
const NEON_AUTOSUSPEND_MS = 5 * 60 * 1000;
let lastQueryAt = 0;
/** Wake-ups seen by this process instance, for /api/health-style diagnostics. */
let wakeCount = 0;

export function getDbWakeCount(): number {
  return wakeCount;
}

function noteDbActivity(): void {
  const now = Date.now();
  const gap = lastQueryAt === 0 ? Infinity : now - lastQueryAt;
  lastQueryAt = now;
  if (gap <= NEON_AUTOSUSPEND_MS) return;
  wakeCount++;
  const context = currentDbContext();
  recordDbWake(context.reason, { route: context.route });
  console.log(`[DB] wake #${wakeCount} reason=${context.reason} route=${context.route ?? '-'}`);
}

function getConnectionString(): string | undefined {
  return process.env.DATABASE_URL
    || process.env.NETLIFY_DATABASE_URL
    || process.env.NEON_DATABASE_URL;
}

/**
 * Circuit breaker for DB outages (e.g. a quota-exhausted / suspended Neon
 * instance). Without it, every query waits out the connection timeout before
 * failing; a single SSR page fires several queries sequentially, so the stacked
 * timeouts blow past Netlify's 26s function limit and the whole page 502s.
 *
 * When a query fails or times out we "open" the breaker for DB_COOLDOWN_MS:
 * subsequent calls short-circuit and return immediately (no waiting), so pages
 * render their graceful empty/degraded state instantly. After the cooldown the
 * breaker is half-open — the next real attempt probes the DB and re-opens on
 * failure or stays closed on success.
 */
const DB_COOLDOWN_MS = 10_000;
const DB_QUERY_TIMEOUT_MS = 4_500;
let dbDownUntil = 0;

/** True while the breaker is open (DB treated as unavailable). */
export function isDbDown(): boolean {
  return Date.now() < dbDownUntil;
}

/** Open the breaker so queries short-circuit for `cooldownMs` (default cooldown). */
export function markDbUnavailable(cooldownMs: number = DB_COOLDOWN_MS): void {
  dbDownUntil = Date.now() + cooldownMs;
}

/** Open the breaker so the next DB_COOLDOWN_MS of queries short-circuit. */
function tripBreaker(reason: string): void {
  markDbUnavailable();
  console.error(`[DB] circuit breaker opened for ${DB_COOLDOWN_MS}ms:`, reason);
  const context = currentDbContext();
  // Blobs-backed log: recording a database outage must not require the database.
  recordError('db', reason, { route: context.route, context: { dbReason: context.reason } });
}

/** For tests/diagnostics: clear the breaker. */
export function resetDbBreaker(): void {
  dbDownUntil = 0;
}

class DbUnavailableError extends Error {
  constructor(message = 'DB unavailable (circuit breaker open)') {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

/**
 * Run an underlying pg call with fail-fast semantics: reject instantly while the
 * breaker is open, otherwise race the call against a hard timeout and trip the
 * breaker on any failure/timeout. Throws on failure (callers that want graceful
 * empties go through `query`/`queryOne`).
 */
async function runGuarded<T>(fn: () => Promise<T>): Promise<T> {
  if (isDbDown()) {
    throw new DbUnavailableError();
  }
  noteDbActivity();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<T>([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DB query timed out after ${DB_QUERY_TIMEOUT_MS}ms`)), DB_QUERY_TIMEOUT_MS);
      }),
    ]);
    return result;
  } catch (error) {
    tripBreaker((error as Error).message);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getPool() {
  if (!poolInstance) {
    const connectionString = getConnectionString();

    if (!connectionString) {
      console.error('[DB] Connection string missing. Checked: DATABASE_URL, NETLIFY_DATABASE_URL, NEON_DATABASE_URL');
    } else {
      console.log('[DB] Connecting with URL pattern:', connectionString.replace(/\/\/.*@/, '//***@'));
    }

    // Hosted Postgres (Neon) requires TLS, but a local dev instance usually has
    // no SSL support at all. Honour an explicit `sslmode=disable` in the URL so
    // real-function testing can run against a local server.
    const sslDisabled = /[?&]sslmode=disable\b/i.test(connectionString || '');

    poolInstance = new Pool({
      connectionString,
      ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 5000,
      // Fail fast when the instance is unreachable so a dead DB can't stack
      // multi-second hangs across the several queries a page makes.
      connectionTimeoutMillis: 3000,
      query_timeout: 4000,
      statement_timeout: 4000,
    });

    poolInstance.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
      tripBreaker(err.message);
      poolInstance = null;
    });
  }
  return poolInstance;
}

export const pool = {
  query: (text: string, params?: any[]) => {
    return runGuarded(() => {
      const p = getPool();
      if (!p) throw new Error('Pool not initialized');
      return p.query(text, params);
    });
  },
  connect: () => {
    return runGuarded(() => {
      const p = getPool();
      if (!p) throw new Error('Pool not initialized');
      return p.connect();
    });
  },
  end: async () => {
    if (poolInstance) {
      await poolInstance.end();
      poolInstance = null;
    }
  }
};

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  // Short-circuit while the breaker is open: return an empty result instantly so
  // pages degrade gracefully instead of waiting on a known-dead instance.
  if (isDbDown()) {
    return [];
  }
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
    // Real errors propagate to the caller. Swallowing them here (returning [])
    // used to make writes look successful (e.g. newsletter INSERTs into a
    // missing table returned 201) and silently disabled BP dedup checks.
    throw error;
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
  // While the DB is down, return a default WITHOUT caching so the real table is
  // re-resolved once the instance recovers.
  if (isDbDown()) return 'google_trends';
  try {
    // Find which candidate tables exist.
    const existing = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' AND table_name IN ('trends_trending_now', 'google_trends')`
    );
    const names: string[] = existing.rows.map((r: any) => r.table_name);

    if (names.length === 0) {
      // No trends table yet (fresh DB before db-init): return the default
      // WITHOUT caching so the real table is picked up once it is created.
      return 'google_trends';
    }
    if (names.length === 1) {
      cachedTrendsTableName = names[0];
      return cachedTrendsTableName;
    }

    // Both exist: pick the one that actually has rows, preferring google_trends.
    const counts = new Map<string, number>();
    for (const name of names) {
      try {
        const c = await pool.query(`SELECT COUNT(*)::int AS cnt FROM "${name}"`);
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
  // While the DB is down, return a default WITHOUT caching so it is re-resolved
  // once the instance recovers.
  if (isDbDown()) return 'timestamp';
  try {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('timestamp', 'trend_timestamp') 
       ORDER BY CASE column_name WHEN 'timestamp' THEN 0 ELSE 1 END LIMIT 1`,
      [tableName]
    );
    const col = res.rows[0]?.column_name;
    // Only cache a REAL lookup hit. When the table does not exist yet (e.g.
    // before db-init on a fresh database), caching the fallback would keep
    // pointing at the wrong column forever after the table is created.
    if (col) {
      cachedTimestampColumn.set(tableName, col);
      return col;
    }
    return 'timestamp';
  } catch {
    return 'timestamp';
  }
}

/**
 * Whether the trends table has an additively-migrated column yet.
 *
 * Columns added after a database was provisioned (topic_class) only appear once
 * the maintenance job or db-init has run. Readers and writers check first so a
 * lagging database degrades — collecting without the classification — instead
 * of failing every insert.
 *
 * Only a positive result is cached: caching "absent" would keep the column
 * invisible for the rest of the process after the migration adds it.
 */
const cachedTrendsColumns = new Map<string, boolean>();

export async function trendsTableHasColumn(tableName: string, column: string): Promise<boolean> {
  const cacheKey = `${tableName}.${column}`;
  if (cachedTrendsColumns.get(cacheKey)) return true;
  if (isDbDown()) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
      [tableName, column]
    );
    const present = res.rows.length > 0;
    if (present) cachedTrendsColumns.set(cacheKey, true);
    return present;
  } catch {
    return false;
  }
}
