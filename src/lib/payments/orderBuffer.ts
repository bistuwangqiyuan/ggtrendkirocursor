/**
 * Payments that arrived while Postgres was unavailable.
 *
 * WHY THIS EXISTS
 * Neon on the free plan is periodically unreachable — that is the premise the
 * whole write pipeline is built around (see services/trendIntake.ts). Everywhere
 * else an outage means late data. Here it would mean a buyer who paid and got
 * nothing, which is the one failure this site must not have.
 *
 * A webhook is only buffered after its signature has been verified, so a buffered
 * event is proof of payment in its own right, independent of the database. That
 * is what lets the success page hand over the download during an outage instead
 * of asking the customer to come back later: the entitlement comes from the
 * provider's signed statement, and Postgres is merely where it will be recorded.
 *
 * Buffered events are replayed by the drain job. They are deliberately NOT given
 * a TTL: an unpaid-for expiry would delete the only record of someone's purchase.
 * A stuck event should be found and fixed, and the ops alert says so.
 */
import { deleteSnapshot, listSnapshotKeys, readSnapshot, writeSnapshot } from '../cache/snapshot';
import type { PaymentEvent } from './types';

const PREFIX = 'orders/pending/';

export interface BufferedPaymentEvent {
  event: PaymentEvent;
  receivedAt: string;
}

export interface BufferedRef {
  key: string;
  entry: BufferedPaymentEvent;
}

/** Blob keys allow a limited character set; provider ids are opaque strings. */
function safeKey(providerOrderId: string): string {
  return providerOrderId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown';
}

/**
 * Park a verified event. Keyed by provider order id so a provider's retries
 * overwrite rather than accumulate — the same idempotency the database column
 * gives us, applied to the queue.
 */
export async function bufferPaymentEvent(
  event: PaymentEvent,
  receivedAt: Date = new Date()
): Promise<string | null> {
  if (event.kind === 'ignored') return null;
  const key = `${PREFIX}${event.provider}-${safeKey(event.providerOrderId)}`;
  const written = await writeSnapshot<BufferedPaymentEvent>(key, {
    event,
    receivedAt: receivedAt.toISOString(),
  });
  return written ? key : null;
}

export async function listBufferedPaymentEvents(): Promise<BufferedRef[]> {
  const refs: BufferedRef[] = [];
  for (const key of (await listSnapshotKeys(PREFIX)).sort()) {
    const snap = await readSnapshot<BufferedPaymentEvent>(key);
    if (!snap?.data?.event) continue;
    refs.push({ key, entry: snap.data });
  }
  return refs;
}

/**
 * A buffered payment for this report and buyer, if there is one.
 *
 * Used by the status endpoint during an outage: with no `orders` row to read, the
 * signed webhook is the entitlement. Refund events buffered for the same order
 * win, so a refunded purchase does not become downloadable just because the
 * database is down.
 */
export async function bufferedEntitlement(
  reportId: string,
  identifiers: { email?: string | null; reference?: string | null }
): Promise<{ providerOrderId: string; provider: string; email?: string } | null> {
  const email = identifiers.email?.trim().toLowerCase() || null;
  const reference = identifiers.reference?.trim() || null;
  const refs = await listBufferedPaymentEvents();

  const refunded = new Set(
    refs.filter((r) => r.entry.event.kind === 'refunded').map((r) => r.entry.event.providerOrderId)
  );

  for (const { entry } of refs) {
    const event = entry.event;
    if (event.kind !== 'paid') continue;
    if (refunded.has(event.providerOrderId)) continue;
    if (event.reportId !== reportId) continue;
    const matchesEmail = !!email && event.email?.trim().toLowerCase() === email;
    const matchesReference = !!reference && event.reference === reference;
    if (!matchesEmail && !matchesReference) continue;
    return { providerOrderId: event.providerOrderId, provider: event.provider, email: event.email };
  }
  return null;
}

export interface BufferDrainSummary {
  applied: number;
  remaining: number;
  errors: string[];
}

/**
 * Replay buffered events into Postgres, oldest first.
 *
 * Stops at the first failure: if the database refused one event it will refuse
 * the rest, and the entries stay in the buffer so nothing is lost by giving up
 * early.
 */
export async function drainBufferedPaymentEvents(
  apply: (event: PaymentEvent, receivedAt: Date) => Promise<void>
): Promise<BufferDrainSummary> {
  const summary: BufferDrainSummary = { applied: 0, remaining: 0, errors: [] };
  const refs = await listBufferedPaymentEvents();

  for (let i = 0; i < refs.length; i++) {
    const { key, entry } = refs[i];
    try {
      await apply(entry.event, new Date(entry.receivedAt));
      await deleteSnapshot(key);
      summary.applied++;
    } catch (error) {
      summary.errors.push(`${key}: ${(error as Error).message}`);
      summary.remaining = refs.length - i;
      return summary;
    }
  }
  return summary;
}

/** Backlog for the recovery job and the ops dashboard, without a DB touch. */
export async function bufferedPaymentBacklog(): Promise<{ events: number; oldestReceivedAt: string | null }> {
  const refs = await listBufferedPaymentEvents();
  const oldest = refs
    .map((r) => r.entry.receivedAt)
    .sort()
    .at(0);
  return { events: refs.length, oldestReceivedAt: oldest ?? null };
}
