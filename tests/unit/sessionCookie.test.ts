import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildEnvelope,
  decodeSessionCookie,
  encodeSessionCookie,
  extractToken,
  getSessionSecret,
  revalidateIntervalMs,
} from '../../src/lib/auth/sessionCookie';

const SECRET = 'test-session-secret-at-least-16-chars';
const USER = { id: 'u-1', username: 'alice', email: 'alice@example.com', locale: 'en' };

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  delete process.env.SESSION_REVALIDATE_MINUTES;
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_REVALIDATE_MINUTES;
});

function farFuture() {
  return Date.now() + 30 * 24 * 3600_000;
}

describe('encode/decode round-trip', () => {
  it('carries the token and user claims without a database lookup', () => {
    const cookie = encodeSessionCookie(buildEnvelope('tok-abc', USER, farFuture()))!;
    expect(cookie.startsWith('v1.')).toBe(true);

    const decoded = decodeSessionCookie(cookie);
    expect(decoded.kind).toBe('valid');
    if (decoded.kind !== 'valid') return;
    expect(decoded.envelope.token).toBe('tok-abc');
    expect(decoded.envelope.user).toEqual(USER);
    expect(decoded.needsRevalidation).toBe(false);
  });

  it('flags revalidation once the window has passed', () => {
    const envelope = buildEnvelope('tok', USER, farFuture(), Date.now() - 31 * 60_000);
    const decoded = decodeSessionCookie(encodeSessionCookie(envelope)!);
    expect(decoded.kind).toBe('valid');
    if (decoded.kind !== 'valid') return;
    expect(decoded.needsRevalidation).toBe(true);
  });

  it('never lets the trust window outlive the session itself', () => {
    const expiresAt = Date.now() + 60_000; // session expires in 1 minute
    const envelope = buildEnvelope('tok', USER, expiresAt);
    expect(envelope.revalidateAfter).toBe(expiresAt);
  });
});

describe('tamper resistance', () => {
  it('rejects a modified payload', () => {
    const cookie = encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))!;
    const [v, payload, sig] = cookie.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    forged.user.id = 'attacker';
    const tampered = `${v}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;

    const decoded = decodeSessionCookie(tampered);
    expect(decoded.kind).toBe('invalid');
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))!;
    process.env.SESSION_SECRET = 'a-completely-different-secret-value';
    expect(decodeSessionCookie(cookie).kind).toBe('invalid');
  });

  it('refuses an envelope past the absolute session expiry even if signed correctly', () => {
    const cookie = encodeSessionCookie({
      token: 'tok',
      user: USER,
      revalidateAfter: Date.now() + 3600_000,
      expiresAt: Date.now() - 1000,
    })!;
    const decoded = decodeSessionCookie(cookie);
    expect(decoded.kind).toBe('invalid');
    if (decoded.kind === 'invalid') expect(decoded.reason).toBe('session expired');
  });

  it('rejects a payload missing required fields', () => {
    const payload = Buffer.from(JSON.stringify({ token: 'x' })).toString('base64url');
    // Sign it properly so only the field check can reject it.
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    const decoded = decodeSessionCookie(`v1.${payload}.${sig}`);
    expect(decoded.kind).toBe('invalid');
  });
});

describe('fail-safe behaviour without a secret', () => {
  it('does not sign when SESSION_SECRET is absent', () => {
    delete process.env.SESSION_SECRET;
    expect(encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))).toBeNull();
  });

  it('rejects short secrets rather than signing weakly', () => {
    process.env.SESSION_SECRET = 'tooshort';
    expect(getSessionSecret()).toBeUndefined();
    expect(encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))).toBeNull();
  });

  it('treats a signed cookie as unsigned when no secret is configured, forcing DB validation', () => {
    const cookie = encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))!;
    delete process.env.SESSION_SECRET;
    // Must NOT be trusted, and must NOT be deleted either: fall through to the DB.
    expect(decodeSessionCookie(cookie).kind).toBe('not-signed');
  });

  it('disables stateless trust when SESSION_REVALIDATE_MINUTES=0', () => {
    process.env.SESSION_REVALIDATE_MINUTES = '0';
    expect(revalidateIntervalMs()).toBe(0);
    expect(encodeSessionCookie(buildEnvelope('tok', USER, farFuture()))).toBeNull();
  });

  it('falls back to the 30-minute default for a nonsense interval', () => {
    process.env.SESSION_REVALIDATE_MINUTES = 'abc';
    expect(revalidateIntervalMs()).toBe(30 * 60_000);
    process.env.SESSION_REVALIDATE_MINUTES = '-5';
    expect(revalidateIntervalMs()).toBe(30 * 60_000);
  });
});

describe('legacy cookies', () => {
  it('treats a raw token as not-signed so existing sessions keep working', () => {
    expect(decodeSessionCookie('a1b2c3d4e5f6').kind).toBe('not-signed');
    expect(extractToken('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
  });

  it('extracts the opaque token from a signed envelope for logout', () => {
    const cookie = encodeSessionCookie(buildEnvelope('tok-xyz', USER, farFuture()))!;
    expect(extractToken(cookie)).toBe('tok-xyz');
  });

  it('returns null for an untrustworthy cookie so nothing is deleted by guesswork', () => {
    expect(extractToken('v1.aaaa.bbbb')).toBeNull();
    expect(extractToken(undefined)).toBeNull();
  });
});
