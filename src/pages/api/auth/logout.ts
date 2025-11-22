import type { APIRoute } from 'astro';
import { authService } from '../../../lib/services/auth';

export const POST: APIRoute = async ({ cookies }) => {
  const token = cookies.get('session_token')?.value;

  if (token) {
    await authService.logout(token);
    cookies.delete('session_token', { path: '/' });
  }

  return new Response(JSON.stringify({
    success: true
  }), { status: 200 });
};

