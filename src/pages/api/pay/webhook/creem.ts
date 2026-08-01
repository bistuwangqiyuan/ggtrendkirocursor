/**
 * Creem's webhook endpoint. Register this URL under Developers > Webhooks and
 * subscribe to `checkout.completed`, `refund.created` and `dispute.created`.
 *
 * All the logic lives in lib/payments/webhook.ts — see that file for why a 200 is
 * only ever returned for something that was actually stored.
 */
import type { APIRoute } from 'astro';
import { handlePaymentWebhook } from '../../../../lib/payments/webhook';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const outcome = await handlePaymentWebhook('creem', request);
  return new Response(outcome.body, {
    status: outcome.status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
};
