import type { APIRoute } from 'astro';
import { bpService } from '../../../lib/services/bp';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const id = params.id || '';
  const result = await bpService.getById(id);

  if (!result.success) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : 500;
    return new Response(JSON.stringify({ success: false, error: result.error.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, data: result.data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
