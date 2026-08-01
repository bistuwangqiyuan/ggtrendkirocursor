/**
 * "I bought this last week and lost the link."
 *
 * Emails a 15-minute magic link that opens the order list for one address. The
 * email round trip is the point: without it, typing a stranger's address into a
 * form would list their purchases.
 *
 * The response never reveals whether the address has any orders. Answering
 * "no orders for that email" would turn this endpoint into a way to test whether
 * a given person is a customer.
 */
import type { APIRoute } from 'astro';
import { issueOrdersToken } from '../../../lib/payments/tokens';
import { emailConfigured, magicLinkEmail, sendEmail } from '../../../lib/email/resend';
import { recordError } from '../../../lib/observability/errorLog';
import { clientIpFromRequest, rateLimit, rateLimitResponse } from '../../../lib/utils/rateLimit';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, url, locals }) => {
  // Two limits, because they stop different things: the per-IP one stops someone
  // enumerating addresses, and the per-address one stops this endpoint being used
  // to flood a person's inbox from many IPs.
  const byIp = rateLimit(`lookup-ip:${clientIpFromRequest(request)}`, 5, 10 * 60_000);
  if (!byIp.allowed) return rateLimitResponse(byIp);

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return json({ success: false, error: 'invalid_email' }, 400);

  const byEmail = rateLimit(`lookup-email:${email}`, 3, 10 * 60_000);
  if (!byEmail.allowed) return rateLimitResponse(byEmail);

  if (!emailConfigured()) {
    // Honest, not silent: the buyer needs to know to use the support form instead.
    return json({ success: false, error: 'email_unavailable' }, 503);
  }

  const token = issueOrdersToken(email);
  if (!token) return json({ success: false, error: 'tokens_unavailable' }, 503);

  const locale = locals.locale === 'en' ? 'en' : 'zh';
  const link = `${url.protocol}//${url.host}/orders?token=${encodeURIComponent(token)}`;
  const message = magicLinkEmail(locale, 'orders', link);
  const result = await sendEmail({ to: email, ...message });

  if (!result.sent) {
    recordError('payments', `order lookup email failed: ${result.error}`, { route: '/api/pay/lookup' });
  }

  // Same answer either way. See the file header.
  return json({ success: true, sent: true });
};
