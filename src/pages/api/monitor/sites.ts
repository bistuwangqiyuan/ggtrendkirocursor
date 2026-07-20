import type { APIRoute } from 'astro';
import { siteMonitorService, validateSiteUrl } from '../../../lib/services/siteMonitor';
import { authorizeAdminRequest } from '../../../lib/utils/adminAuth';

export const prerender = false;

/**
 * Monitored-site registry.
 *   GET    — public: sites with their latest check (feeds the /monitor page).
 *   POST   — admin (ADMIN_SECRET/CRON_SECRET): register a site {name, url}.
 *   DELETE — admin: remove a site by ?id=.
 */
export const GET: APIRoute = async () => {
  try {
    const sites = await siteMonitorService.listSitesWithLatestCheck();
    return json({ success: true, data: { sites } }, 200);
  } catch (error) {
    console.error('monitor sites GET error:', error);
    return json({ success: false, error: '服务器内部错误' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : '';
  const urlCheck = validateSiteUrl(typeof body?.url === 'string' ? body.url : '');
  if (!name || !urlCheck.ok) {
    return json({ success: false, error: !name ? 'name is required' : (urlCheck as { message: string }).message }, 400);
  }

  try {
    const site = await siteMonitorService.addSite(name, urlCheck.url);
    return json({ success: true, data: { site } }, 201);
  } catch (error) {
    console.error('monitor sites POST error:', error);
    return json({ success: false, error: '服务器内部错误' }, 500);
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return json({ success: false, error: auth.message }, auth.status);

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ success: false, error: 'valid id is required' }, 400);
  }

  try {
    const removed = await siteMonitorService.removeSite(id);
    return json({ success: removed, ...(removed ? {} : { error: 'not found' }) }, removed ? 200 : 404);
  } catch (error) {
    console.error('monitor sites DELETE error:', error);
    return json({ success: false, error: '服务器内部错误' }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
