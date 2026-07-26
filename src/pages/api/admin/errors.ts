import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';
import { listLogDates, readDayLog, pruneOldLogs, retentionDays } from '../../../lib/observability/errorLog';
import { NO_STORE_HEADERS } from '../../../lib/cache/httpCache';
import type { ErrorLevel } from '../../../lib/observability/errorLog';

export const prerender = false;

const HEADERS = { 'Content-Type': 'application/json', ...NO_STORE_HEADERS };
const LEVELS: ErrorLevel[] = ['error', 'warn', 'info'];

/**
 * Day-partitioned runtime error log, plus the database wake-up meter.
 *
 * Reads from Netlify Blobs, never Postgres — this endpoint has to work precisely
 * when the database does not.
 *
 * GET  /api/admin/errors                  -> available dates + retention window
 * GET  /api/admin/errors?date=YYYY-MM-DD  -> that day's entries and wake stats
 * POST /api/admin/errors?action=prune     -> delete logs past the retention window
 */
export const GET: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  if (!date) {
    return json({ success: true, dates: await listLogDates(), retentionDays: retentionDays() }, 200);
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
