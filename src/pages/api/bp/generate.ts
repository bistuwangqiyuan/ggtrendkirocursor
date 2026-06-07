import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';
import { isLlmConfigured } from '../../../lib/services/llm';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Require an authenticated user to trigger (paid) generation.
  if (!locals.user) {
    return new Response(JSON.stringify({ success: false, error: '请先登录后再生成商业计划书' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
    });

    if (!result.success) {
      const code = result.error.code;
      const status = code === 'NO_TREND' ? 400 : code === 'LLM_NOT_CONFIGURED' || code === 'LLM_ALL_ENDPOINTS_FAILED' ? 503 : 500;
      return new Response(
        JSON.stringify({ success: false, error: result.error.message, code, reportId: result.error.reportId }),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    }

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
