/**
 * Storage housekeeping, run inside the consolidated cron window so it costs no
 * extra database wake-up.
 *
 * Two problems this fixes:
 *   1. `newsletter_subscribers` is defined in db-init but was never created in
 *      production, so the subscribe endpoint fails on every call.
 *   2. `google_trends` and `site_checks` only ever grew. Neon's free plan caps
 *      storage at 0.5 GB, and neither table has any value beyond a short window:
 *      trends are superseded every 3 hours, checks are a rolling health signal.
 */
import { query, getTrendsTableName, getTimestampColumnName } from '../db/client';
import { NEWSLETTER_STATEMENTS } from '../db/schema';
import { recordError, pruneOldLogs } from '../observability/errorLog';

export const TRENDS_RETENTION_DEFAULT_DAYS = 30;
export const SITE_CHECKS_RETENTION_DEFAULT_DAYS = 90;

function retention(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  // 0 or negative would delete everything; treat as misconfiguration.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface MaintenanceResult {
  newsletterTableEnsured: boolean;
  trendsDeleted: number;
  siteChecksDeleted: number;
  logsDeleted: number;
  errors: string[];
}

/** Create the table the subscribe API expects. Idempotent. */
export async function ensureNewsletterTable(): Promise<boolean> {
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  for (const statement of NEWSLETTER_STATEMENTS) {
    await query(statement);
  }
  return true;
}

export async function pruneTrends(days = retention('TRENDS_RETENTION_DAYS', TRENDS_RETENTION_DEFAULT_DAYS)): Promise<number> {
  const table = await getTrendsTableName();
  const tsCol = await getTimestampColumnName(table);
  const tsRef = tsCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';
  // Keyed on the trend timestamp rather than created_at so backfilled rows are
  // judged by the data's age, not the row's.
  const res = await query(
    `DELETE FROM ${table} WHERE COALESCE(${tsRef}, created_at) < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return res.rowCount ?? 0;
}

export async function pruneSiteChecks(
  days = retention('SITE_CHECKS_RETENTION_DAYS', SITE_CHECKS_RETENTION_DEFAULT_DAYS)
): Promise<number> {
  // The newest check per site is always kept: the monitor dashboard reads the
  // latest row, and a site that has been quiet longer than the retention window
  // would otherwise lose its status entirely.
  const res = await query(
    `DELETE FROM site_checks sc
      WHERE sc.checked_at < NOW() - ($1 || ' days')::interval
        AND sc.id <> (
          SELECT id FROM site_checks newest
           WHERE newest.site_id = sc.site_id
           ORDER BY checked_at DESC LIMIT 1
        )`,
    [String(days)]
  );
  return res.rowCount ?? 0;
}

/**
 * Run every housekeeping step, isolating failures: a missing table or a
 * permission error on one step must not prevent the others.
 */
export async function runMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    newsletterTableEnsured: false,
    trendsDeleted: 0,
    siteChecksDeleted: 0,
    logsDeleted: 0,
    errors: [],
  };

  const steps: [string, () => Promise<void>][] = [
    ['newsletter', async () => { result.newsletterTableEnsured = await ensureNewsletterTable(); }],
    ['trends-retention', async () => { result.trendsDeleted = await pruneTrends(); }],
    ['site-checks-retention', async () => { result.siteChecksDeleted = await pruneSiteChecks(); }],
    ['error-log-retention', async () => { result.logsDeleted = await pruneOldLogs(); }],
  ];

  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push(`${name}: ${message}`);
      console.error(`[maintenance] ${name} failed:`, message);
      recordError('maintenance', error, { context: { step: name } });
    }
  }
  return result;
}
