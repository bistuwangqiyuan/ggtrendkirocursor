import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';
import { listLogDates, readDayLog, pruneOldLogs, retentionDays } from '../../../lib/observability/errorLog';
import { NO_STORE_HEADERS } from '../../../lib/cache/httpCache';
import type { ErrorLevel } from '../../../lib/observability/errorLog';
import { pendingTrendBacklog, intakeTtlHours } from '../../../lib/services/trendIntake';
import { pendingBufferedReports } from '../../../lib/services/bpBatchRunner';
import { loadPipelineState, missedRuns } from '../../../lib/services/pipelineState';
import { snapshotStaleness } from '../../../lib/cache/snapshotDelivery';
import { recentOpsAlerts } from '../../../lib/observability/opsAlerts';

export const prerender = false;

const HEADERS = { 'Content-Type': 'application/json', ...NO_STORE_HEADERS };
const LEVELS: ErrorLevel[] = ['error', 'warn', 'info'];

/**
 * Day-partitioned runtime error log, the database wake-up meter, the write
 * pipeline's backlog, and the freshness of the read side.
 *
 * Reads from Netlify Blobs, never Postgres — this endpoint has to work precisely
 * when the database does not. The one exception is opt-in: `?alerts=1` reads the
 * `ops_alerts` table, which exists for incidents the blob log cannot describe
 * (the store itself being unreachable). It is off by default so that opening the
 * ops page still costs no database wake-up.
 *
 * GET  /api/admin/errors                  -> dates, retention window, pipeline backlog, snapshot freshness
 * GET  /api/admin/errors?alerts=1         -> also the durable incident rows from Postgres
 * GET  /api/admin/errors?date=YYYY-MM-DD  -> that day's entries and wake stats
 * POST /api/admin/errors?action=prune     -> delete logs past the retention window
 */
export const GET: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  if (!date) {
    const wantsAlerts = url.searchParams.get('alerts') === '1';
    return json(
      {
        success: true,
        dates: await listLogDates(),
        retentionDays: retentionDays(),
        pipeline: await pipelineReport(),
        snapshots: await snapshotStaleness(),
        // Null rather than [] when not requested, so an empty list means "no
        // incidents" instead of "not asked for".
        opsAlerts: wantsAlerts ? await recentOpsAlerts(20) : null,
      },
      200
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ success: false, error: 'date 必须是 YYYY-MM-DD 格式' }, 400);
  }

  const levelParam = url.searchParams.get('level');
  const level = LEVELS.includes(levelParam as ErrorLevel) ? (levelParam as ErrorLevel) : undefined;
  const limitRaw = Number(url.searchParams.get('limit'));

  const log = await readDayLog(date, {
    level,
    source: url.searchParams.get('source') || undefined,
    route: url.searchParams.get('route') || undefined,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
  });

  return json({ success: true, ...log, retentionDays: retentionDays() }, 200);
};

export const POST: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  const action = new URL(request.url).searchParams.get('action');
  if (action !== 'prune') {
    return json({ success: false, error: '未知 action（支持：prune）' }, 400);
  }
  const deleted = await pruneOldLogs();
  return json({ success: true, deleted, retentionDays: retentionDays() }, 200);
};

/**
 * What the write pipeline is carrying: hotwords harvested but not stored, plans
 * generated but not flushed, and how many scheduled windows produced nothing. All
 * of it comes from Blobs, so it is readable during the outage it describes.
 */
async function pipelineReport() {
  const [trends, reports, state] = await Promise.all([
    pendingTrendBacklog(),
    pendingBufferedReports(),
    loadPipelineState(),
  ]);
  return {
    queuedTrendRows: trends.rows,
    queuedTrendBatches: trends.batches,
    oldestQueuedHarvestAt: trends.oldestHarvestedAt,
    intakeTtlHours: intakeTtlHours(),
    bufferedReports: reports.reports,
    bufferedBatches: reports.batches,
    lastRunStartedAt: state.lastRunStartedAt,
    lastHealthyRunAt: state.lastHealthyRunAt,
    lastFlushAt: state.lastFlushAt,
    consecutiveDegradedRuns: state.consecutiveDegradedRuns,
    lastRecoveryTriggerAt: state.lastRecoveryTriggerAt,
    lastSnapshotRepairAt: state.lastSnapshotRepairAt,
    missedRuns: missedRuns(state),
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
