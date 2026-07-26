import type { APIRoute } from 'astro';
import { SNAPSHOT_KEYS, readSnapshot, listSnapshotKeys } from '../../../lib/cache/snapshot';

export const prerender = false;

/**
 * Snapshot freshness report. Deliberately public and DB-free: it is the health
 * check for the layer that keeps page reads off Neon, so it must stay readable
 * even while the database is suspended. Exposes only key names, counts and
 * timestamps.
 */
export const GET: APIRoute = async () => {
  const singles: Record<string, string> = {
    trendsTop: SNAPSHOT_KEYS.trendsTop,
    trendsCategories: SNAPSHOT_KEYS.trendsCategories,
    landingIndex: SNAPSHOT_KEYS.landingIndex,
    bpList: SNAPSHOT_KEYS.bpList,
    monitorLatest: SNAPSHOT_KEYS.monitorLatest,
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

  const allPresent = Object.values(snapshots).every((s) => s.present);
  return new Response(
    JSON.stringify({
      ok: allPresent,
      snapshots,
      detailCounts: { landing: landingDetails.length, bp: bpDetails.length },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

function countItems(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    for (const field of ['rows', 'keywords', 'reports', 'sites']) {
      const value = (data as Record<string, unknown>)[field];
      if (Array.isArray(value)) return value.length;
    }
  }
  return null;
}
