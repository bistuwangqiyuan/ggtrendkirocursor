/**
 * Open a hosted checkout for one report PDF.
 *
 * The price and the product live on the payment provider. Nothing about the
 * amount comes from the browser, because a client-supplied price is how a
 * one-dollar download becomes a one-cent one.
 *
 * The buyer may be logged in or a guest. A logged-in buyer's account and email
 * come from the session; a guest types an email, which is prefilled into the
 * hosted checkout and stored on the pending order so the payment can be matched
 * back to this report even if they change it at the provider.
 */
import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import { createCheckout, priceCents } from '../../../lib/payments';
import { createPendingOrder, OrdersUnavailableError } from '../../../lib/services/orders';
import { bpIdExistsInSnapshot, getBpByIdFromSnapshot } from '../../../lib/cache/snapshotReaders';
import { recordError } from '../../../lib/observability/errorLog';
import { paymentAlert } from '../../../lib/payments/alerts';
import { clientIpFromRequest, rateLimit, rateLimitResponse } from '../../../lib/utils/rateLimit';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, locals, url }) => {
  // Each attempt costs an API call to the provider and a database row, so this is
  // deliberately tighter than the read endpoints.
  const rl = rateLimit(`checkout:${clientIpFromRequest(request)}`, 8, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const reportId = typeof body.reportId === 'string' ? body.reportId.trim() : '';
  const user = locals.user;
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const email = user?.email?.toLowerCase() || rawEmail;
  const locale = locals.locale === 'en' ? 'en' : 'zh';

  if (!reportId) return json({ success: false, error: 'missing_report' }, 400);
  // A guest with no email would have no way to find the purchase again, so the
  // field is required rather than optional-with-a-shrug.
  if (!email || !EMAIL.test(email)) return json({ success: false, error: 'invalid_email' }, 400);

  // Only completed reports are sellable, and the check reads the snapshot rather
  // than Postgres so the buy button costs no database time.
  const report = await getBpByIdFromSnapshot(reportId);
  if (!report) {
    const known = await bpIdExistsInSnapshot(reportId);
    return json({ success: false, error: known === false ? 'unknown_report' : 'report_unavailable' }, known === false ? 404 : 503);
  }
  if (report.status !== 'completed' || !report.contentJson) {
    return json({ success: false, error: 'report_not_ready' }, 409);
  }

  const reference = randomUUID();
  const origin = `${url.protocol}//${url.host}`;
  const successUrl = `${origin}/bp/${reportId}?purchase=${reference}`;

  const { session, failures } = await createCheckout({
    reportId,
    email,
    userId: user?.id,
    locale,
    successUrl,
    reference,
  });

  // A failing primary must be visible even when the fallback saved the sale,
  // otherwise Creem could be broken for a week while revenue looks normal.
  for (const failure of failures) {
    recordError('payments', `${failure.provider} checkout failed: ${failure.error}`, {
      route: '/api/pay/checkout',
      context: { reportId, provider: failure.provider },
    });
  }

  if (!session) {
    if (failures.length === 0) {
      return json({ success: false, error: 'payments_unavailable' }, 503);
    }
    // Every provider refused: durable alert, because this is revenue stopping.
    await paymentAlert('checkout_failed', 'all payment providers failed to create a checkout', {
      reportId,
      failures,
    });
    return json({ success: false, error: 'checkout_failed', failures: failures.map((f) => f.provider) }, 502);
  }

  // Best effort: the row lets the success page poll and preserves the account
  // link, but a database that is down must not block a payment we can still take
  // — the webhook is signature-verified and carries everything needed to rebuild
  // this row later.
  let orderId: string | null = null;
  try {
    const order = await createPendingOrder({
      provider: session.provider,
      checkoutId: session.checkoutId,
      reference,
      reportId,
      email,
      userId: user?.id ?? null,
      amountCents: priceCents(),
    });
    orderId = order?.id ?? null;
  } catch (error) {
    if (!(error instanceof OrdersUnavailableError)) {
      recordError('payments', error, { route: '/api/pay/checkout', context: { stage: 'pending-order' } });
    }
  }

  return json({
    success: true,
    url: session.url,
    provider: session.provider,
    checkoutId: session.checkoutId,
    reference,
    orderId,
    fellBack: failures.length > 0,
  });
};
