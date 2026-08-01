import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSnapshotStore } from '../../src/lib/cache/snapshot';
import {
  bufferPaymentEvent,
  bufferedEntitlement,
  bufferedPaymentBacklog,
  drainBufferedPaymentEvents,
  listBufferedPaymentEvents,
} from '../../src/lib/payments/orderBuffer';
import type { PaymentEvent } from '../../src/lib/payments/types';

let dir: string;

const paid: PaymentEvent = {
  kind: 'paid',
  provider: 'creem',
  providerOrderId: 'ord_1',
  email: 'Buyer@Example.com',
  reportId: 'report-1',
  reference: 'ref-1',
  amountCents: 100,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orderbuf-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

describe('buffering', () => {
  it('keeps a verified event and reports the backlog', async () => {
    expect(await bufferPaymentEvent(paid)).toContain('orders/pending/creem-ord_1');
    const backlog = await bufferedPaymentBacklog();
    expect(backlog.events).toBe(1);
    expect(backlog.oldestReceivedAt).toBeTruthy();
  });

  it('collapses a provider’s retries onto one entry', async () => {
    await bufferPaymentEvent(paid);
    await bufferPaymentEvent(paid);
    expect((await listBufferedPaymentEvents()).length).toBe(1);
  });

  it('sanitises provider ids into usable blob keys', async () => {
    const key = await bufferPaymentEvent({ ...paid, providerOrderId: 'ord/1 #weird' });
    expect(key).toBe('orders/pending/creem-ord_1__weird');
  });

  it('ignores events that mean nothing to us', async () => {
    expect(await bufferPaymentEvent({ kind: 'ignored', provider: 'creem', type: 'x' })).toBeNull();
  });
});

describe('bufferedEntitlement', () => {
  it('honours the purchase reference, which is all a guest has during an outage', async () => {
    await bufferPaymentEvent(paid);
    const entitlement = await bufferedEntitlement('report-1', { reference: 'ref-1' });
    expect(entitlement?.providerOrderId).toBe('ord_1');
  });

  it('honours the buyer email case-insensitively', async () => {
    await bufferPaymentEvent(paid);
    expect(await bufferedEntitlement('report-1', { email: 'buyer@example.com' })).not.toBeNull();
  });

  it('will not unlock a different report', async () => {
    await bufferPaymentEvent(paid);
    expect(await bufferedEntitlement('report-2', { reference: 'ref-1' })).toBeNull();
  });

  it('requires some identifier, so a stranger cannot claim a buffered payment', async () => {
    await bufferPaymentEvent(paid);
    expect(await bufferedEntitlement('report-1', {})).toBeNull();
    expect(await bufferedEntitlement('report-1', { reference: 'wrong', email: 'other@example.com' })).toBeNull();
  });

  it('lets a buffered refund override a buffered payment', async () => {
    // Otherwise a refunded purchase would become downloadable again simply
    // because the database happened to be down.
    await bufferPaymentEvent(paid);
    await bufferPaymentEvent({ kind: 'refunded', provider: 'creem', providerOrderId: 'ord_1' });
    expect(await bufferedEntitlement('report-1', { reference: 'ref-1' })).toBeNull();
  });
});

describe('draining', () => {
  it('applies each event and removes it', async () => {
    await bufferPaymentEvent(paid);
    await bufferPaymentEvent({ ...paid, providerOrderId: 'ord_2', reference: 'ref-2' });

    const applied: string[] = [];
    const summary = await drainBufferedPaymentEvents(async (event) => {
      applied.push(event.kind === 'ignored' ? 'ignored' : event.providerOrderId);
    });

    expect(summary).toMatchObject({ applied: 2, remaining: 0, errors: [] });
    expect(applied.sort()).toEqual(['ord_1', 'ord_2']);
    expect(await listBufferedPaymentEvents()).toEqual([]);
  });

  it('stops at the first failure and keeps the rest buffered', async () => {
    await bufferPaymentEvent(paid);
    await bufferPaymentEvent({ ...paid, providerOrderId: 'ord_2' });

    const summary = await drainBufferedPaymentEvents(async () => {
      throw new Error('still down');
    });

    expect(summary.applied).toBe(0);
    expect(summary.remaining).toBe(2);
    expect(summary.errors[0]).toContain('still down');
    // Nothing was deleted: a payment must survive a failed drain.
    expect((await listBufferedPaymentEvents()).length).toBe(2);
  });
});
