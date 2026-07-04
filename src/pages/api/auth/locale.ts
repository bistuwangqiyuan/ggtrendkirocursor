import type { APIRoute } from 'astro';
import { query } from '../../../lib/db/client';

export const prerender = false;

/**
 * Switch the UI language. Sets the `locale` cookie for everyone and, for
 * logged-in users, persists the preference to `users.locale` (requirement 4.5)
 * so the choice survives across devices/sessions. Without this persistence the
 * middleware used to "restore" the stored (stale) locale on every request,
 * making it impossible for logged-in users to switch languages.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const locale = body?.locale;
  if (locale !== 'zh' && locale !== 'en') {
    return new Response(JSON.stringify({ success: false, error: 'locale must be "zh" or "en"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  cookies.set('locale', locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });

  if (locals.user) {
    try {
      await query('UPDATE users SET locale = $1, updated_at = NOW() WHERE id = $2', [locale, locals.user.id]);
    } catch (error) {
      // Cookie is already set, so the switch still works for this browser;
      // report the persistence failure honestly instead of a fake success.
      console.error('Persist locale failed:', (error as Error).message);
      return new Response(JSON.stringify({ success: true, persisted: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ success: true, persisted: !!locals.user }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
