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
import { ADDITIVE_STATEMENTS, NEWSLETTER_STATEMENTS } from '../db/schema';
import { recordError, pruneOldLogs, retentionDays } from '../observability/errorLog';
import { ensureOpsAlertsTable, pruneOpsAlerts } from '../observability/opsAlerts';
import { pruneExpiredTrendBatches } from './trendIntake';

export const TRENDS_RETENTION_DEFAULT_DAYS = 30;
export const SITE_CHECKS_RETENTION_DEFAULT_DAYS = 90;

function retention(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  // 0 or negative would delete everything; treat as misconfiguration.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface MaintenanceResult {
  newsletterTableEnsured: boolean;
  columnsAdded: number;
  trendsDeleted: number;
  siteChecksDeleted: number;
  logsDeleted: number;
  /** Queued harvests dropped for being older than the analysis window. */
  intakeBatchesDropped: number;
  opsAlertsDeleted: number;
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

/**
 * Apply additive column migrations. Runs every cycle so a schema change ships
 * with the deploy instead of waiting on someone to remember `db-init`.
 *
 * Each statement is independent: they target two possible trends table names,
 * only one of which exists, so a failure on the absent one is expected and must
 * not stop the rest. Returns how many statements applied cleanly.
 */
export async function applyAdditiveMigrations(): Promise<number> {
  let applied = 0;
  for (const statement of ADDITIVE_STATEMENTS) {
    try {
      await query(statement);
      applied++;
    } catch {
      // Table absent in this database — the statement for its sibling name ran.
    }
  }
  return applied;
}

export async function pruneTrends(days = retention('TRENDS_RETENTION_DAYS', TRENDS_RETENTION_DEFAULT_DAYS)): Promise<number> {
  const table = await getTrendsTableName();
  const tsCol = await getTimestampColumnName(table);
  const tsRef = tsCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';
  // Keyed on the trend timestamp rather than created_at so backfilled rows are
  // judged by the data's age, not the row's.
  //
  // RETURNING, because `query()` resolves to the rows rather than to a pg result
  // object: reading `.rowCount` off it yielded undefined, so every run reported
  // "0 deleted" no matter how much it had actually pruned.
  const rows = await query(
    `DELETE FROM ${table} WHERE COALESCE(${tsRef}, created_at) < NOW() - ($1 || ' days')::interval RETURNING id`,
    [String(days)]
  );
  return rows.length;
}

export async function pruneSiteChecks(
  days = retention('SITE_CHECKS_RETENTION_DAYS', SITE_CHECKS_RETENTION_DEFAULT_DAYS)
): Promise<number> {
  // The newest check per site is always kept: the monitor dashboard reads the
  // latest row, and a site that has been quiet longer than the retention window
  // would otherwise lose its status entirely.
  const rows = await query(
    `DELETE FROM site_checks sc
      WHERE sc.checked_at < NOW() - ($1 || ' days')::interval
        AND sc.id <> (
          SELECT id FROM site_checks newest
           WHERE newest.site_id = sc.site_id
           ORDER BY checked_at DESC LIMIT 1
        )
      RETURNING sc.id`,
    [String(days)]
  );
  return rows.length;
}

/**
 * Run every housekeeping step, isolating failures: a missing table or a
 * permission error on one step must not prevent the others.
 */
export async function runMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    newsletterTableEnsured: false,
    columnsAdded: 0,
    trendsDeleted: 0,
    siteChecksDeleted: 0,
    logsDeleted: 0,
    intakeBatchesDropped: 0,
    opsAlertsDeleted: 0,
    errors: [],
  };

  const steps: [string, () => Promise<void>][] = [
    ['newsletter', async () => { result.newsletterTableEnsured = await ensureNewsletterTable(); }],
    ['ops-alerts', async () => { await ensureOpsAlertsTable(); }],
    ['additive-migrations', async () => { result.columnsAdded = await applyAdditiveMigrations(); }],
    ['trends-retention', async () => { result.trendsDeleted = await pruneTrends(); }],
    ['site-checks-retention', async () => { result.siteChecksDeleted = await pruneSiteChecks(); }],
    ['error-log-retention', async () => { result.logsDeleted = (await pruneOldLogs()).length; }],
    ['intake-retention', async () => { result.intakeBatchesDropped = await pruneExpiredTrendBatches(); }],
    // Same window as the blob log: the two are read side by side.
    ['ops-alert-retention', async () => { result.opsAlertsDeleted = await pruneOpsAlerts(retentionDays()); }],
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
