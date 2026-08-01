/**
 * Where payment failures go.
 *
 * Two sinks, on purpose. The blob error log takes everything: it needs no
 * database, so it still records the failure during the outage that probably
 * caused it. The `ops_alerts` table takes the subset an operator must not miss —
 * a rejected webhook signature, a checkout that could not be created, a download
 * that failed after payment — because those are the failures that cost money or
 * trust rather than a page view.
 *
 * WHY THE ESCALATION IS GUARDED
 * Anyone on the internet can POST rubbish to a webhook URL. If every bogus
 * signature wrote a row, a trivial script could keep Neon's compute awake all
 * month and burn the free tier — turning an observability feature into the outage
 * it is meant to report. So a row is written only when the database is already
 * up, and at most once per minute per kind of failure. The blob log keeps the
 * full detail either way, so nothing is actually lost by throttling.
 */
import { isDbDown } from '../db/client';
import { recordError } from '../observability/errorLog';
import { recordOpsAlert } from '../observability/opsAlerts';

export type PaymentAlertKind =
  /** Webhook arrived with a signature we could not verify. */
  | 'webhook_signature'
  /** Webhook verified, but the event could not be recorded anywhere. */
  | 'webhook_unrecorded'
  /** Webhook verified and safe in Blobs, waiting for Postgres to come back. */
  | 'webhook_buffered'
  /** A refund arrived for an order we hold no row for, so nothing was revoked. */
  | 'refund_unmatched'
  /** No provider could open a checkout session. */
  | 'checkout_failed'
  /** Buyer paid but the PDF could not be produced or sent. */
  | 'download_failed'
  /** The buffered-webhook drain could not finish. */
  | 'drain_failed'
  /** The daily canary could not reach a provider. */
  | 'canary_failed';

/**
 * Kinds that unauthenticated traffic can provoke. Only these are throttled and
 * suppressed while the database is down; the rest all require a verified payment
 * or an internal job, so there is no one to abuse them and every occurrence is
 * worth a row.
 */
const ATTACKER_TRIGGERABLE: ReadonlySet<PaymentAlertKind> = new Set(['webhook_signature']);

const ESCALATION_INTERVAL_MS = 60_000;
const lastEscalatedAt = new Map<PaymentAlertKind, number>();

/** Test seam: the throttle is process-global state. */
export function resetPaymentAlertThrottle(): void {
  lastEscalatedAt.clear();
}

function shouldEscalate(kind: PaymentAlertKind, now: number): boolean {
  if (!ATTACKER_TRIGGERABLE.has(kind)) return true;
  if (isDbDown()) return false;
  const previous = lastEscalatedAt.get(kind) ?? 0;
  if (now - previous < ESCALATION_INTERVAL_MS) return false;
  lastEscalatedAt.set(kind, now);
  return true;
}

/**
 * Record a payment failure. Never throws and never rejects: called from webhook
 * and download handlers where the response matters more than the logging.
 */
export async function paymentAlert(
  kind: PaymentAlertKind,
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  recordError('payments', `${kind}: ${message}`, { context: { kind, ...context } });
  if (!shouldEscalate(kind, Date.now())) return;
  try {
    await recordOpsAlert('payments', `${kind}: ${message}`, { kind, ...context });
  } catch {
    // The blob log already has it; an alert about a failed alert is noise.
  }
}

/** Fire-and-forget form for handlers that must not await anything. */
export function paymentAlertSync(
  kind: PaymentAlertKind,
  message: string,
  context: Record<string, unknown> = {}
): void {
  void paymentAlert(kind, message, context);
}
