import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';
import { isLlmConfigured } from '../../../lib/services/llm';

export const prerender = false;

/**
 * Scheduled BP generation trigger. Invoked by the Netlify Scheduled Function
 * (every 6h) with `Authorization: Bearer ${CRON_SECRET}`. No user session is
 * required, but a valid secret is mandatory so the endpoint cannot be abused
 * to spend LLM credits.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET?.trim();

  // Without a configured secret the endpoint is disabled (fail closed).
  if (!secret) {
    return json({ success: false, error: 'CRON_SECRET 未配置，定时任务已禁用' }, 503);
  }

  const auth = request.headers.get('authorization') || '';
  const provided = auth.replace(/^Bearer\s+/i, '').trim();
  if (!provided || provided !== secret) {
    return json({ success: false, error: '未授权' }, 401);
  }

  if (!isLlmConfigured()) {
    return json({ success: false, error: 'AI 服务未配置（缺少 LLM_API_KEY）', code: 'LLM_NOT_CONFIGURED' }, 503);
  }

  try {
    const result = await bpService.runScheduledGeneration();

    if (!result.success) {
      const code = result.error.code;
      const status = code === 'NO_TREND' ? 400
        : code === 'LLM_NOT_CONFIGURED' || code === 'LLM_ALL_ENDPOINTS_FAILED' ? 503
        : 500;
      return json({ success: false, action: 'failed', error: result.error.message, code, reportId: result.error.reportId }, status);
    }

    if (result.data.action === 'skipped') {
      return json({
        success: true,
        action: 'skipped',
        reason: result.data.reason,
      }, 200);
    }

    return json({
      success: true,
      action: 'generated',
      reportId: result.data.report.id,
      keyword: result.data.report.keyword,
      status: result.data.report.status,
      trendScore: result.data.trendScore,
      rank: result.data.rank,
    }, 200);
  } catch (error) {
    console.error('BP cron API error:', error);
    return json({ success: false, action: 'failed', error: '服务器内部错误' }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
