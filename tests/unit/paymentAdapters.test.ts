import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { creem } from '../../src/lib/payments/creem';
import { lemonsqueezy } from '../../src/lib/payments/lemonsqueezy';
import { SignatureError } from '../../src/lib/payments/types';
import { availableAdapters, createCheckout, paymentsEnabled, priceCents, priceLabel } from '../../src/lib/payments';

const CREEM_SECRET = 'creem-webhook-secret';
const LS_SECRET = 'lemonsqueezy-webhook-secret';

const PAYMENT_ENV = [
  'CREEM_API_KEY',
  'CREEM_PRODUCT_ID',
  'CREEM_WEBHOOK_SECRET',
  'CREEM_TEST_MODE',
  'LEMONSQUEEZY_API_KEY',
  'LEMONSQUEEZY_STORE_ID',
  'LEMONSQUEEZY_VARIANT_ID',
  'LEMONSQUEEZY_WEBHOOK_SECRET',
  'PAYMENT_PROVIDER_ORDER',
  'PAYMENT_PRICE_CENTS',
] as const;

let saved: Record<string, string | undefined> = {};

function configureBoth(): void {
  process.env.CREEM_API_KEY = 'creem-key';
  process.env.CREEM_PRODUCT_ID = 'prod_1';
  process.env.CREEM_WEBHOOK_SECRET = CREEM_SECRET;
  process.env.LEMONSQUEEZY_API_KEY = 'ls-key';
  process.env.LEMONSQUEEZY_STORE_ID = '1';
  process.env.LEMONSQUEEZY_VARIANT_ID = '2';
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = LS_SECRET;
}

function signed(body: string, secret: string, header: string): Headers {
  return new Headers({ [header]: createHmac('sha256', secret).update(body).digest('hex') });
}

beforeEach(() => {
  saved = {};
  for (const key of PAYMENT_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PAYMENT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider selection', () => {
  it('offers nothing when nothing is configured, so no buy button appears', () => {
    expect(availableAdapters()).toEqual([]);
    expect(paymentsEnabled()).toBe(false);
  });

  it('will not sell through a provider whose webhook cannot be verified', () => {
    // Taking money we cannot prove arrived is the one failure with no recovery,
    // so a missing signing secret disables the provider entirely.
    process.env.CREEM_API_KEY = 'creem-key';
    process.env.CREEM_PRODUCT_ID = 'prod_1';
    expect(availableAdapters()).toEqual([]);
    process.env.CREEM_WEBHOOK_SECRET = CREEM_SECRET;
    expect(availableAdapters().map((a) => a.provider)).toEqual(['creem']);
  });

  it('honours PAYMENT_PROVIDER_ORDER', () => {
    configureBoth();
    process.env.PAYMENT_PROVIDER_ORDER = 'lemonsqueezy,creem';
    expect(availableAdapters().map((a) => a.provider)).toEqual(['lemonsqueezy', 'creem']);
  });

  it('keeps a configured provider that the order variable forgot to name', () => {
    configureBoth();
    process.env.PAYMENT_PROVIDER_ORDER = 'creem';
    expect(availableAdapters().map((a) => a.provider)).toEqual(['creem', 'lemonsqueezy']);
  });

  it('advertises a price of at least one dollar', () => {
    expect(priceCents()).toBe(100);
    expect(priceLabel()).toBe('$1');
    process.env.PAYMENT_PRICE_CENTS = '199';
    expect(priceLabel()).toBe('$1.99');
    // Nonsense and giveaway prices fall back rather than being honoured.
    process.env.PAYMENT_PRICE_CENTS = '1';
    expect(priceCents()).toBe(100);
    process.env.PAYMENT_PRICE_CENTS = 'free';
    expect(priceCents()).toBe(100);
  });
});

describe('checkout fallback', () => {
  const request = {
    reportId: 'report-1',
    email: 'buyer@example.com',
    locale: 'en' as const,
    successUrl: 'https://ioni.top/bp/report-1?purchase=ref-1',
    reference: 'ref-1',
  };

  it('falls through to the second provider and still reports the first failure', async () => {
    // The point of the assertion: a working fallback must not hide a broken
    // primary, or Creem could be down for a week while revenue looks normal.
    configureBoth();
    vi.spyOn(creem, 'createCheckout').mockRejectedValue(new Error('creem 500'));
    vi.spyOn(lemonsqueezy, 'createCheckout').mockResolvedValue({
      provider: 'lemonsqueezy',
      checkoutId: 'ls-1',
      url: 'https://store.lemonsqueezy.com/checkout/ls-1',
    });

    const outcome = await createCheckout(request);
    expect(outcome.session?.provider).toBe('lemonsqueezy');
    expect(outcome.failures).toEqual([{ provider: 'creem', error: 'creem 500' }]);
  });

  it('reports every failure when no provider can take the money', async () => {
    configureBoth();
    vi.spyOn(creem, 'createCheckout').mockRejectedValue(new Error('creem down'));
    vi.spyOn(lemonsqueezy, 'createCheckout').mockRejectedValue(new Error('ls down'));

    const outcome = await createCheckout(request);
    expect(outcome.session).toBeNull();
    expect(outcome.failures.map((f) => f.provider)).toEqual(['creem', 'lemonsqueezy']);
  });
});

describe('creem adapter', () => {
  beforeEach(configureBoth);

  it('never sends a price: the amount lives on the provider product', async () => {
    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = String(init.body);
        return new Response(JSON.stringify({ id: 'ch_1', checkout_url: 'https://creem.io/c/ch_1' }), {
          status: 200,
        });
      })
    );

    const session = await creem.createCheckout({
      reportId: 'report-1',
      email: 'buyer@example.com',
      locale: 'zh',
      successUrl: 'https://ioni.top/bp/report-1?purchase=ref-1',
      reference: 'ref-1',
    });

    expect(session).toEqual({ provider: 'creem', checkoutId: 'ch_1', url: 'https://creem.io/c/ch_1' });
    const body = JSON.parse(sentBody);
    expect(body.product_id).toBe('prod_1');
    expect(body.metadata).toMatchObject({ reportId: 'report-1', reference: 'ref-1', locale: 'zh' });
    expect(sentBody).not.toMatch(/custom_price|amount/);
  });

  it('surfaces an HTTP failure instead of returning a session with no URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(
      creem.createCheckout({
        reportId: 'r',
        locale: 'en',
        successUrl: 'https://ioni.top/',
        reference: 'ref',
      })
    ).rejects.toThrow(/403/);
  });

  it('translates a verified checkout.completed into a paid event', () => {
    const body = JSON.stringify({
      eventType: 'checkout.completed',
      object: {
        id: 'ch_1',
        request_id: 'ref-1',
        customer: { email: 'buyer@example.com' },
        order: { id: 'ord_1', amount_paid: 100, currency: 'USD' },
        metadata: { reportId: 'report-1', reference: 'ref-1', userId: 'user-1' },
      },
    });
    const event = creem.parseWebhook(body, signed(body, CREEM_SECRET, 'creem-signature'));
    expect(event).toEqual({
      kind: 'paid',
      provider: 'creem',
      providerOrderId: 'ord_1',
      checkoutId: 'ch_1',
      email: 'buyer@example.com',
      amountCents: 100,
      currency: 'USD',
      reportId: 'report-1',
      userId: 'user-1',
      reference: 'ref-1',
    });
  });

  it('rejects a bad signature, a missing header and an unconfigured secret', () => {
    const body = JSON.stringify({ eventType: 'checkout.completed', object: {} });
    expect(() => creem.parseWebhook(body, new Headers({ 'creem-signature': 'deadbeef' }))).toThrow(SignatureError);
    expect(() => creem.parseWebhook(body, new Headers())).toThrow(SignatureError);
    delete process.env.CREEM_WEBHOOK_SECRET;
    expect(() => creem.parseWebhook(body, signed(body, CREEM_SECRET, 'creem-signature'))).toThrow(SignatureError);
  });

  it('rejects a signature computed over different bytes', () => {
    // Guards the rule that verification uses the raw body: re-serialising the
    // JSON would change the bytes and break this.
    const body = JSON.stringify({ eventType: 'checkout.completed', object: { id: 'ch_1' } });
    const headers = signed(`${body} `, CREEM_SECRET, 'creem-signature');
    expect(() => creem.parseWebhook(body, headers)).toThrow(SignatureError);
  });

  it('revokes on both refunds and disputes', () => {
    const refund = JSON.stringify({
      eventType: 'refund.created',
      object: { transaction: { order: 'ord_1' } },
    });
    expect(creem.parseWebhook(refund, signed(refund, CREEM_SECRET, 'creem-signature'))).toEqual({
      kind: 'refunded',
      provider: 'creem',
      providerOrderId: 'ord_1',
      checkoutId: undefined,
    });

    const dispute = JSON.stringify({ eventType: 'dispute.created', object: { order: { id: 'ord_2' } } });
    expect(creem.parseWebhook(dispute, signed(dispute, CREEM_SECRET, 'creem-signature'))).toMatchObject({
      kind: 'refunded',
      providerOrderId: 'ord_2',
    });
  });

  it('ignores verified events about things this site does not sell', () => {
    const body = JSON.stringify({ eventType: 'subscription.paid', object: {} });
    expect(creem.parseWebhook(body, signed(body, CREEM_SECRET, 'creem-signature'))).toEqual({
      kind: 'ignored',
      provider: 'creem',
      type: 'subscription.paid',
    });
  });
});

describe('lemon squeezy adapter', () => {
  beforeEach(configureBoth);

  it('sends a JSON:API checkout carrying our metadata', async () => {
    let sentBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = String(init.body);
        return new Response(
          JSON.stringify({ data: { id: 'ls_1', attributes: { url: 'https://store.lemonsqueezy.com/c/ls_1' } } }),
          { status: 201 }
        );
      })
    );

    const session = await lemonsqueezy.createCheckout({
      reportId: 'report-1',
      email: 'buyer@example.com',
      userId: 'user-1',
      locale: 'en',
      successUrl: 'https://ioni.top/bp/report-1?purchase=ref-1',
      reference: 'ref-1',
    });

    expect(session.provider).toBe('lemonsqueezy');
    expect(session.url).toContain('lemonsqueezy.com');
    const body = JSON.parse(sentBody);
    expect(body.data.attributes.checkout_data.custom).toMatchObject({
      reportId: 'report-1',
      reference: 'ref-1',
      userId: 'user-1',
    });
    expect(body.data.relationships.variant.data.id).toBe('2');
  });

  it('translates a verified order_created into a paid event', () => {
    const body = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { reportId: 'report-1', reference: 'ref-1' } },
      data: {
        id: '42',
        attributes: { user_email: 'buyer@example.com', total: 100, currency: 'USD', refunded: false },
      },
    });
    expect(lemonsqueezy.parseWebhook(body, signed(body, LS_SECRET, 'x-signature'))).toMatchObject({
      kind: 'paid',
      providerOrderId: '42',
      email: 'buyer@example.com',
      amountCents: 100,
      reportId: 'report-1',
      reference: 'ref-1',
    });
  });

  it('treats an already-refunded order as a refund, not a grant', () => {
    // Deliveries can be hours late; granting access we would revoke moments
    // later is worse than never granting it.
    const body = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { id: '43', attributes: { refunded: true } },
    });
    expect(lemonsqueezy.parseWebhook(body, signed(body, LS_SECRET, 'x-signature'))).toEqual({
      kind: 'refunded',
      provider: 'lemonsqueezy',
      providerOrderId: '43',
    });
  });

  it('revokes on order_refunded and rejects a forged signature', () => {
    const body = JSON.stringify({ meta: { event_name: 'order_refunded' }, data: { id: '44' } });
    expect(lemonsqueezy.parseWebhook(body, signed(body, LS_SECRET, 'x-signature'))).toEqual({
      kind: 'refunded',
      provider: 'lemonsqueezy',
      providerOrderId: '44',
    });
    expect(() => lemonsqueezy.parseWebhook(body, signed(body, 'wrong', 'x-signature'))).toThrow(SignatureError);
  });
});
