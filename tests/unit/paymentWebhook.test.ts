import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const applyPaymentEvent = vi.fn();
const bufferPaymentEvent = vi.fn();
const paymentAlert = vi.fn(async () => undefined);
const recordError = vi.fn();
const recordOpsAlert = vi.fn(async () => true);

vi.mock('../../src/lib/services/orders', () => ({ applyPaymentEvent }));
vi.mock('../../src/lib/payments/orderBuffer', () => ({ bufferPaymentEvent }));
vi.mock('../../src/lib/payments/alerts', () => ({ paymentAlert }));
vi.mock('../../src/lib/observability/errorLog', () => ({ recordError }));
vi.mock('../../src/lib/observability/opsAlerts', () => ({ recordOpsAlert }));

const { handlePaymentWebhook } = await import('../../src/lib/payments/webhook');

const SECRET = 'creem-webhook-secret';

function webhookRequest(body: string, signature?: string): Request {
  return new Request('https://ioni.top/api/pay/webhook/creem', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === undefined
        ? { 'creem-signature': createHmac('sha256', SECRET).update(body).digest('hex') }
        : { 'creem-signature': signature }),
    },
    body,
  });
}

const paidBody = JSON.stringify({
  eventType: 'checkout.completed',
  object: {
    id: 'ch_1',
    customer: { email: 'buyer@example.com' },
    order: { id: 'ord_1', amount_paid: 100, currency: 'USD' },
    metadata: { reportId: 'report-1', reference: 'ref-1' },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CREEM_WEBHOOK_SECRET = SECRET;
  applyPaymentEvent.mockResolvedValue({ id: 'order-1' });
  bufferPaymentEvent.mockResolvedValue('orders/pending/creem-ord_1');
});

describe('handlePaymentWebhook', () => {
  it('stores a verified payment and answers 200', async () => {
    const outcome = await handlePaymentWebhook('creem', webhookRequest(paidBody));
    expect(outcome.status).toBe(200);
    expect(outcome.disposition).toBe('stored');
    expect(applyPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paid', providerOrderId: 'ord_1', reportId: 'report-1' })
    );
    expect(bufferPaymentEvent).not.toHaveBeenCalled();
  });

  it('answers 401 to a forged signature and never reaches the order table', async () => {
    const outcome = await handlePaymentWebhook('creem', webhookRequest(paidBody, 'deadbeef'));
    expect(outcome.status).toBe(401);
    expect(outcome.disposition).toBe('rejected');
    expect(applyPaymentEvent).not.toHaveBeenCalled();
    expect(bufferPaymentEvent).not.toHaveBeenCalled();
    expect(paymentAlert).toHaveBeenCalledWith(
      'webhook_signature',
      expect.stringContaining('creem'),
      expect.any(Object)
    );
  });

  it('buffers to Blobs and still answers 200 when Postgres is unavailable', async () => {
    // The provider must not retry a payment we have safely recorded elsewhere,
    // and the buyer must not be told to come back later because of an outage.
    applyPaymentEvent.mockRejectedValue(new Error('db down'));
    const outcome = await handlePaymentWebhook('creem', webhookRequest(paidBody));
    expect(outcome.status).toBe(200);
    expect(outcome.disposition).toBe('buffered');
    expect(bufferPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paid', providerOrderId: 'ord_1' })
    );
    // Recorded through the throttled sink, which reaches Blobs during an outage;
    // a direct ops_alerts write would target the store that just failed.
    expect(paymentAlert).toHaveBeenCalledWith(
      'webhook_buffered',
      expect.stringContaining('ord_1'),
      expect.any(Object)
    );
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it('asks the provider to retry when no store accepted the event', async () => {
    // The only remaining copy of this payment is at the provider, so a 200 here
    // would erase it.
    applyPaymentEvent.mockRejectedValue(new Error('db down'));
    bufferPaymentEvent.mockResolvedValue(null);
    const outcome = await handlePaymentWebhook('creem', webhookRequest(paidBody));
    expect(outcome.status).toBe(503);
    expect(outcome.disposition).toBe('lost');
    expect(paymentAlert).toHaveBeenCalledWith(
      'webhook_unrecorded',
      expect.stringContaining('COULD NOT STORE'),
      expect.any(Object)
    );
  });

  it('acknowledges verified events about other products without storing them', async () => {
    const body = JSON.stringify({ eventType: 'subscription.paid', object: {} });
    const outcome = await handlePaymentWebhook('creem', webhookRequest(body));
    expect(outcome.status).toBe(200);
    expect(outcome.disposition).toBe('ignored');
    expect(applyPaymentEvent).not.toHaveBeenCalled();
  });

  it('does not ask for a retry of a signed but unparseable body', async () => {
    const outcome = await handlePaymentWebhook('creem', webhookRequest('{not json'));
    expect(outcome.status).toBe(400);
    expect(outcome.disposition).toBe('rejected');
    expect(recordError).toHaveBeenCalled();
  });

  it('answers 404 for an unknown provider path', async () => {
    const outcome = await handlePaymentWebhook('paypal' as 'creem', webhookRequest(paidBody));
    expect(outcome.status).toBe(404);
  });

  it('revokes access when a refund arrives', async () => {
    const body = JSON.stringify({ eventType: 'refund.created', object: { transaction: { order: 'ord_1' } } });
    const outcome = await handlePaymentWebhook('creem', webhookRequest(body));
    expect(outcome.status).toBe(200);
    expect(applyPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'refunded', providerOrderId: 'ord_1' })
    );
    expect(paymentAlert).not.toHaveBeenCalled();
  });

  it('raises an alert when a refund matches no order, since nothing was revoked', async () => {
    // Retrying would not help — there is no row to update — but staying quiet
    // would leave a refunded buyer holding a working download link.
    applyPaymentEvent.mockResolvedValue(null);
    const body = JSON.stringify({ eventType: 'refund.created', object: { transaction: { order: 'ord_unknown' } } });
    const outcome = await handlePaymentWebhook('creem', webhookRequest(body));
    expect(outcome.status).toBe(200);
    expect(outcome.disposition).toBe('stored');
    expect(paymentAlert).toHaveBeenCalledWith(
      'refund_unmatched',
      expect.stringContaining('ord_unknown'),
      expect.any(Object)
    );
  });

  it('does not treat a paid event that returned no row as a refund problem', async () => {
    applyPaymentEvent.mockResolvedValue(null);
    const outcome = await handlePaymentWebhook('creem', webhookRequest(paidBody));
    expect(outcome.status).toBe(200);
    expect(paymentAlert).not.toHaveBeenCalled();
  });
});
