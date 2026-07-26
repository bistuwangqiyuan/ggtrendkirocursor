import type { APIRoute } from 'astro';
import { bpService, parseBpStatusParam } from '../../../lib/services/bp';
import type { BpListSortBy, BpListSortOrder } from '../../../lib/services/bp';
import { listBpFromSnapshot } from '../../../lib/cache/snapshotReaders';
import { readForPage } from '../../../lib/cache/readPath';
import { computeCacheHeaders, CACHE_PROFILES } from '../../../lib/cache/httpCache';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  // `limit` is accepted as an alias for `pageSize` (principle of least surprise
  // for API consumers; both were observed in the wild).
  const rawSize = url.searchParams.get('pageSize') ?? url.searchParams.get('limit') ?? '20';
  const pageSize = parseInt(rawSize, 10);
  const sortParam = url.searchParams.get('sort');
  const orderParam = url.searchParams.get('order');
  const status = parseBpStatusParam(url.searchParams.get('status'));

  const sortBy: BpListSortBy = sortParam === 'riskAdjusted' ? 'riskAdjusted' : 'createdAt';
  const sortOrder: BpListSortOrder = orderParam === 'asc' ? 'asc' : 'desc';
  const safePage = Number.isFinite(page) ? page : 1;
  const safeSize = Number.isFinite(pageSize) ? pageSize : 20;

  const read = await readForPage(
    'api:bp:list',
    () => listBpFromSnapshot(safePage, safeSize, sortBy, sortOrder, status),
    async () => {
      const r = await bpService.list(safePage, safeSize, sortBy, sortOrder, status);
      return r.success
        ? r.data
        : { reports: [], pagination: { currentPage: 1, totalPages: 1, totalItems: 0, pageSize: safeSize } };
    }
  );

  if (read.pending) {
    return new Response(
      JSON.stringify({ success: false, error: 'BP snapshot not available yet', code: 'SNAPSHOT_PENDING' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...computeCacheHeaders({ sMaxAge: 30, staleWhileRevalidate: 60 }) } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, data: read.data, generatedAt: read.generatedAt?.toISOString() ?? null }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...computeCacheHeaders(CACHE_PROFILES.readApi) } }
  );
};
