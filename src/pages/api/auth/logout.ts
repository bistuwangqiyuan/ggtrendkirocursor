import type { APIRoute } from 'astro';
import { authService } from '../../../lib/services/auth';
import { extractToken } from '../../../lib/auth/sessionCookie';

export const POST: APIRoute = async ({ cookies }) => {
  // The cookie may be a signed envelope or a legacy raw token; the DELETE needs
  // the opaque token either way, since `sessions` remains the source of truth.
  const token = extractToken(cookies.get('session_token')?.value);

  if (token) {
    await authService.logout(token);
  }
  cookies.delete('session_token', { path: '/' });

  return new Response(JSON.stringify({
    success: true
  }), { status: 200 });
};
