import type { APIRoute } from 'astro';
import { trendsService } from '../../../lib/services/trends';
import { getTrendsFromSnapshot } from '../../../lib/cache/snapshotReaders';
import { readForPage } from '../../../lib/cache/readPath';
import { computeCacheHeaders, CACHE_PROFILES } from '../../../lib/cache/httpCache';
import type { TrendsQueryParams } from '../../../types/index';

export const prerender = false;

const EMPTY = { trends: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0, pageSize: 20 } };

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const timeRange = url.searchParams.get('timeRange') || '';

  const params: TrendsQueryParams = {
    timeRange: timeRange || undefined,
    collectedWithin: url.searchParams.get('collectedWithin') || undefined,
    keyword: url.searchParams.get('keyword') || undefined,
    category: url.searchParams.get('category') || undefined,
    sortBy: (url.searchParams.get('sortBy') as any) || 'search_volume',
    sortOrder: (url.searchParams.get('sortOrder') as any) || 'desc',
    page: parseInt(url.searchParams.get('page') || '1', 10),
    pageSize: parseInt(url.searchParams.get('pageSize') || '20', 10)
  };

  const dbFallback = async (p: TrendsQueryParams) => {
    const r = await trendsService.getTrends(p);
    return r.success ? r.data : EMPTY;
  };

  let read = await readForPage('api:trends:list', () => getTrendsFromSnapshot(params), () => dbFallback(params));

  // Fallback: if no results for the selected time range, retry without it.
  if (!read.pending && read.data.trends.length === 0 && timeRange) {
    const relaxed = { ...params, timeRange: undefined };
    const retry = await readForPage(
      'api:trends:list:relaxed',
      () => getTrendsFromSnapshot(relaxed),
      () => dbFallback(relaxed)
    );
    if (retry.data.trends.length > 0) read = retry;
  }

  if (read.pending) {
    return new Response(
      JSON.stringify({ success: false, error: 'Trends snapshot not available yet', code: 'SNAPSHOT_PENDING' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...computeCacheHeaders({ sMaxAge: 30, staleWhileRevalidate: 60 }) } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, data: read.data, generatedAt: read.generatedAt?.toISOString() ?? null }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...computeCacheHeaders(CACHE_PROFILES.readApi) } }
  );
};
