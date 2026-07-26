import type { APIRoute } from 'astro';
import { bpService, SYNC_LLM_TIMEOUT_MS } from '../../../lib/services/bp';
import { isLlmConfigured } from '../../../lib/services/llm';
import { rateLimit, rateLimitResponse } from '../../../lib/utils/rateLimit';
import { captureGeneratedBpReport } from '../../../lib/cache/snapshotBuilder';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Require an authenticated user to trigger (paid) generation.
  if (!locals.user) {
    return new Response(JSON.stringify({ success: false, error: '请先登录后再生成商业计划书' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // LLM spend guards: 3 generations per user per minute, 20 per user per day.
  const perMinute = rateLimit(`bpgen-m:${locals.user.id}`, 3, 60_000);
  if (!perMinute.allowed) return rateLimitResponse(perMinute);
  const perDay = rateLimit(`bpgen-d:${locals.user.id}`, 20, 24 * 60 * 60 * 1000);
  if (!perDay.allowed) return rateLimitResponse(perDay, '已达到今日生成上限，请明天再试');

  if (!isLlmConfigured()) {
    return new Response(JSON.stringify({ success: false, error: 'AI 服务未配置（缺少 LLM_API_KEY）' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const result = await bpService.generate({
      keyword: typeof body.keyword === 'string' ? body.keyword.slice(0, 200) : undefined,
      trendId: typeof body.trendId === 'string' ? body.trendId.slice(0, 100) : undefined,
      timeRange: typeof body.timeRange === 'string' ? body.timeRange.slice(0, 20) : undefined,
      userId: locals.user.id,
    }, { llmTimeoutMs: SYNC_LLM_TIMEOUT_MS });

    if (!result.success) {
      const code = result.error.code;
      const status = code === 'NO_TREND' ? 400 : code === 'LLM_NOT_CONFIGURED' || code === 'LLM_ALL_ENDPOINTS_FAILED' ? 503 : 500;
      return new Response(
        JSON.stringify({ success: false, error: result.error.message, code, reportId: result.error.reportId }),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // The client redirects straight to /bp/{id}, which reads from the snapshot
    // store — so the report has to be there before we respond.
    await captureGeneratedBpReport(result.data);

    return new Response(
      JSON.stringify({ success: true, data: { id: result.data.id, status: result.data.status } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('BP generate API error:', error);
    return new Response(JSON.stringify({ success: false, error: '服务器内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
