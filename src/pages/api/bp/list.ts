import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10);

  const result = await bpService.list(
    Number.isFinite(page) ? page : 1,
    Number.isFinite(pageSize) ? pageSize : 20
  );

  if (!result.success) {
    return new Response(JSON.stringify({ success: false, error: result.error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, data: result.data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
