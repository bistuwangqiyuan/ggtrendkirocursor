/**
 * Signed session cookie.
 *
 * PROBLEM
 * The middleware used to run one `sessions JOIN users` query for every request
 * carrying a cookie. On Neon's free plan that query is not "cheap": it wakes the
 * compute and resets its 5-minute auto-suspend timer, so a single user browsing
 * the site keeps the instance billing continuously.
 *
 * APPROACH
 * The cookie carries an HMAC-signed envelope holding the opaque session token
 * plus the small user fields the layout renders. Within `revalidateAfter` the
 * middleware trusts the signature alone; after that it re-checks the `sessions`
 * table once and re-issues the envelope. Postgres remains the source of truth
 * for logout and auditing.
 *
 * SECURITY TRADE-OFF (deliberate, documented)
 * After a logout, a cookie captured beforehand stays usable until its
 * revalidation deadline — at most SESSION_REVALIDATE_MINUTES (default 30).
 * Bounds that keep this acceptable:
 *   - The envelope is refused outright past the session's own absolute expiry.
 *   - Nothing is trusted without a valid HMAC over the whole payload, so the
 *     contents cannot be forged or extended.
 *   - Without SESSION_SECRET configured, this module is inert and the caller
 *     falls back to querying the database on every request (fail safe, never
 *     fail open).
 * If a zero-second logout is required, set SESSION_REVALIDATE_MINUTES=0.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The user fields the layout/header needs; deliberately minimal. */
export interface SessionUserClaims {
  id: string;
  username: string;
  email: string;
  locale?: string;
}

export interface SessionEnvelope {
  /** Opaque session token — still the database key for logout/audit. */
  token: string;
  user: SessionUserClaims;
  /** Epoch ms after which the database must be consulted again. */
  revalidateAfter: number;
  /** Epoch ms of the session's absolute expiry; never trusted past this. */
  expiresAt: number;
}

const VERSION = 'v1';

export function getSessionSecret(): string | undefined {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : undefined;
}

/** Revalidation interval in ms. 0 disables stateless trust entirely. */
export function revalidateIntervalMs(): number {
  const raw = process.env.SESSION_REVALIDATE_MINUTES;
  const minutes = raw === undefined ? 30 : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return 30 * 60_000;
  return Math.floor(minutes) * 60_000;
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input as any).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which itself leaks nothing here.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Build the cookie value. Returns null when signing is unavailable or disabled,
 * so the caller stores the raw token and keeps validating against the database.
 */
export function encodeSessionCookie(envelope: SessionEnvelope): string | null {
  const secret = getSessionSecret();
  if (!secret || revalidateIntervalMs() === 0) return null;
  const payload = b64urlEncode(JSON.stringify(envelope));
  return `${VERSION}.${payload}.${sign(payload, secret)}`;
}

export type DecodeResult =
  | { kind: 'valid'; envelope: SessionEnvelope; needsRevalidation: boolean }
  /** Not a signed envelope (e.g. a legacy raw token) — validate against the DB. */
  | { kind: 'not-signed' }
  /** Signed but untrustworthy: bad signature, tampered, or past absolute expiry. */
  | { kind: 'invalid'; reason: string };

/** Verify and decode a cookie value. Never throws. */
export function decodeSessionCookie(value: string | undefined | null): DecodeResult {
  if (!value) return { kind: 'not-signed' };
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { kind: 'not-signed' };

  const secret = getSessionSecret();
  // A signed cookie with no secret to check it against must not be trusted.
  if (!secret) return { kind: 'not-signed' };

  const [, payload, signature] = parts;
  if (!signaturesMatch(signature, sign(payload, secret))) {
    return { kind: 'invalid', reason: 'signature mismatch' };
  }

  let envelope: SessionEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { kind: 'invalid', reason: 'malformed payload' };
  }

  if (
    !envelope
    || typeof envelope.token !== 'string' || envelope.token.length === 0
    || !envelope.user || typeof envelope.user.id !== 'string'
    || typeof envelope.revalidateAfter !== 'number'
    || typeof envelope.expiresAt !== 'number'
  ) {
    return { kind: 'invalid', reason: 'missing fields' };
  }

  const now = Date.now();
  if (now >= envelope.expiresAt) return { kind: 'invalid', reason: 'session expired' };

  return { kind: 'valid', envelope, needsRevalidation: now >= envelope.revalidateAfter };
}

/** Extract the opaque token from either a signed envelope or a legacy raw cookie. */
export function extractToken(value: string | undefined | null): string | null {
  if (!value) return null;
  const decoded = decodeSessionCookie(value);
  if (decoded.kind === 'valid') return decoded.envelope.token;
  if (decoded.kind === 'invalid') return null;
  return value;
}

/** Assemble an envelope with a fresh revalidation deadline. */
export function buildEnvelope(
  token: string,
  user: SessionUserClaims,
  sessionExpiresAt: Date | number,
  now = Date.now()
): SessionEnvelope {
  const expiresAt = sessionExpiresAt instanceof Date ? sessionExpiresAt.getTime() : sessionExpiresAt;
  return {
    token,
    user: { id: user.id, username: user.username, email: user.email, locale: user.locale },
    // Never let the stateless window outlive the session itself.
    revalidateAfter: Math.min(now + revalidateIntervalMs(), expiresAt),
    expiresAt,
  };
}
