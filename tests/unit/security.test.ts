import { describe, test, expect, beforeEach } from 'vitest';
import { checkAdminSecret } from '../../src/lib/utils/adminAuth';
import { rateLimit, resetRateLimits } from '../../src/lib/utils/rateLimit';

describe('checkAdminSecret (ops endpoint authorization)', () => {
  test('fail-closed 503 when no secret is configured at all', () => {
    const r = checkAdminSecret('anything', undefined, undefined);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  test('rejects the retired hard-coded literal when a real secret is configured', () => {
    const r = checkAdminSecret('trendnow-seed', 'real-admin-secret', undefined);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test('accepts a matching ADMIN_SECRET', () => {
    const r = checkAdminSecret('real-admin-secret', 'real-admin-secret', undefined);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  test('falls back to CRON_SECRET when ADMIN_SECRET is unset', () => {
    expect(checkAdminSecret('cron-secret', undefined, 'cron-secret').ok).toBe(true);
    expect(checkAdminSecret('wrong', undefined, 'cron-secret').status).toBe(401);
  });

  test('empty / missing provided secret is rejected', () => {
    expect(checkAdminSecret('', 'x', undefined).status).toBe(401);
    expect(checkAdminSecret(null, 'x', undefined).status).toBe(401);
    expect(checkAdminSecret(undefined, 'x', undefined).status).toBe(401);
  });

  test('whitespace-only configured secrets count as unconfigured (503)', () => {
    expect(checkAdminSecret('  ', '  ', '   ').status).toBe(503);
  });
});

describe('rateLimit (sliding window)', () => {
  beforeEach(() => resetRateLimits());

  test('allows up to the limit then blocks', () => {
    const t0 = 1_000_000;
    expect(rateLimit('k', 3, 60_000, t0).allowed).toBe(true);
    expect(rateLimit('k', 3, 60_000, t0 + 10).allowed).toBe(true);
    expect(rateLimit('k', 3, 60_000, t0 + 20).allowed).toBe(true);
    const blocked = rateLimit('k', 3, 60_000, t0 + 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('window slides: old hits expire and free capacity', () => {
    const t0 = 1_000_000;
    rateLimit('k', 2, 1_000, t0);
    rateLimit('k', 2, 1_000, t0 + 100);
    expect(rateLimit('k', 2, 1_000, t0 + 200).allowed).toBe(false);
    // First hit leaves the window at t0 + 1000.
    expect(rateLimit('k', 2, 1_000, t0 + 1_001).allowed).toBe(true);
  });

  test('keys are independent', () => {
    const t0 = 5_000;
    rateLimit('a', 1, 60_000, t0);
    expect(rateLimit('a', 1, 60_000, t0 + 1).allowed).toBe(false);
    expect(rateLimit('b', 1, 60_000, t0 + 1).allowed).toBe(true);
  });

  test('remaining counts down as hits accumulate', () => {
    const t0 = 9_000;
    expect(rateLimit('r', 3, 60_000, t0).remaining).toBe(2);
    expect(rateLimit('r', 3, 60_000, t0 + 1).remaining).toBe(1);
    expect(rateLimit('r', 3, 60_000, t0 + 2).remaining).toBe(0);
  });
});
