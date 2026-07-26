/**
 * Read-path policy: one place that decides where page data comes from.
 *
 * Order of preference:
 *   1. Snapshot (no Neon compute, the normal case)
 *   2. Postgres — ONLY when ALLOW_DB_READ_FALLBACK=true
 *   3. "Pending" state — snapshot not built yet
 *
 * Step 2 is off by default on purpose. Falling back to Postgres automatically
 * would restore exactly the request pattern that drains the Neon compute quota,
 * and it would do so invisibly: the site would look fine right up to the point
 * the project gets suspended. Making the fallback opt-in means a missing
 * snapshot surfaces as a visible pending state plus a logged error instead.
 */
import type { SnapshotRead } from './snapshotReaders';
import { isDbReadFallbackAllowed } from './snapshot';
import { recordError } from '../observability/errorLog';
import { currentDbContext } from '../observability/dbContext';

export type ReadSource = 'snapshot' | 'db' | 'pending';

export interface PageData<T> {
  data: T;
  source: ReadSource;
  /** When the snapshot was produced ("data as of" label); null for db/pending. */
  generatedAt: Date | null;
  /** True when the snapshot is missing, i.e. the page shows a pending state. */
  pending: boolean;
}

export interface ReadOptions {
  /**
   * For keyed lookups (`/t/<slug>`, `/bp/<id>`): does the key exist at all?
   *
   * A missing detail snapshot has two very different causes — the snapshot has
   * not been built yet (a real problem) or the key simply does not exist (an
   * ordinary 404). Without this the daily error log fills with every crawler
   * that follows a dead URL, which buries the entries that matter.
   *
   * Called lazily, and only when the snapshot missed, because answering it costs
   * a second blob read. Return `false` for "definitely not a thing", `null` when
   * the index needed to answer is itself unavailable.
   */
  keyKnown?: () => Promise<boolean | null>;
}

export async function readForPage<T>(
  label: string,
  readSnapshot: () => Promise<SnapshotRead<T>>,
  dbFallback?: () => Promise<T>,
  options: ReadOptions = {}
): Promise<PageData<T>> {
  const route = currentDbContext().route;
  let snap: SnapshotRead<T>;
  try {
    snap = await readSnapshot();
  } catch (error) {
    console.error(`[read-path] ${label}: snapshot read threw`, (error as Error).message);
    recordError('read-path', error, { route, context: { label, stage: 'snapshot-read' } });
    snap = { hit: false, data: undefined as unknown as T, generatedAt: null };
  }

  if (snap.hit) {
    return { data: snap.data, source: 'snapshot', generatedAt: snap.generatedAt, pending: false };
  }

  if (dbFallback && isDbReadFallbackAllowed()) {
    try {
      const data = await dbFallback();
      console.warn(`[read-path] ${label}: snapshot missing, served from Postgres (ALLOW_DB_READ_FALLBACK=true)`);
      recordError('read-path', `${label}: snapshot missing, served from Postgres`, {
        level: 'warn',
        route,
        context: { label, stage: 'db-fallback' },
      });
      return { data, source: 'db', generatedAt: null, pending: false };
    } catch (error) {
      console.error(`[read-path] ${label}: DB fallback failed`, (error as Error).message);
      recordError('read-path', error, { route, context: { label, stage: 'db-fallback' } });
    }
  }

  if (options.keyKnown && (await safeKeyKnown(options.keyKnown)) === false) {
    // Not a missing snapshot — a missing thing. The caller renders a 404.
    return { data: snap.data, source: 'pending', generatedAt: null, pending: true };
  }

  const message = `${label}: snapshot missing — serving pending state (run POST /api/snapshots/rebuild)`;
  console.error(`[read-path] ${message}`);
  recordError('read-path', message, { route, context: { label, stage: 'pending' } });
  return { data: snap.data, source: 'pending', generatedAt: null, pending: true };
}

/** An index lookup that fails must not suppress the log, so treat it as unknown. */
async function safeKeyKnown(fn: () => Promise<boolean | null>): Promise<boolean | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
