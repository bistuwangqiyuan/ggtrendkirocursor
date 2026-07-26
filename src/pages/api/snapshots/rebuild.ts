import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';
import { rebuildAllSnapshots, type SnapshotSection } from '../../../lib/cache/snapshotBuilder';

export const prerender = false;

const VALID_SECTIONS: SnapshotSection[] = ['trends', 'landing', 'bp', 'monitor'];

/**
 * Force a snapshot rebuild. Needed to bootstrap a fresh deploy (before the first
 * scheduled run) and to recover after a snapshot store wipe. Admin-gated because
 * it opens a Neon wake window and reads the whole dataset.
 *
 * `?sections=trends,bp` limits the rebuild; omitting it rebuilds everything.
 */
export const POST: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  const url = new URL(request.url);
  const raw = url.searchParams.get('sections');
  let only: SnapshotSection[] | undefined;
  if (raw) {
    const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const invalid = requested.filter((s) => !VALID_SECTIONS.includes(s as SnapshotSection));
    if (invalid.length > 0) {
      return json({ success: false, error: `未知的 sections: ${invalid.join(', ')}` }, 400);
    }
    only = requested as SnapshotSection[];
  }

  const budgetRaw = Number(url.searchParams.get('budgetMs'));
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : undefined;

  try {
    const report = await rebuildAllSnapshots({ only, budgetMs });
    return json({ success: report.ok, report }, report.ok ? 200 : 500);
  } catch (error) {
    console.error('snapshot rebuild error:', error);
    return json({ success: false, error: (error as Error).message }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
