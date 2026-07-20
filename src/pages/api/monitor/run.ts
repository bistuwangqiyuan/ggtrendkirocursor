import type { APIRoute } from 'astro';
import { siteMonitorService } from '../../../lib/services/siteMonitor';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';

export const prerender = false;

/**
 * Run uptime + SEO checks for every enabled monitored site. Invoked by the
 * Netlify scheduled function (or manually) with the CRON/ADMIN secret. Spends
 * zero LLM tokens; each probe is a handful of plain HTTP requests.
 */
export const POST: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  try {
    const results = await siteMonitorService.runChecks();
    return json({
      success: true,
      checked: results.length,
      up: results.filter((r) => r.ok).length,
      down: results.filter((r) => !r.ok).length,
      results: results.map((r) => ({
        siteId: r.siteId,
        ok: r.ok,
        httpStatus: r.httpStatus,
        responseMs: r.responseMs,
        seoScore: r.seoScore,
        error: r.error,
      })),
    }, 200);
  } catch (error) {
    console.error('monitor run error:', error);
    return json({ success: false, error: '服务器内部错误' }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
