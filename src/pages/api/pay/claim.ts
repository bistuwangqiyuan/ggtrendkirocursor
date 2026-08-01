/**
 * Attach purchases made as a guest to an account.
 *
 * WHY THIS IS NOT AUTOMATIC
 * It would be trivial to match `orders.email` against `users.email` at login and
 * hand over every matching purchase. It would also be a data leak: registration
 * on this site does not verify the address, so anyone could sign up as
 * someone@example.com and inherit that person's downloads.
 *
 * So the account holder asks for a link (POST), the link is mailed to the address
 * being claimed, and opening it (GET with the token) performs the attach. The
 * token names both the address and the account id, so a link mailed to one person
 * cannot be used to fill somebody else's account.
 */
import type { APIRoute } from 'astro';
import { issueClaimToken, verifyToken } from '../../../lib/payments/tokens';
import { emailConfigured, magicLinkEmail, sendEmail } from '../../../lib/email/resend';
import { attachOrdersToUser, OrdersUnavailableError } from '../../../lib/services/orders';
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
  const user = locals.user;
  if (!user) return json({ success: false, error: 'login_required' }, 401);

  const rl = rateLimit(`claim:${user.id}`, 5, 10 * 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const requested = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Default to the account's own address, which is the common case: bought as a
  // guest first, registered afterwards with the same email.
  const email = requested || user.email?.toLowerCase() || '';
  if (!EMAIL.test(email)) return json({ success: false, error: 'invalid_email' }, 400);

  if (!emailConfigured()) return json({ success: false, error: 'email_unavailable' }, 503);

  const token = issueClaimToken(email, user.id);
  if (!token) return json({ success: false, error: 'tokens_unavailable' }, 503);

  const locale = locals.locale === 'en' ? 'en' : 'zh';
  const link = `${url.protocol}//${url.host}/api/pay/claim?token=${encodeURIComponent(token)}`;
  const message = magicLinkEmail(locale, 'claim', link);
  const result = await sendEmail({ to: email, ...message });
  if (!result.sent) {
    recordError('payments', `claim email failed: ${result.error}`, { route: '/api/pay/claim' });
    return json({ success: false, error: 'email_failed' }, 502);
  }
  return json({ success: true, sent: true });
};

/**
 * The link's landing point. A GET that changes state is normally wrong, but an
 * email client cannot POST, and the capability is the signed token rather than the
 * request method. The token is single-purpose and expires in 15 minutes.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const rl = rateLimit(`claim-open:${clientIpFromRequest(request)}`, 20, 10 * 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  const verified = verifyToken(url.searchParams.get('token'), 'claim');
  if (!verified.ok) {
    return Response.redirect(`${url.protocol}//${url.host}/orders?claim=${verified.reason}`, 302);
  }
  const { email, userId } = verified.claims;
  if (!email || !userId) {
    return Response.redirect(`${url.protocol}//${url.host}/orders?claim=malformed`, 302);
  }
  // The signed-in visitor must be the account the link was issued for, so a
  // forwarded link cannot move purchases into whoever opens it.
  if (locals.user?.id !== userId) {
    return Response.redirect(`${url.protocol}//${url.host}/orders?claim=wrong_account`, 302);
  }

  try {
    const attached = await attachOrdersToUser(email, userId);
    return Response.redirect(`${url.protocol}//${url.host}/orders?claim=ok&n=${attached}`, 302);
  } catch (error) {
    if (!(error instanceof OrdersUnavailableError)) {
      recordError('payments', error, { route: '/api/pay/claim', context: { stage: 'attach' } });
    }
    return Response.redirect(`${url.protocol}//${url.host}/orders?claim=unavailable`, 302);
  }
};
