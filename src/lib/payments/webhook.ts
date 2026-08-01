/**
 * The one code path where losing data means losing someone's money.
 *
 * Shared by both provider endpoints, because the difference between them ends at
 * the adapter: after `parseWebhook` there is one event type, one order table and
 * one set of rules.
 *
 * THE RULES
 * 1. Verify before parsing. An unsigned body is attacker input and is never
 *    allowed to reach the order table, so signature failure answers 401 and is
 *    recorded as an incident rather than a log line.
 * 2. Never answer 200 for something that was not stored. A provider that gets a
 *    200 stops retrying, so a swallowed error is a purchase erased.
 * 3. When Postgres is unavailable, store the verified event in Blobs and answer
 *    200 anyway. The buffered event is itself proof of payment — the success page
 *    honours it, and the drain job lands it later. This is the only case where a
 *    200 is given without a database write, and it is safe precisely because the
 *    signature was checked first.
 * 4. If even the buffer refuses, answer 503 so the provider retries. That is the
 *    last line: no store of any kind accepted the event, so the only remaining
 *    copy is at the provider.
 *
 * Astro's CSRF origin check does not apply here: it only covers form content
 * types, and both providers post application/json.
 */
import { adapterFor } from './index';
import { SignatureError, type PaymentEvent, type PaymentProvider } from './types';
import { bufferPaymentEvent } from './orderBuffer';
import { applyPaymentEvent } from '../services/orders';
import { recordError } from '../observability/errorLog';
import { paymentAlert } from './alerts';

export interface WebhookOutcome {
  status: number;
  body: string;
  /** For tests and logs: what actually happened to the event. */
  disposition: 'stored' | 'buffered' | 'ignored' | 'rejected' | 'lost';
  event?: PaymentEvent;
}

export async function handlePaymentWebhook(
  provider: PaymentProvider,
  request: Request
): Promise<WebhookOutcome> {
  const adapter = adapterFor(provider);
  if (!adapter) {
    return { status: 404, body: 'unknown provider', disposition: 'rejected' };
  }

  // The raw text, not a parsed body: the signature covers the exact bytes sent,
  // and re-serializing JSON would change them.
  const rawBody = await request.text();

  let event: PaymentEvent;
  try {
    event = adapter.parseWebhook(rawBody, request.headers);
  } catch (error) {
    if (error instanceof SignatureError) {
      // Worth a durable alert: either a misconfigured secret (payments are
      // silently not being recorded) or someone probing the endpoint. Throttled,
      // because this is the one alert a stranger can trigger at will.
      await paymentAlert('webhook_signature', `rejected ${provider} webhook: ${error.message}`, {
        provider,
        bodyBytes: rawBody.length,
      });
      return { status: 401, body: 'invalid signature', disposition: 'rejected' };
    }
    recordError('payments', error, { route: `/api/pay/webhook/${provider}`, context: { stage: 'parse' } });
    // Malformed but signed: retrying will not help, so do not ask for a retry.
    return { status: 400, body: 'unparseable payload', disposition: 'rejected' };
  }

  if (event.kind === 'ignored') {
    return { status: 200, body: `ignored ${event.type}`, disposition: 'ignored', event };
  }

  try {
    const order = await applyPaymentEvent(event);
    // A refund that matched no order revoked nothing. Retrying cannot help — the
    // row is simply not there — but silence would mean a refunded buyer keeping
    // their download, so it gets an alert and a human decision.
    if (event.kind === 'refunded' && !order) {
      await paymentAlert(
        'refund_unmatched',
        `${provider} refund ${event.providerOrderId || '(no order id)'} matched no order; access was not revoked`,
        { provider, checkoutId: event.checkoutId }
      );
    }
    return { status: 200, body: `${event.kind} recorded`, disposition: 'stored', event };
  } catch (error) {
    const buffered = await bufferPaymentEvent(event).catch(() => null);
    if (buffered) {
      // Through the same sink as every other payment failure: writing straight to
      // `ops_alerts` here would target the database that just refused the order.
      await paymentAlert(
        'webhook_buffered',
        `buffered ${provider} ${event.kind} ${event.providerOrderId}: order store unavailable`,
        { provider, reason: (error as Error).message }
      );
      return { status: 200, body: 'buffered', disposition: 'buffered', event };
    }

    // Nothing accepted it. Ask the provider to try again, and shout: this is the
    // shape of an actually lost payment.
    recordError('payments', error, {
      route: `/api/pay/webhook/${provider}`,
      context: { stage: 'store', providerOrderId: event.providerOrderId, buffered: false },
    });
    await paymentAlert(
      'webhook_unrecorded',
      `COULD NOT STORE ${provider} ${event.kind} ${event.providerOrderId} — neither Postgres nor Blobs accepted it`,
      { provider, reason: (error as Error).message }
    );
    return { status: 503, body: 'storage unavailable, please retry', disposition: 'lost', event };
  }
}
