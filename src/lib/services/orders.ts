/**
 * The order record: who may download what.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE REST OF THE DATA LAYER
 * Elsewhere in this codebase a database outage is allowed to look like an empty
 * result — a page with no trends is a degraded page, not a wrong one. Here it is
 * not acceptable: "no order found" and "cannot currently tell" lead to opposite
 * actions, and confusing them would either deny a paying customer their file or
 * hand it to someone who never paid. So every read here checks the breaker first
 * and throws `OrdersUnavailableError` rather than returning an empty list, and the
 * callers decide what to do about it (usually: fall back to the signed webhook in
 * the Blobs buffer).
 */
import { isDbDown, query, queryOne } from '../db/client';
import { ORDER_STATEMENTS } from '../db/schema';
import type { PaymentEvent, PaymentProvider } from '../payments/types';

export class OrdersUnavailableError extends Error {
  constructor() {
    super('Order store temporarily unavailable');
    this.name = 'OrdersUnavailableError';
  }
}

export type OrderStatus = 'pending' | 'paid' | 'refunded';

export interface Order {
  id: string;
  provider: PaymentProvider;
  providerOrderId: string | null;
  providerCheckoutId: string | null;
  /** Our reference for the attempt; the guest's proof of purchase on return. */
  reference: string | null;
  product: string;
  reportId: string | null;
  email: string | null;
  userId: string | null;
  amountCents: number | null;
  currency: string | null;
  status: OrderStatus;
  downloadCount: number;
  lastDownloadedAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
}

/**
 * How many times one purchase may be downloaded.
 *
 * Not DRM — the file is a PDF and the buyer can keep it. It is a bound on abuse:
 * a paid link posted publicly would otherwise let one dollar serve unlimited
 * server-side PDF renders. Generous enough that no honest buyer will meet it.
 */
export const MAX_DOWNLOADS_PER_ORDER = 20;

const COLUMNS = `
  id, provider, provider_order_id, provider_checkout_id, reference, product, report_id, email, user_id,
  amount_cents, currency, status, download_count, last_downloaded_at, paid_at, refunded_at, created_at
`;

interface OrderRow {
  id: string;
  provider: string;
  provider_order_id: string | null;
  provider_checkout_id: string | null;
  reference: string | null;
  product: string;
  report_id: string | null;
  email: string | null;
  user_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string;
  download_count: number;
  last_downloaded_at: Date | null;
  paid_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    provider: row.provider as PaymentProvider,
    providerOrderId: row.provider_order_id,
    providerCheckoutId: row.provider_checkout_id,
    reference: row.reference,
    product: row.product,
    reportId: row.report_id,
    email: row.email,
    userId: row.user_id,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    currency: row.currency,
    status: (['pending', 'paid', 'refunded'].includes(row.status) ? row.status : 'pending') as OrderStatus,
    downloadCount: Number(row.download_count ?? 0),
    lastDownloadedAt: row.last_downloaded_at,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    createdAt: row.created_at,
  };
}

/** Refuse to guess. See the file header for why this is not fail-soft. */
function assertAvailable(): void {
  if (isDbDown()) throw new OrdersUnavailableError();
}

/** Idempotent. Called by the maintenance pass and by the webhook's repair path. */
export async function ensureOrdersTable(): Promise<void> {
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  for (const statement of ORDER_STATEMENTS) {
    await query(statement);
  }
}

/**
 * Record an attempt before sending the buyer away.
 *
 * Worth a write on the checkout path because it is the only place the intent is
 * known: if the webhook later arrives with a changed email (buyers do retype
 * them at checkout), this row is what still ties the payment to the report and,
 * for logged-in buyers, to the account.
 */
export async function createPendingOrder(input: {
  provider: PaymentProvider;
  checkoutId: string;
  reference: string;
  reportId: string;
  email?: string | null;
  userId?: string | null;
  amountCents: number;
  currency?: string;
}): Promise<Order | null> {
  assertAvailable();
  const rows = await query<OrderRow>(
    `INSERT INTO orders
       (provider, provider_checkout_id, reference, product, report_id, email, user_id, amount_cents, currency, status)
     VALUES ($1, $2, $3, 'bp_pdf', $4::uuid, $5, $6::uuid, $7, $8, 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.provider,
      input.checkoutId,
      input.reference,
      input.reportId,
      input.email?.trim().toLowerCase() || null,
      input.userId || null,
      input.amountCents,
      input.currency || 'USD',
    ]
  );
  return rows[0] ? toOrder(rows[0]) : null;
}

/**
 * Apply a verified payment event. Safe to call any number of times with the same
 * event, which is the whole point: providers retry deliveries, and the buffered
 * copy of an event is replayed later as well.
 *
 * The pending row created at checkout is claimed by `provider_checkout_id` when
 * the provider gives us one, so a purchase produces one row rather than two.
 */
export async function applyPaymentEvent(event: PaymentEvent): Promise<Order | null> {
  try {
    return await applyPaymentEventOnce(event);
  } catch (error) {
    // The table is created by the maintenance pass, which runs every three hours
    // — but the first purchase must not be the thing that waits for it. Create it
    // and retry once; any other error is the caller's to handle (it buffers).
    if (!/relation .*orders.* does not exist/i.test((error as Error).message)) throw error;
    await ensureOrdersTable();
    return await applyPaymentEventOnce(event);
  }
}

async function applyPaymentEventOnce(event: PaymentEvent): Promise<Order | null> {
  if (event.kind === 'ignored') return null;
  assertAvailable();

  if (event.kind === 'refunded') {
    const rows = await query<OrderRow>(
      `UPDATE orders
          SET status = 'refunded', refunded_at = COALESCE(refunded_at, NOW()), updated_at = NOW()
        WHERE provider = $1 AND provider_order_id = $2
        RETURNING ${COLUMNS}`,
      [event.provider, event.providerOrderId]
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  const email = event.email?.trim().toLowerCase() || null;

  // Adopt the pending row from this attempt when there is one, so the buyer's
  // account link and report id survive even if the provider reports a different
  // email than was typed on our page.
  //
  // Two ways to recognise it, because the providers differ: Creem echoes the
  // checkout id, while a Lemon Squeezy `order_created` payload has none and is
  // matched by the `reference` we put in its custom data. Without the second
  // path every Lemon Squeezy sale would leave its pending row behind and insert
  // a fresh one.
  const claimBy: [column: string, value: string][] = [];
  if (event.checkoutId) claimBy.push(['provider_checkout_id', event.checkoutId]);
  if (event.reference) claimBy.push(['reference', event.reference]);

  for (const [column, value] of claimBy) {
    const claimed = await query<OrderRow>(
      `UPDATE orders
          SET provider_order_id = $1,
              status = CASE WHEN status = 'refunded' THEN 'refunded' ELSE 'paid' END,
              email = COALESCE($2, email),
              amount_cents = COALESCE($3, amount_cents),
              currency = COALESCE($4, currency),
              report_id = COALESCE(report_id, $5::uuid),
              user_id = COALESCE(user_id, $6::uuid),
              reference = COALESCE(reference, $7),
              paid_at = COALESCE(paid_at, NOW()),
              updated_at = NOW()
        WHERE provider = $8 AND ${column} = $9 AND provider_order_id IS DISTINCT FROM $1
        RETURNING ${COLUMNS}`,
      [
        event.providerOrderId,
        email,
        event.amountCents ?? null,
        event.currency ?? null,
        event.reportId ?? null,
        event.userId ?? null,
        event.reference ?? null,
        event.provider,
        value,
      ]
    );
    if (claimed[0]) return toOrder(claimed[0]);
  }

  // No pending row to adopt (a replayed event, or a checkout created while the
  // database was down): the unique provider_order_id makes this the idempotent
  // path — a retry updates the same row instead of inserting a second purchase.
  const rows = await query<OrderRow>(
    `INSERT INTO orders
       (provider, provider_order_id, provider_checkout_id, reference, product, report_id, email, user_id,
        amount_cents, currency, status, paid_at)
     VALUES ($1, $2, $3, $4, 'bp_pdf', $5::uuid, $6, $7::uuid, $8, $9, 'paid', NOW())
     ON CONFLICT (provider_order_id) DO UPDATE
        SET status = CASE WHEN orders.status = 'refunded' THEN 'refunded' ELSE 'paid' END,
            email = COALESCE(EXCLUDED.email, orders.email),
            report_id = COALESCE(orders.report_id, EXCLUDED.report_id),
            user_id = COALESCE(orders.user_id, EXCLUDED.user_id),
            reference = COALESCE(orders.reference, EXCLUDED.reference),
            amount_cents = COALESCE(orders.amount_cents, EXCLUDED.amount_cents),
            currency = COALESCE(orders.currency, EXCLUDED.currency),
            paid_at = COALESCE(orders.paid_at, EXCLUDED.paid_at),
            updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [
      event.provider,
      event.providerOrderId,
      event.checkoutId ?? null,
      event.reference ?? null,
      event.reportId ?? null,
      email,
      event.userId ?? null,
      event.amountCents ?? null,
      event.currency ?? 'USD',
    ]
  );
  if (!rows[0]) {
    // A payment that produced no row has not been recorded. Returning null here
    // would let the webhook answer 200 and lose the purchase, so this is an
    // error: the caller buffers the event and the drain job retries it.
    throw new Error(`Payment ${event.provider}/${event.providerOrderId} produced no order row`);
  }
  return toOrder(rows[0]);
}

export async function getOrder(id: string): Promise<Order | null> {
  assertAvailable();
  const row = await queryOne<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [id]);
  return row ? toOrder(row) : null;
}

/**
 * The paid, unrefunded order that entitles this buyer to this report, if any.
 * Either identifier is enough: the account for a logged-in buyer, the email for
 * a guest.
 */
export async function findEntitlement(
  reportId: string,
  identity: { email?: string | null; userId?: string | null }
): Promise<Order | null> {
  assertAvailable();
  const email = identity.email?.trim().toLowerCase() || null;
  const userId = identity.userId || null;
  if (!email && !userId) return null;

  const row = await queryOne<OrderRow>(
    `SELECT ${COLUMNS} FROM orders
      WHERE report_id = $1::uuid AND status = 'paid'
        AND ((LOWER(email) = $2 AND $2 IS NOT NULL) OR (user_id = $3::uuid AND $3 IS NOT NULL))
      ORDER BY paid_at DESC NULLS LAST
      LIMIT 1`,
    [reportId, email, userId]
  );
  return row ? toOrder(row) : null;
}

/** The order for one checkout attempt, so the success page can poll it. */
export async function findOrderByCheckout(provider: PaymentProvider, checkoutId: string): Promise<Order | null> {
  assertAvailable();
  const row = await queryOne<OrderRow>(
    `SELECT ${COLUMNS} FROM orders WHERE provider = $1 AND provider_checkout_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [provider, checkoutId]
  );
  return row ? toOrder(row) : null;
}

/**
 * The order behind a success-URL reference.
 *
 * The reference is a server-generated random UUID delivered only to the buyer, so
 * holding one is treated as evidence of being that buyer. This is what lets a
 * guest download without an account, a cookie, or an email round trip.
 */
export async function findOrderByReference(reference: string): Promise<Order | null> {
  assertAvailable();
  const row = await queryOne<OrderRow>(
    `SELECT ${COLUMNS} FROM orders WHERE reference = $1 ORDER BY created_at DESC LIMIT 1`,
    [reference]
  );
  return row ? toOrder(row) : null;
}

export async function listOrdersForUser(userId: string): Promise<Order[]> {
  assertAvailable();
  const rows = await query<OrderRow>(
    `SELECT ${COLUMNS} FROM orders WHERE user_id = $1::uuid AND status <> 'pending'
      ORDER BY created_at DESC LIMIT 200`,
    [userId]
  );
  return rows.map(toOrder);
}

export async function listOrdersForEmail(email: string): Promise<Order[]> {
  assertAvailable();
  const rows = await query<OrderRow>(
    `SELECT ${COLUMNS} FROM orders WHERE LOWER(email) = $1 AND status <> 'pending'
      ORDER BY created_at DESC LIMIT 200`,
    [email.trim().toLowerCase()]
  );
  return rows.map(toOrder);
}

export interface Purchase extends Order {
  /** Report headline, so the list is readable without a second round of queries. */
  reportTitle: string | null;
  reportKeyword: string | null;
}

/**
 * The purchases one visitor may see, newest first.
 *
 * Account and email are OR'd rather than AND'd: a buyer who paid as a guest and
 * later claimed the order should see it once, and a buyer whose provider email
 * differs from their account email should still see both.
 */
export async function listPurchases(identity: { userId?: string | null; email?: string | null }): Promise<Purchase[]> {
  assertAvailable();
  const userId = identity.userId || null;
  const email = identity.email?.trim().toLowerCase() || null;
  if (!userId && !email) return [];

  const rows = await query<OrderRow & { report_title: string | null; report_keyword: string | null }>(
    `SELECT ${COLUMNS.split(',')
      .map((c) => `o.${c.trim()}`)
      .join(', ')},
            r.title AS report_title, r.keyword AS report_keyword
       FROM orders o
       LEFT JOIN bp_reports r ON r.id = o.report_id
      WHERE o.status <> 'pending'
        AND ((o.user_id = $1::uuid AND $1 IS NOT NULL) OR (LOWER(o.email) = $2 AND $2 IS NOT NULL))
      ORDER BY o.created_at DESC
      LIMIT 200`,
    [userId, email]
  );
  return rows.map((row) => ({
    ...toOrder(row),
    reportTitle: row.report_title,
    reportKeyword: row.report_keyword,
  }));
}

/**
 * Attach a guest's past orders to an account.
 *
 * Only ever called after the email has been proven by a magic link. Matching on
 * a bare email would be a data leak dressed up as a convenience: registration
 * emails are unverified here, so anyone could sign up as someone else's address
 * and inherit their downloads.
 */
export async function attachOrdersToUser(email: string, userId: string): Promise<number> {
  assertAvailable();
  const rows = await query<{ id: string }>(
    `UPDATE orders SET user_id = $1::uuid, updated_at = NOW()
      WHERE LOWER(email) = $2 AND user_id IS NULL
      RETURNING id`,
    [userId, email.trim().toLowerCase()]
  );
  return rows.length;
}

/**
 * Count a download and report whether it was allowed.
 *
 * The check and the increment are one statement so two parallel clicks cannot
 * both pass a cap they are jointly over.
 */
export async function noteDownload(orderId: string): Promise<{ allowed: boolean; count: number }> {
  assertAvailable();
  const row = await queryOne<{ download_count: number }>(
    `UPDATE orders SET download_count = download_count + 1, last_downloaded_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'paid' AND download_count < $2
      RETURNING download_count`,
    [orderId, MAX_DOWNLOADS_PER_ORDER]
  );
  if (row) return { allowed: true, count: Number(row.download_count) };
  const current = await queryOne<{ download_count: number; status: string }>(
    `SELECT download_count, status FROM orders WHERE id = $1`,
    [orderId]
  );
  return { allowed: false, count: Number(current?.download_count ?? 0) };
}

export interface RevenueSummary {
  paidOrders: number;
  refundedOrders: number;
  grossCents: number;
  refundedCents: number;
  netCents: number;
  currency: string;
  last7dCents: number;
  last30dCents: number;
  downloads: number;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  daily: { day: string; orders: number; cents: number }[];
}

/**
 * Revenue for the stats snapshot. One query, run inside the scheduled window, so
 * the numbers reach the page without any read-path database access.
 */
export async function revenueSummary(days = 30): Promise<RevenueSummary> {
  assertAvailable();
  const totals = await queryOne<{
    paid_orders: string;
    refunded_orders: string;
    gross_cents: string;
    refunded_cents: string;
    last7: string;
    last30: string;
    downloads: string;
    first_paid_at: Date | null;
    last_paid_at: Date | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'paid')                              AS paid_orders,
       COUNT(*) FILTER (WHERE status = 'refunded')                          AS refunded_orders,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)        AS gross_cents,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'refunded'), 0)    AS refunded_cents,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '7 days'), 0)  AS last7,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '30 days'), 0) AS last30,
       COALESCE(SUM(download_count), 0)                                    AS downloads,
       MIN(paid_at) FILTER (WHERE status = 'paid')                         AS first_paid_at,
       MAX(paid_at) FILTER (WHERE status = 'paid')                         AS last_paid_at
     FROM orders`
  );

  const daily = await query<{ day: string; orders: string; cents: string }>(
    `SELECT TO_CHAR(DATE_TRUNC('day', paid_at), 'YYYY-MM-DD') AS day,
            COUNT(*) AS orders,
            COALESCE(SUM(amount_cents), 0) AS cents
       FROM orders
      WHERE status = 'paid' AND paid_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1 DESC`,
    [String(days)]
  );

  const gross = Number(totals?.gross_cents ?? 0);
  const refunded = Number(totals?.refunded_cents ?? 0);
  return {
    paidOrders: Number(totals?.paid_orders ?? 0),
    refundedOrders: Number(totals?.refunded_orders ?? 0),
    grossCents: gross,
    refundedCents: refunded,
    netCents: gross - refunded,
    currency: 'USD',
    last7dCents: Number(totals?.last7 ?? 0),
    last30dCents: Number(totals?.last30 ?? 0),
    downloads: Number(totals?.downloads ?? 0),
    firstPaidAt: totals?.first_paid_at ? new Date(totals.first_paid_at).toISOString() : null,
    lastPaidAt: totals?.last_paid_at ? new Date(totals.last_paid_at).toISOString() : null,
    daily: daily.map((r) => ({ day: r.day, orders: Number(r.orders), cents: Number(r.cents) })),
  };
}
