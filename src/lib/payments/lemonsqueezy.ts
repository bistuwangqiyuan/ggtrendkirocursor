/**
 * Lemon Squeezy adapter — the fallback provider.
 *
 * Its job is not to be better than Creem but to be *independent* of it. A
 * provider outage, an account review, or a mistyped key would otherwise mean the
 * site can display a buy button that cannot take money, and a buyer who fails to
 * pay does not come back. Two unrelated merchants of record make that a retry
 * instead of a lost sale.
 *
 * API facts this file depends on (docs.lemonsqueezy.com, verified 2026-08):
 *   POST https://api.lemonsqueezy.com/v1/checkouts   JSON:API, Bearer key,
 *     attributes.checkout_data.{email,custom}, attributes.product_options.redirect_url,
 *     relationships.store + relationships.variant
 *     -> data.attributes.url
 *   webhook header `X-Signature` = HMAC-SHA256(rawBody, signing secret), hex
 *   events (X-Event-Name / meta.event_name): order_created, order_refunded;
 *     custom data comes back as meta.custom_data
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CheckoutRequest, CheckoutSession, PaymentAdapter, PaymentEvent } from './types';
import { SignatureError } from './types';

const API = 'https://api.lemonsqueezy.com/v1/checkouts';

function apiKey(): string | undefined {
  return process.env.LEMONSQUEEZY_API_KEY?.trim() || undefined;
}

function storeId(): string | undefined {
  return process.env.LEMONSQUEEZY_STORE_ID?.trim() || undefined;
}

function variantId(): string | undefined {
  return process.env.LEMONSQUEEZY_VARIANT_ID?.trim() || undefined;
}

function webhookSecret(): string | undefined {
  return process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim() || undefined;
}

function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const lemonsqueezy: PaymentAdapter = {
  provider: 'lemonsqueezy',

  configured() {
    return !!apiKey() && !!storeId() && !!variantId();
  },

  webhookConfigured() {
    return !!webhookSecret();
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const key = apiKey();
    const store = storeId();
    const variant = variantId();
    if (!key || !store || !variant) {
      throw new Error('Lemon Squeezy not configured (API key / store / variant)');
    }

    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              ...(request.email ? { email: request.email } : {}),
              // Everything here returns as meta.custom_data on the webhook.
              // Values must be strings: numbers survive the round trip as
              // strings anyway, and mixing types made the payload harder to read.
              custom: {
                reportId: request.reportId,
                reference: request.reference,
                locale: request.locale,
                ...(request.userId ? { userId: request.userId } : {}),
              },
            },
            product_options: { redirect_url: request.successUrl },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(store) } },
            variant: { data: { type: 'variants', id: String(variant) } },
          },
        },
      }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Lemon Squeezy checkout failed: ${res.status} ${text.slice(0, 300)}`);

    let json: { data?: { id?: string; attributes?: { url?: string } } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Lemon Squeezy checkout returned non-JSON: ${text.slice(0, 200)}`);
    }
    const url = json.data?.attributes?.url;
    if (!url) throw new Error(`Lemon Squeezy checkout returned no URL: ${text.slice(0, 200)}`);

    return { provider: 'lemonsqueezy', checkoutId: json.data?.id || request.reference, url };
  },

  parseWebhook(rawBody: string, headers: Headers): PaymentEvent {
    const secret = webhookSecret();
    if (!secret) throw new SignatureError('LEMONSQUEEZY_WEBHOOK_SECRET not configured');

    const provided = headers.get('x-signature');
    if (!provided) throw new SignatureError('missing X-Signature header');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signatureMatches(expected, provided)) throw new SignatureError('lemonsqueezy signature mismatch');

    const event = JSON.parse(rawBody) as {
      meta?: { event_name?: string; custom_data?: Record<string, string | undefined> };
      data?: { id?: string; attributes?: Record<string, any> };
    };
    const type = event.meta?.event_name || headers.get('x-event-name') || 'unknown';
    const custom = event.meta?.custom_data || {};
    const attributes = event.data?.attributes || {};
    const providerOrderId = String(event.data?.id ?? '');

    if (type === 'order_created') {
      // `refunded` on a freshly created order means it was refunded before this
      // delivery arrived (retries can be hours late). Honouring the flag here
      // avoids granting access we would revoke a moment later.
      if (attributes.refunded === true) {
        return { kind: 'refunded', provider: 'lemonsqueezy', providerOrderId };
      }
      return {
        kind: 'paid',
        provider: 'lemonsqueezy',
        providerOrderId,
        // Deliberately absent: an `order_created` payload carries no checkout id,
        // and the order-item id that looks like one would match no pending row.
        // Our own `reference` in custom_data is what ties this back to the attempt.
        email: attributes.user_email,
        amountCents: typeof attributes.total === 'number' ? attributes.total : undefined,
        currency: attributes.currency,
        reportId: custom.reportId,
        userId: custom.userId,
        reference: custom.reference,
      };
    }

    if (type === 'order_refunded') {
      return { kind: 'refunded', provider: 'lemonsqueezy', providerOrderId };
    }

    return { kind: 'ignored', provider: 'lemonsqueezy', type };
  },
};
