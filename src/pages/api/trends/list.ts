import type { APIRoute } from 'astro';
import { trendsService } from '../../../lib/services/trends';
import type { TrendsQueryParams } from '../../../types';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const params: TrendsQueryParams = {
    timeRange: (url.searchParams.get('timeRange') as any) || 'past_4_hours',
    keyword: url.searchParams.get('keyword') || undefined,
    category: url.searchParams.get('category') || undefined,
    sortBy: (url.searchParams.get('sortBy') as any) || 'search_volume',
    sortOrder: (url.searchParams.get('sortOrder') as any) || 'desc',
    page: parseInt(url.searchParams.get('page') || '1', 10),
    pageSize: parseInt(url.searchParams.get('pageSize') || '20', 10)
  };

  const result = await trendsService.getTrends(params);

  if (!result.success) {
    return new Response(JSON.stringify({
      success: false,
      error: result.error.message
    }), { status: 500 });
  }

  return new Response(JSON.stringify({
    success: true,
    data: result.data
  }), { status: 200 });
};

