/**
 * Creem adapter — the primary provider.
 *
 * Chosen first because it is a merchant of record that pays out to Chinese
 * individuals and accepts the payment methods this site's buyers actually have:
 * cards, Apple/Google Pay, Alipay. As MoR it also owns the VAT/GST obligations
 * for every country it sells into, which an individual seller cannot realistically
 * discharge alone.
 *
 * API facts this file depends on (docs.creem.io, verified 2026-08):
 *   POST {base}/v1/checkouts   header `x-api-key`, body { product_id, request_id,
 *                              success_url, customer.email, metadata }
 *                              -> { id, checkout_url }
 *   webhook header `creem-signature` = HMAC-SHA256(rawBody, webhook secret), hex
 *   events: checkout.completed (object = checkout, with .order and .customer),
 *           refund.created (object = refund, order id under .transaction.order)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CheckoutRequest, CheckoutSession, PaymentAdapter, PaymentEvent } from './types';
import { SignatureError } from './types';

/**
 * Creem's sandbox is a different host, not a flag on the request. Pointing the
 * whole adapter at it is how the payment path gets exercised without moving real
 * money; production must leave CREEM_TEST_MODE unset.
 */
function apiBase(): string {
  return process.env.CREEM_TEST_MODE === 'true'
    ? 'https://test-api.creem.io'
    : 'https://api.creem.io';
}

function apiKey(): string | undefined {
  return process.env.CREEM_API_KEY?.trim() || undefined;
}

function productId(): string | undefined {
  return process.env.CREEM_PRODUCT_ID?.trim() || undefined;
}

function webhookSecret(): string | undefined {
  return process.env.CREEM_WEBHOOK_SECRET?.trim() || undefined;
}

/** Hex-safe constant-time compare; a malformed header must not throw. */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Creem nests differently per event; ids may arrive as a string or an object. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

export const creem: PaymentAdapter = {
  provider: 'creem',

  configured() {
    return !!apiKey() && !!productId();
  },

  webhookConfigured() {
    return !!webhookSecret();
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const key = apiKey();
    const product = productId();
    if (!key || !product) throw new Error('Creem not configured (CREEM_API_KEY / CREEM_PRODUCT_ID)');

    // The price lives on the Creem product, never in this request: a
    // client-supplied amount is the classic way a $1 download becomes a $0.01
    // one, and `custom_price` exists precisely for the cases where that is
    // wanted. This is not one of them.
    const res = await fetch(`${apiBase()}/v1/checkouts`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: product,
        request_id: request.reference,
        success_url: request.successUrl,
        ...(request.email ? { customer: { email: request.email } } : {}),
        metadata: {
          reportId: request.reportId,
          reference: request.reference,
          locale: request.locale,
          ...(request.userId ? { userId: request.userId } : {}),
        },
      }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Creem checkout failed: ${res.status} ${text.slice(0, 300)}`);

    let json: { id?: string; checkout_url?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Creem checkout returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!json.checkout_url) throw new Error(`Creem checkout returned no URL: ${text.slice(0, 200)}`);

    return { provider: 'creem', checkoutId: json.id || request.reference, url: json.checkout_url };
  },

  parseWebhook(rawBody: string, headers: Headers): PaymentEvent {
    const secret = webhookSecret();
    if (!secret) throw new SignatureError('CREEM_WEBHOOK_SECRET not configured');

    const provided = headers.get('creem-signature');
    if (!provided) throw new SignatureError('missing creem-signature header');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signatureMatches(expected, provided)) throw new SignatureError('creem signature mismatch');

    // Only parsed after the signature holds, so this is our own data now.
    const event = JSON.parse(rawBody) as {
      eventType?: string;
      object?: Record<string, any>;
    };
    const type = event.eventType || 'unknown';
    const object = event.object || {};

    if (type === 'checkout.completed') {
      const metadata = (object.metadata || {}) as Record<string, string | undefined>;
      const order = object.order;
      return {
        kind: 'paid',
        provider: 'creem',
        // The order id, not the checkout id: a buyer who reopens an abandoned
        // checkout can produce two completions, and the order is what was paid.
        providerOrderId: idOf(order) || String(object.id),
        checkoutId: typeof object.id === 'string' ? object.id : undefined,
        email: object.customer?.email,
        amountCents: typeof order === 'object' ? (order?.amount_paid ?? order?.amount) : undefined,
        currency: typeof order === 'object' ? order?.currency : undefined,
        reportId: metadata.reportId,
        userId: metadata.userId,
        reference: metadata.reference || object.request_id,
      };
    }

    if (type === 'refund.created' || type === 'dispute.created') {
      // A refund event carries the order under the transaction; a dispute carries
      // it directly. Both must revoke, or a chargeback would leave the file open.
      const providerOrderId =
        idOf(object.order) || idOf(object.transaction?.order) || '';
      return {
        kind: 'refunded',
        provider: 'creem',
        providerOrderId,
        checkoutId: idOf(object.checkout),
      };
    }

    return { kind: 'ignored', provider: 'creem', type };
  },
};
