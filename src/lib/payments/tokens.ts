/**
 * Signed, expiring capabilities: download links, and the magic links that let a
 * guest reach their own past orders.
 *
 * WHY SIGNED TOKENS AND NOT DATABASE ROWS
 * Neon's free plan bills compute time, and on this site the read path is required
 * never to touch Postgres (see cache/snapshot.ts). A one-time-token table would
 * put a database write on the buyer's click and a read on every download, so a
 * token that carries its own proof is both cheaper and available during an
 * outage — which matters most exactly when someone has just paid.
 *
 * WHAT KEEPS IT SAFE
 * - Every token names its `purpose`. A download link cannot be replayed as an
 *   account-claim link even though both are signed by the same key, because the
 *   purpose is inside the signed payload and checked on use.
 * - Expiry is inside the payload, so it cannot be extended without the key.
 * - Comparison is constant-time, and a missing key disables issuing entirely
 *   rather than falling back to something guessable.
 *
 * The unavoidable trade-off of stateless tokens: a link cannot be individually
 * revoked before it expires. So download links are short-lived, the download
 * endpoint re-checks the order's status (a refund therefore stops it), and
 * magic links last minutes rather than days.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenPurpose =
  /** Fetch the PDF for one paid order. */
  | 'download'
  /** Open the order list for one email address. */
  | 'orders'
  /** Attach a guest's past orders to a logged-in account. */
  | 'claim';

export interface TokenClaims {
  purpose: TokenPurpose;
  /** Order id, for download tokens. */
  orderId?: string;
  /** Report id, so a download token is scoped to one artifact. */
  reportId?: string;
  /** Lower-cased email, for orders/claim tokens. */
  email?: string;
  /** Account the claim is for, so a link mailed to one user cannot serve another. */
  userId?: string;
  /** Epoch ms. */
  exp: number;
}

const VERSION = 'p1';

/** Download links are meant to be re-usable for a few days, not forever. */
export const DOWNLOAD_TTL_MS = 7 * 24 * 3_600_000;
/** Emailed links are single-purpose and should expire while the buyer is still reading. */
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/**
 * Separate from SESSION_SECRET where possible: rotating the session key to log
 * everyone out should not also break every download link that has been emailed
 * out. Falls back to it so a deployment cannot end up issuing unsigned links.
 */
export function tokenSecret(): string | undefined {
  const explicit = process.env.PAYMENT_TOKEN_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;
  const session = process.env.SESSION_SECRET?.trim();
  return session && session.length >= 16 ? session : undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function matches(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Returns null when no key is configured, so callers fail closed. */
export function issueToken(claims: Omit<TokenClaims, 'exp'>, ttlMs: number, now = Date.now()): string | null {
  const secret = tokenSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: now + ttlMs })).toString('base64url');
  return `${VERSION}.${payload}.${sign(payload, secret)}`;
}

export type TokenResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'unconfigured' | 'malformed' | 'signature' | 'expired' | 'purpose' };

/** Never throws: a bad token is a 403, not a 500. */
export function verifyToken(token: string | null | undefined, purpose: TokenPurpose, now = Date.now()): TokenResult {
  const secret = tokenSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payload, signature] = parts;
  if (!matches(signature, sign(payload, secret))) return { ok: false, reason: 'signature' };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  // Purpose before expiry: a token used for the wrong thing is a different kind
  // of problem from one that simply timed out, and worth logging as such.
  if (claims.purpose !== purpose) return { ok: false, reason: 'purpose' };
  if (now >= claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

export function issueDownloadToken(orderId: string, reportId: string, now = Date.now()): string | null {
  return issueToken({ purpose: 'download', orderId, reportId }, DOWNLOAD_TTL_MS, now);
}

export function issueOrdersToken(email: string, now = Date.now()): string | null {
  return issueToken({ purpose: 'orders', email: email.trim().toLowerCase() }, MAGIC_LINK_TTL_MS, now);
}

export function issueClaimToken(email: string, userId: string, now = Date.now()): string | null {
  return issueToken({ purpose: 'claim', email: email.trim().toLowerCase(), userId }, MAGIC_LINK_TTL_MS, now);
}
