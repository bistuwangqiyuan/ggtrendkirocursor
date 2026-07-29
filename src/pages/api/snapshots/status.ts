import type { APIRoute } from 'astro';
import { SNAPSHOT_KEYS, readSnapshot, listSnapshotKeys, snapshotBackend } from '../../../lib/cache/snapshot';
import { snapshotStaleness } from '../../../lib/cache/snapshotDelivery';

export const prerender = false;

/**
 * Snapshot freshness report. Deliberately public and DB-free: it is the health
 * check for the layer that keeps page reads off Neon, so it must stay readable
 * even while the database is suspended. Exposes only key names, counts and
 * timestamps.
 *
 * Returns 503 when a snapshot is missing or frozen past `SNAPSHOT_MAX_AGE_SECONDS`,
 * so any uptime monitor pointed here catches a read side that stopped being
 * refreshed. Before this, the endpoint answered 200 with a 44-hour-old timestamp
 * in the body and nothing was watching the body.
 */
export const GET: APIRoute = async () => {
  const singles: Record<string, string> = {
    trendsTop: SNAPSHOT_KEYS.trendsTop,
    trendsCategories: SNAPSHOT_KEYS.trendsCategories,
    landingIndex: SNAPSHOT_KEYS.landingIndex,
    bpList: SNAPSHOT_KEYS.bpList,
    monitorLatest: SNAPSHOT_KEYS.monitorLatest,
    statsOverview: SNAPSHOT_KEYS.statsOverview,
  };

  const snapshots: Record<string, { present: boolean; generatedAt: string | null; ageSeconds: number | null; items: number | null }> = {};
  for (const [name, key] of Object.entries(singles)) {
    const snap = await readSnapshot<unknown>(key);
    snapshots[name] = {
      present: !!snap,
      generatedAt: snap?.generatedAt ?? null,
      ageSeconds: snap ? Math.round((Date.now() - Date.parse(snap.generatedAt)) / 1000) : null,
      items: countItems(snap?.data),
    };
  }

  const [landingDetails, bpDetails] = await Promise.all([
    listSnapshotKeys('landing/detail/'),
    listSnapshotKeys('bp/detail/'),
  ]);

  // snapshotStaleness already counts a missing witness as stale, and it is what
  // the hourly repair job acts on. Judging freshness here any other way would let
  // this endpoint report a problem that nothing goes on to fix.
  const freshness = await snapshotStaleness();
  const ok = !freshness.stale;
  return new Response(
    JSON.stringify({
      ok,
      backend: await snapshotBackend(),
      stale: freshness.stale,
      maxAgeSeconds: freshness.maxAgeSeconds,
      staleAfterSeconds: freshness.staleAfterSeconds,
      staleSections: freshness.staleSections,
      snapshots,
      detailCounts: { landing: landingDetails.length, bp: bpDetails.length },
    }),
    {
      status: ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }
  );
};

function countItems(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    for (const field of ['rows', 'keywords', 'reports', 'sites', 'daily']) {
      const value = (data as Record<string, unknown>)[field];
      if (Array.isArray(value)) return value.length;
    }
  }
  return null;
}
