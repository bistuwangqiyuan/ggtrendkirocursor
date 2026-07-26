/**
 * Request-scoped attribution for database access.
 *
 * The whole point of the snapshot migration is that page renders stop touching
 * Postgres. To prove that — rather than assert it — every database wake-up is
 * tagged with the route and the kind of work that caused it. Acceptance criterion:
 * across a week, zero wake events with reason `page`.
 *
 * AsyncLocalStorage carries the tag through the await chain, so services don't
 * have to thread a parameter down every call site.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type DbReason = 'cron' | 'page' | 'api' | 'auth' | 'unknown';

export interface DbContext {
  reason: DbReason;
  route?: string;
}

const storage = new AsyncLocalStorage<DbContext>();

export function runWithDbContext<T>(context: DbContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentDbContext(): DbContext {
  return storage.getStore() ?? { reason: 'unknown' };
}

/**
 * Classify a request path. Scheduled/admin endpoints legitimately wake the
 * database; anything classified as `page` doing so is a regression.
 */
export function classifyRoute(pathname: string): DbReason {
  const scheduled = [
    '/api/bp/cron',
    '/api/bp/batch',
    '/api/trends/collect',
    '/api/monitor/run',
    '/api/snapshots/rebuild',
    '/api/maintenance',
    '/api/db-init',
    '/api/seed',
  ];
  if (scheduled.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return 'cron';
  if (pathname.startsWith('/api/')) return 'api';
  return 'page';
}
