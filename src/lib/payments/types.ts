/**
 * The vocabulary both payment providers are translated into.
 *
 * Creem and Lemon Squeezy have unrelated APIs — one flat JSON, one JSON:API —
 * and neither shape should reach the order table or the pages. Everything
 * provider-specific stops at the adapter that produces these types, so adding or
 * dropping a provider is one file plus one registry entry.
 */

export type PaymentProvider = 'creem' | 'lemonsqueezy';

export interface CheckoutRequest {
  /** The completed BP report whose PDF is being bought. */
  reportId: string;
  /**
   * Prefilled on the hosted checkout. Present for logged-in buyers from the
   * session and for guests from the buy panel; the provider's own field is still
   * authoritative afterwards, because the buyer may change it there.
   */
  email?: string;
  /** Set only for logged-in buyers, so the order is owned from the start. */
  userId?: string;
  locale: 'en' | 'zh';
  /** Absolute URL the provider returns the buyer to. */
  successUrl: string;
  /**
   * Our reference for this attempt, echoed back in the webhook. Lets a payment
   * be matched to the report even if the buyer's email changes at checkout.
   */
  reference: string;
}

export interface CheckoutSession {
  provider: PaymentProvider;
  /** The provider's id for the session, stored before any webhook arrives. */
  checkoutId: string;
  /** Where to send the buyer. */
  url: string;
}

/** What a verified webhook means, once the provider's wording is stripped away. */
export type PaymentEvent =
  | {
      kind: 'paid';
      provider: PaymentProvider;
      /** The provider's order id: the idempotency key for the whole flow. */
      providerOrderId: string;
      checkoutId?: string;
      email?: string;
      amountCents?: number;
      currency?: string;
      reportId?: string;
      userId?: string;
      reference?: string;
    }
  | {
      kind: 'refunded';
      provider: PaymentProvider;
      providerOrderId: string;
      checkoutId?: string;
    }
  /** Verified, but about something this site does not sell (e.g. subscriptions). */
  | { kind: 'ignored'; provider: PaymentProvider; type: string };

export interface PaymentAdapter {
  provider: PaymentProvider;
  /** False when the environment lacks the keys, so the caller can skip it. */
  configured(): boolean;
  /** True when webhooks from this provider can be verified. */
  webhookConfigured(): boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verify the signature over the RAW body, then translate. Throws
   * `SignatureError` when verification fails, so the endpoint can answer 401
   * without having parsed attacker-supplied JSON as if it were trusted.
   */
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent;
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}
