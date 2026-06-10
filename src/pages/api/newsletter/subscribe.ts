import type { APIRoute } from 'astro';
import { queryOne, query } from '../../../lib/db/client';
import { isValidNewsletterEmail } from '../../../lib/validators/newsletter';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!isValidNewsletterEmail(email)) {
      return new Response(JSON.stringify({ success: false, error: 'invalid_email' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM newsletter_subscribers WHERE email = $1',
      [email]
    );

    if (existing) {
      return new Response(JSON.stringify({ success: false, error: 'already_subscribed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await query('INSERT INTO newsletter_subscribers (email) VALUES ($1)', [email]);

    return new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Newsletter subscribe error:', e);
    return new Response(JSON.stringify({ success: false, error: 'server_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
