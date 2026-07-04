import type { APIRoute } from 'astro';
import { authService } from '../../../lib/services/auth';
import { rateLimit, rateLimitResponse, clientIpFromRequest } from '../../../lib/utils/rateLimit';

export const POST: APIRoute = async ({ request }) => {
  // Abuse baseline: 5 registrations per IP per minute.
  const rl = rateLimit(`register:${clientIpFromRequest(request)}`, 5, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const body = await request.json();
    const { username, email, password } = body;

    if (!username || !email || !password) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), { status: 400 });
    }

    const result = await authService.register(username, email, password);

    if (!result.success) {
      return new Response(JSON.stringify({
        success: false,
        error: result.error.message,
        field: result.error.field
      }), { status: result.error.code === 'USER_EXISTS' ? 409 : 400 });
    }

    return new Response(JSON.stringify({
      success: true,
      user: result.data
    }), { status: 201 });
  } catch (error) {
    console.error('Register API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error'
    }), { status: 500 });
  }
};

