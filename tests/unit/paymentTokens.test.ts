import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DOWNLOAD_TTL_MS,
  MAGIC_LINK_TTL_MS,
  issueClaimToken,
  issueDownloadToken,
  issueOrdersToken,
  issueToken,
  tokenSecret,
  verifyToken,
} from '../../src/lib/payments/tokens';

const SECRET = 'test-payment-secret-at-least-16';

describe('payment tokens', () => {
  let savedPayment: string | undefined;
  let savedSession: string | undefined;

  beforeEach(() => {
    savedPayment = process.env.PAYMENT_TOKEN_SECRET;
    savedSession = process.env.SESSION_SECRET;
    process.env.PAYMENT_TOKEN_SECRET = SECRET;
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    if (savedPayment === undefined) delete process.env.PAYMENT_TOKEN_SECRET;
    else process.env.PAYMENT_TOKEN_SECRET = savedPayment;
    if (savedSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSession;
  });

  it('round-trips a download token', () => {
    const token = issueDownloadToken('order-1', 'report-1')!;
    const result = verifyToken(token, 'download');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.orderId).toBe('order-1');
    expect(result.claims.reportId).toBe('report-1');
  });

  it('refuses to issue anything without a key, rather than signing with a default', () => {
    delete process.env.PAYMENT_TOKEN_SECRET;
    expect(tokenSecret()).toBeUndefined();
    expect(issueDownloadToken('order-1', 'report-1')).toBeNull();
    expect(verifyToken('anything', 'download')).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('falls back to SESSION_SECRET so a deployment cannot issue unsigned links', () => {
    delete process.env.PAYMENT_TOKEN_SECRET;
    process.env.SESSION_SECRET = 'session-secret-at-least-16-chars';
    const token = issueDownloadToken('order-1', 'report-1');
    expect(token).not.toBeNull();
    expect(verifyToken(token, 'download').ok).toBe(true);
  });

  it('ignores a key too short to be one', () => {
    process.env.PAYMENT_TOKEN_SECRET = 'short';
    expect(tokenSecret()).toBeUndefined();
  });

  it('rejects a token signed with a different key', () => {
    const token = issueDownloadToken('order-1', 'report-1')!;
    process.env.PAYMENT_TOKEN_SECRET = 'a-completely-different-secret-!!';
    expect(verifyToken(token, 'download')).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a tampered payload', () => {
    // The attack this defends against: editing the claims to point at another
    // order. Only the signature stands between the buyer and every report.
    const token = issueDownloadToken('order-1', 'report-1')!;
    const [version, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.orderId = 'order-2';
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(verifyToken(`${version}.${forged}.${signature}`, 'download')).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('will not let one purpose be replayed as another', () => {
    // Both are signed by the same key, so purpose separation is what stops an
    // emailed order-lookup link from working as a download link.
    const orders = issueOrdersToken('buyer@example.com')!;
    expect(verifyToken(orders, 'download')).toEqual({ ok: false, reason: 'purpose' });
    expect(verifyToken(orders, 'orders').ok).toBe(true);
  });

  it('expires', () => {
    const issuedAt = 1_000_000;
    const token = issueDownloadToken('order-1', 'report-1', issuedAt)!;
    expect(verifyToken(token, 'download', issuedAt + DOWNLOAD_TTL_MS - 1).ok).toBe(true);
    expect(verifyToken(token, 'download', issuedAt + DOWNLOAD_TTL_MS)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('keeps magic links short-lived, since they cannot be revoked individually', () => {
    expect(MAGIC_LINK_TTL_MS).toBeLessThanOrEqual(30 * 60_000);
    const issuedAt = 5_000_000;
    const token = issueClaimToken('buyer@example.com', 'user-1', issuedAt)!;
    expect(verifyToken(token, 'claim', issuedAt + MAGIC_LINK_TTL_MS).ok).toBe(false);
  });

  it('binds a claim link to one account', () => {
    const token = issueClaimToken('buyer@example.com', 'user-1')!;
    const result = verifyToken(token, 'claim');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The endpoint compares this against the session; without it, forwarding the
    // email would move someone else's purchases into the recipient's account.
    expect(result.claims.userId).toBe('user-1');
    expect(result.claims.email).toBe('buyer@example.com');
  });

  it('lower-cases emails so lookup cannot be defeated by capitalisation', () => {
    const result = verifyToken(issueOrdersToken('Buyer@Example.COM')!, 'orders');
    expect(result.ok && result.claims.email).toBe('buyer@example.com');
  });

  it('treats junk as a bad token rather than throwing', () => {
    for (const junk of ['', 'x', 'p1.notbase64!.sig', 'p2.abc.def', 'a.b.c.d']) {
      expect(() => verifyToken(junk, 'download')).not.toThrow();
      expect(verifyToken(junk, 'download').ok).toBe(false);
    }
  });

  it('rejects a payload whose claims are not an object with an expiry', () => {
    const payload = Buffer.from(JSON.stringify('nope')).toString('base64url');
    const token = issueToken({ purpose: 'download' }, 1000)!;
    const signature = token.split('.')[2];
    expect(verifyToken(`p1.${payload}.${signature}`, 'download').ok).toBe(false);
  });
});
