import type { APIRoute } from 'astro';
import { authService } from '../../../lib/services/auth';
import { rateLimit, rateLimitResponse, clientIpFromRequest } from '../../../lib/utils/rateLimit';

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  // Brute-force baseline: 10 login attempts per IP per minute.
  const rl = rateLimit(`login:${clientIpFromRequest(request)}`, 10, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const body = await request.json();
    const { email, password } = body;
    const userAgent = request.headers.get('user-agent') || '';

    if (!email || !password) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400 });
    }

    const result = await authService.login(email, password, clientAddress, userAgent);

    if (!result.success) {
      return new Response(JSON.stringify({
        success: false,
        error: result.error.message
      }), { status: 401 });
    }

    const { session, user } = result.data;

    // Set session cookie
    cookies.set('session_token', session.token, {
      path: '/',
      httpOnly: true,
      secure: import.meta.env.PROD, // True in production
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30 // 30 days in seconds
    });

    // Set locale cookie if user has preference
    if (user.locale) {
      cookies.set('locale', user.locale, {
        path: '/',
        maxAge: 60 * 60 * 24 * 365
      });
    }

    return new Response(JSON.stringify({
      success: true,
      user
    }), { status: 200 });
  } catch (error) {
    console.error('Login API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error'
    }), { status: 500 });
  }
};

