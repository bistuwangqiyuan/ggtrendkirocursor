import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';
import type { BpListSortBy, BpListSortOrder } from '../../../lib/services/bp';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10);
  const sortParam = url.searchParams.get('sort');
  const orderParam = url.searchParams.get('order');

  const sortBy: BpListSortBy = sortParam === 'riskAdjusted' ? 'riskAdjusted' : 'createdAt';
  const sortOrder: BpListSortOrder = orderParam === 'asc' ? 'asc' : 'desc';

  const result = await bpService.list(
    Number.isFinite(page) ? page : 1,
    Number.isFinite(pageSize) ? pageSize : 20,
    sortBy,
    sortOrder
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
