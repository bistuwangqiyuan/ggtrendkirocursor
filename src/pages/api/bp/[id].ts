import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';
import { bpIdExistsInSnapshot, getBpByIdFromSnapshot, isBpInFlight } from '../../../lib/cache/snapshotReaders';
import { readForPage } from '../../../lib/cache/readPath';
import { computeCacheHeaders, CACHE_PROFILES, NO_STORE_HEADERS } from '../../../lib/cache/httpCache';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async ({ params }) => {
  const id = params.id || '';

  const read = await readForPage(
    'api:bp:detail',
    () => getBpByIdFromSnapshot(id),
    async () => {
      const r = await bpService.getById(id);
      return r.success ? r.data : null;
    },
    { keyKnown: () => bpIdExistsInSnapshot(id) }
  );

  let report = read.data;

  // This endpoint is polled by /bp/[id] while a report generates, so an in-flight
  // report is refreshed from Postgres. The window is bounded (isBpInFlight) so a
  // stuck row can't be polled into steady database load.
  if (isBpInFlight(report)) {
    const fresh = await bpService.getById(id);
    if (fresh.success) report = fresh.data;
  }

  if (!report) {
    const exists = await bpIdExistsInSnapshot(id);
    if (exists === false) {
      return new Response(JSON.stringify({ success: false, error: 'BP 不存在' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    return new Response(
      JSON.stringify({ success: false, error: 'BP snapshot not available yet', code: 'SNAPSHOT_PENDING' }),
      { status: 503, headers: { ...JSON_HEADERS, ...NO_STORE_HEADERS } }
    );
  }

  const headers = isBpInFlight(report)
    ? { ...JSON_HEADERS, ...NO_STORE_HEADERS }
    : { ...JSON_HEADERS, ...computeCacheHeaders(CACHE_PROFILES.bpDetail) };

  return new Response(JSON.stringify({ success: true, data: report }), { status: 200, headers });
};
