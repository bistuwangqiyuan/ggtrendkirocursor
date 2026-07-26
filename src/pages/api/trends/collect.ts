import type { APIRoute } from 'astro';
import { trendsCollector, DEFAULT_GEOS } from '../../../lib/services/trendsCollector';
import { rebuildAllSnapshots } from '../../../lib/cache/snapshotBuilder';

export const prerender = false;

/**
 * Trends RSS collection trigger. Invoked by the Netlify Scheduled Function
 * (every 6h) with `Authorization: Bearer ${CRON_SECRET}`. No user session is
 * required, but a valid secret is mandatory (fail closed) so the endpoint
 * cannot be abused. Spends zero LLM tokens.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET?.trim();

  if (!secret) {
    return json({ success: false, error: 'CRON_SECRET 未配置，采集任务已禁用' }, 503);
  }

  const auth = request.headers.get('authorization') || '';
  const provided = auth.replace(/^Bearer\s+/i, '').trim();
  if (!provided || provided !== secret) {
    return json({ success: false, error: '未授权' }, 401);
  }

  let geos = DEFAULT_GEOS;
  try {
    const url = new URL(request.url);
    const g = url.searchParams.get('geos');
    if (g) {
      const parsed = g.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (parsed.length > 0) geos = parsed.slice(0, 12);
    }
  } catch {
    // ignore malformed query; use defaults
  }

  try {
    const summary = await trendsCollector.collect(geos);
    // Refresh the snapshots the read path serves from, while this wake window is
    // already open. Skippable via ?snapshots=0 for isolated collector testing.
    let snapshots: unknown = 'skipped';
    if (new URL(request.url).searchParams.get('snapshots') !== '0') {
      snapshots = await rebuildAllSnapshots({ only: ['trends', 'landing'], budgetMs: 60_000 });
    }
    return json({ success: true, ...summary, snapshots }, 200);
  } catch (error) {
    console.error('Trends collect API error:', error);
    return json({ success: false, error: '服务器内部错误' }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
