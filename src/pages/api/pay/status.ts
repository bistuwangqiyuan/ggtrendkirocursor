/**
 * "Has my payment landed yet?" — polled by the report page after the buyer
 * returns from the hosted checkout, and answered with a download token once it
 * has.
 *
 * THREE WAYS TO BE ENTITLED, IN ORDER OF PREFERENCE
 * 1. The purchase reference from the success URL. A server-generated random UUID
 *    delivered only to the buyer, so it works for a guest with no account and no
 *    cookie — which is the majority case for a one-dollar file.
 * 2. The session. A logged-in buyer keeps access to anything their account has
 *    bought, on any device, forever.
 * 3. The signature-verified webhook sitting in the Blobs buffer, when Postgres is
 *    unavailable. Someone who has just paid should not be told to come back later
 *    because of a database outage; the provider's signed statement is proof enough.
 */
import type { APIRoute } from 'astro';
import {
  findEntitlement,
  findOrderByReference,
  OrdersUnavailableError,
  type Order,
} from '../../../lib/services/orders';
import { bufferedEntitlement } from '../../../lib/payments/orderBuffer';
import { issueDownloadToken } from '../../../lib/payments/tokens';
import { clientIpFromRequest, rateLimit, rateLimitResponse } from '../../../lib/utils/rateLimit';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ request, url, locals }) => {
  // Polling every few seconds is the expected behaviour, so this is loose enough
  // for that and tight enough to stop reference guessing being worth attempting.
  const rl = rateLimit(`pay-status:${clientIpFromRequest(request)}`, 60, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  const reportId = (url.searchParams.get('reportId') || '').trim();
  const reference = (url.searchParams.get('reference') || '').trim();
  const user = locals.user;
  if (!reportId) return json({ success: false, error: 'missing_report' }, 400);

  let order: Order | null = null;
  let degraded = false;

  try {
    if (reference) order = await findOrderByReference(reference);
    if (!order && user) order = await findEntitlement(reportId, { userId: user.id, email: user.email });
  } catch (error) {
    if (!(error instanceof OrdersUnavailableError)) throw error;
    degraded = true;
  }

  // A reference is proof of being the buyer, but not of being the buyer of THIS
  // report: without this check a paid $1 order would unlock every report.
  if (order && order.reportId && order.reportId !== reportId) order = null;

  if (order?.status === 'paid') {
    const token = issueDownloadToken(order.id, reportId);
    return json({
      success: true,
      status: 'paid',
      token,
      downloadUrl: token ? `/api/download/bp/${reportId}?token=${encodeURIComponent(token)}` : null,
      email: order.email,
    });
  }

  if (order?.status === 'refunded') {
    return json({ success: true, status: 'refunded' });
  }

  // Either the order row is not there yet (the webhook can lag the redirect by a
  // few seconds) or the database cannot be read. In both cases the buffered
  // webhook is worth checking, and in the second it is the only thing available.
  if (!order || degraded) {
    const buffered = await bufferedEntitlement(reportId, {
      reference: reference || null,
      email: user?.email || null,
    });
    if (buffered) {
      // No order id to bind to yet, so the token is scoped to the provider's order
      // id. The download endpoint accepts that and skips the per-order counter,
      // which is a deliberate trade: an uncounted download beats a refused one.
      const token = issueDownloadToken(`buffered:${buffered.providerOrderId}`, reportId);
      return json({
        success: true,
        status: 'paid',
        degraded: true,
        token,
        downloadUrl: token ? `/api/download/bp/${reportId}?token=${encodeURIComponent(token)}` : null,
        email: buffered.email,
      });
    }
  }

  return json({ success: true, status: order ? order.status : 'pending', degraded });
};
