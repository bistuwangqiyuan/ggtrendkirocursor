import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';
import { ALL_SECTIONS, rebuildAllSnapshots, type SnapshotSection } from '../../../lib/cache/snapshotBuilder';

export const prerender = false;

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
    const invalid = requested.filter((s) => !ALL_SECTIONS.includes(s as SnapshotSection));
    if (invalid.length > 0) {
      return json({ success: false, error: `未知的 sections: ${invalid.join(', ')}` }, 400);
    }
    only = requested as SnapshotSection[];
  }

  // This route is a synchronous function (~26s ceiling on Netlify), so it must
  // default to a budget it can actually finish inside; without one, the first
  // build over thousands of keywords 504s and the caller learns nothing about
  // what got written. Sections left unfinished report `truncated` and resume on
  // the next call — the cron path passes its own, much larger budget.
  const budgetRaw = Number(url.searchParams.get('budgetMs'));
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 20_000;

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
