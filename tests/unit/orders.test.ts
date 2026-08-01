import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PaymentEvent } from '../../src/lib/payments/types';

const query = vi.fn();
const isDbDown = vi.fn(() => false);

// orders.ts routes every statement through `query` (as dbQuery) and translates
// outages into OrdersUnavailableError. queryOne is no longer imported.
vi.mock('../../src/lib/db/client', () => ({ query, isDbDown }));

const {
  applyPaymentEvent,
  attachOrdersToUser,
  createPendingOrder,
  findEntitlement,
  listPurchases,
  MAX_DOWNLOADS_PER_ORDER,
  noteDownload,
  OrdersUnavailableError,
  revenueSummary,
} = await import('../../src/lib/services/orders');

/** A row shaped like the `orders` SELECT list. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    provider: 'creem',
    provider_order_id: 'ord_1',
    provider_checkout_id: 'ch_1',
    reference: 'ref-1',
    product: 'bp_pdf',
    report_id: 'report-1',
    email: 'buyer@example.com',
    user_id: null,
    amount_cents: 100,
    currency: 'USD',
    status: 'paid',
    download_count: 0,
    last_downloaded_at: null,
    paid_at: new Date('2026-08-01T00:00:00Z'),
    refunded_at: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function sql(): string[] {
  return query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
}

const paidEvent: PaymentEvent = {
  kind: 'paid',
  provider: 'creem',
  providerOrderId: 'ord_1',
  checkoutId: 'ch_1',
  email: 'Buyer@Example.com',
  amountCents: 100,
  currency: 'USD',
  reportId: 'report-1',
  reference: 'ref-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  isDbDown.mockReturnValue(false);
  query.mockResolvedValue([]);
});

describe('outage behaviour', () => {
  it('throws rather than reporting "no purchase found" when the database is down', async () => {
    // The distinction this suite exists for: everywhere else an outage may look
    // like empty data, but here "no order" and "cannot tell" lead to opposite
    // actions — refusing a paying customer, or handing a file to a stranger.
    isDbDown.mockReturnValue(true);
    await expect(findEntitlement('report-1', { email: 'buyer@example.com' })).rejects.toBeInstanceOf(
      OrdersUnavailableError
    );
    await expect(noteDownload('order-1')).rejects.toBeInstanceOf(OrdersUnavailableError);
    await expect(listPurchases({ email: 'buyer@example.com' })).rejects.toBeInstanceOf(OrdersUnavailableError);
    await expect(attachOrdersToUser('buyer@example.com', 'user-1')).rejects.toBeInstanceOf(OrdersUnavailableError);
    expect(query).not.toHaveBeenCalled();
  });

  it('translates a connection failure into OrdersUnavailableError, not a 500', async () => {
    // The breaker only short-circuits AFTER a failure. The first request into an
    // outage gets the driver's own error; without this translation the orders
    // page 500s instead of showing its degraded notice.
    query.mockRejectedValue(new Error('ECONNREFUSED 192.0.2.1:5432'));
    await expect(listPurchases({ email: 'buyer@example.com' })).rejects.toBeInstanceOf(OrdersUnavailableError);
  });
});

describe('applyPaymentEvent', () => {
  it('adopts the pending row from the same checkout instead of inserting a second order', async () => {
    query.mockResolvedValueOnce([row()]);
    const order = await applyPaymentEvent(paidEvent);
    expect(order?.id).toBe('order-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql()[0]).toMatch(/UPDATE orders .* WHERE provider = \$8 AND provider_checkout_id = \$9/);
  });

  it('lower-cases the buyer email so lookup by email is reliable', async () => {
    query.mockResolvedValueOnce([row()]);
    await applyPaymentEvent(paidEvent);
    expect(query.mock.calls[0][1]).toContain('buyer@example.com');
  });

  it('adopts the pending row by our own reference when the provider sends no checkout id', async () => {
    // Lemon Squeezy's order_created payload has no checkout id. Without this path
    // every sale through the fallback provider would abandon its pending row and
    // insert a second one.
    query.mockResolvedValueOnce([row({ provider: 'lemonsqueezy', provider_checkout_id: null })]);
    const order = await applyPaymentEvent({ ...paidEvent, provider: 'lemonsqueezy', checkoutId: undefined });
    expect(order?.id).toBe('order-1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql()[0]).toMatch(/UPDATE orders .* WHERE provider = \$8 AND reference = \$9/);
  });

  it('falls back to an idempotent upsert when there is no pending row to adopt', async () => {
    // Neither the checkout id nor the reference found a row.
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    await applyPaymentEvent(paidEvent);
    expect(sql()[2]).toMatch(/INSERT INTO orders .* ON CONFLICT \(provider_order_id\) DO UPDATE/);
  });

  it('never downgrades a refunded order back to paid on a retried delivery', async () => {
    // Providers retry for days. A late `paid` delivery arriving after a refund
    // must not reopen the download.
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row({ status: 'refunded' })]);
    const order = await applyPaymentEvent(paidEvent);
    expect(order?.status).toBe('refunded');
    expect(sql()[2]).toMatch(/status = CASE WHEN orders\.status = 'refunded' THEN 'refunded' ELSE 'paid' END/);
  });

  it('treats a payment that produced no row as an error, so the caller buffers it', async () => {
    // Returning null here would let the webhook answer 200 and erase a purchase.
    query.mockResolvedValue([]);
    await expect(applyPaymentEvent(paidEvent)).rejects.toThrow(/produced no order row/);
  });

  it('creates the table and retries once when it does not exist yet', async () => {
    // The maintenance pass creates the table every three hours, but the first
    // purchase must not be the thing that waits for it.
    let firstAttempt = true;
    query.mockImplementation(async (text: string) => {
      if (/UPDATE orders/.test(text) && firstAttempt) {
        firstAttempt = false;
        throw new Error('relation "orders" does not exist');
      }
      return /INSERT INTO orders/.test(text) ? [row()] : [];
    });

    const order = await applyPaymentEvent(paidEvent);
    expect(order?.id).toBe('order-1');
    expect(sql().some((s) => s.includes('CREATE TABLE IF NOT EXISTS orders'))).toBe(true);
  });

  it('does not swallow other errors behind a table-creation retry', async () => {
    // A syntax error is a bug, not an outage — it must stay recognisable.
    query.mockRejectedValue(new Error('syntax error at or near "ORDERS"'));
    await expect(applyPaymentEvent(paidEvent)).rejects.toThrow(/syntax error/);
    expect(sql().some((s) => s.includes('CREATE TABLE'))).toBe(false);
  });

  it('records a refund against the provider order id', async () => {
    query.mockResolvedValueOnce([row({ status: 'refunded', refunded_at: new Date() })]);
    const order = await applyPaymentEvent({
      kind: 'refunded',
      provider: 'creem',
      providerOrderId: 'ord_1',
    });
    expect(order?.status).toBe('refunded');
    expect(sql()[0]).toMatch(/SET status = 'refunded'/);
  });

  it('does nothing for an ignored event', async () => {
    const order = await applyPaymentEvent({ kind: 'ignored', provider: 'creem', type: 'subscription.paid' });
    expect(order).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('createPendingOrder', () => {
  it('stores the attempt with the report, buyer and account it belongs to', async () => {
    query.mockResolvedValueOnce([row({ status: 'pending' })]);
    const order = await createPendingOrder({
      provider: 'creem',
      checkoutId: 'ch_1',
      reference: 'ref-1',
      reportId: 'report-1',
      email: 'Buyer@Example.com',
      userId: 'user-1',
      amountCents: 100,
    });
    expect(order?.status).toBe('pending');
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['creem', 'ch_1', 'ref-1', 'report-1', 'buyer@example.com', 'user-1', 100, 'USD']);
  });
});

describe('entitlement', () => {
  it('accepts either the account or the email, and only paid orders', async () => {
    query.mockResolvedValueOnce([row()]);
    const order = await findEntitlement('report-1', { userId: 'user-1', email: 'BUYER@example.com' });
    expect(order?.status).toBe('paid');
    expect(sql()[0]).toContain("status = 'paid'");
    expect(query.mock.calls[0][1]).toEqual(['report-1', 'buyer@example.com', 'user-1']);
  });

  it('does not query at all without an identity', async () => {
    expect(await findEntitlement('report-1', {})).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('download counting', () => {
  it('checks and increments in one statement so parallel clicks cannot both pass', async () => {
    query.mockResolvedValueOnce([{ download_count: 3 }]);
    expect(await noteDownload('order-1')).toEqual({ allowed: true, count: 3 });
    expect(sql()[0]).toMatch(/UPDATE orders SET download_count = download_count \+ 1/);
    expect(query.mock.calls[0][1]).toEqual(['order-1', MAX_DOWNLOADS_PER_ORDER]);
  });

  it('reports the current count when the cap is reached', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ download_count: 20, status: 'paid' }]);
    expect(await noteDownload('order-1')).toEqual({ allowed: false, count: 20 });
  });
});

describe('claiming and listing', () => {
  it('only attaches orders that belong to nobody yet', async () => {
    // Matching on a bare email is a data leak dressed as a convenience:
    // registration emails here are unverified.
    query.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await attachOrdersToUser('Buyer@Example.com', 'user-1')).toBe(2);
    expect(sql()[0]).toContain('user_id IS NULL');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'buyer@example.com']);
  });

  it('lists by account OR email so a claimed guest order still shows once', async () => {
    query.mockResolvedValueOnce([{ ...row(), report_title: 'Title', report_keyword: 'keyword' }]);
    const purchases = await listPurchases({ userId: 'user-1', email: 'buyer@example.com' });
    expect(purchases[0].reportTitle).toBe('Title');
    expect(sql()[0]).toContain('LEFT JOIN bp_reports');
    expect(sql()[0]).toContain("o.status <> 'pending'");
  });

  it('returns nothing, and asks nothing, for an anonymous visitor', async () => {
    expect(await listPurchases({})).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('revenueSummary', () => {
  it('reports net separately from gross so refunds are not hidden', async () => {
    query
      .mockResolvedValueOnce([
        {
          paid_orders: '10',
          refunded_orders: '2',
          gross_cents: '1000',
          refunded_cents: '200',
          last7: '300',
          last30: '900',
          downloads: '17',
          first_paid_at: new Date('2026-08-01T00:00:00Z'),
          last_paid_at: new Date('2026-08-05T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([{ day: '2026-08-05', orders: '1', cents: '100' }]);

    const summary = await revenueSummary(30);
    expect(summary).toMatchObject({
      paidOrders: 10,
      refundedOrders: 2,
      grossCents: 1000,
      refundedCents: 200,
      netCents: 800,
      downloads: 17,
      currency: 'USD',
    });
    expect(summary.daily).toEqual([{ day: '2026-08-05', orders: 1, cents: 100 }]);
    expect(summary.firstPaidAt).toBe('2026-08-01T00:00:00.000Z');
  });
});
