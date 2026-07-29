/**
 * Incidents recorded in Postgres, for the failures the blob log cannot describe.
 *
 * [`errorLog.ts`](./errorLog.ts) is deliberately database-free, which makes it
 * the right sink for almost everything — and useless for one case: the snapshot
 * store itself being unreachable from the scheduled job. On 2026-07-26 that
 * happened, and because both the pages and the log live in Blobs, the site froze
 * for 44 hours with no error recorded anywhere. Postgres was writing reports
 * throughout, so it is the sink that works precisely when the other one doesn't.
 *
 * Kept deliberately narrow so it cannot become a second error log:
 *   - written only by the scheduled job, only for storage-level incidents;
 *   - read only when an operator asks (`/api/admin/errors?alerts=1`), so viewing
 *     the ops page still costs no database wake-up;
 *   - never throws, and never on the critical path of the work it reports on.
 */
import { query } from '../db/client';
import { OPS_ALERT_STATEMENTS } from '../db/schema';

export interface OpsAlert {
  id: string;
  at: string;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
}

const MAX_MESSAGE_LENGTH = 1000;

/** Create the table if this database predates it. Idempotent. */
export async function ensureOpsAlertsTable(): Promise<boolean> {
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  for (const statement of OPS_ALERT_STATEMENTS) await query(statement);
  return true;
}

/**
 * Record an incident. Returns whether it landed — a false here means both
 * storage layers are down, which is worth reporting in the run summary.
 */
export async function recordOpsAlert(
  source: string,
  message: string,
  context: Record<string, unknown> = {}
): Promise<boolean> {
  const trimmed = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  try {
    await query(
      `INSERT INTO ops_alerts (source, message, context) VALUES ($1, $2, $3::jsonb)`,
      [source.slice(0, 64), trimmed, JSON.stringify(context)]
    );
    return true;
  } catch (error) {
    // The table may not exist yet in a database provisioned before this change;
    // maintenance creates it, but an incident on the very first run should still
    // be kept rather than dropped.
    try {
      await ensureOpsAlertsTable();
      await query(
        `INSERT INTO ops_alerts (source, message, context) VALUES ($1, $2, $3::jsonb)`,
        [source.slice(0, 64), trimmed, JSON.stringify(context)]
      );
      return true;
    } catch (retryError) {
      console.error(
        '[opsAlerts] could not record incident:',
        (error as Error).message,
        '/',
        (retryError as Error).message
      );
      return false;
    }
  }
}

/** Most recent alerts, newest first. Wakes the database — call only on request. */
export async function recentOpsAlerts(limit = 20): Promise<OpsAlert[]> {
  const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 200);
  try {
    const rows = await query<{
      id: string;
      source: string;
      message: string;
      context: Record<string, unknown> | null;
      created_at: Date | string;
    }>(
      `SELECT id, source, message, context, created_at
         FROM ops_alerts ORDER BY created_at DESC LIMIT $1`,
      [capped]
    );
    return rows.map((row) => ({
      id: row.id,
      at: new Date(row.created_at).toISOString(),
      source: row.source,
      message: row.message,
      context: row.context,
    }));
  } catch (error) {
    console.error('[opsAlerts] read failed:', (error as Error).message);
    return [];
  }
}

/**
 * Drop alerts older than the retention window. Returns rows deleted.
 *
 * `RETURNING` rather than a row count because `query()` resolves to the rows,
 * not to a pg result object.
 */
export async function pruneOpsAlerts(days: number): Promise<number> {
  const rows = await query(
    `DELETE FROM ops_alerts WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
    [String(days)]
  );
  return rows.length;
}
