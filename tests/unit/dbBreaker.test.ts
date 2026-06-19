import { describe, test, expect, beforeEach } from 'vitest';
import { isDbDown, markDbUnavailable, resetDbBreaker, query } from '../../src/lib/db/client';

describe('DB circuit breaker', () => {
  beforeEach(() => {
    resetDbBreaker();
  });

  test('starts closed', () => {
    expect(isDbDown()).toBe(false);
  });

  test('opens when marked unavailable and reports down within the cooldown', () => {
    markDbUnavailable(5_000);
    expect(isDbDown()).toBe(true);
  });

  test('half-open: reports recovered once the cooldown has elapsed', () => {
    // A negative cooldown puts dbDownUntil in the past, simulating an elapsed window.
    markDbUnavailable(-100);
    expect(isDbDown()).toBe(false);
  });

  test('resetDbBreaker clears an open breaker', () => {
    markDbUnavailable(5_000);
    expect(isDbDown()).toBe(true);
    resetDbBreaker();
    expect(isDbDown()).toBe(false);
  });

  test('query() short-circuits to an empty array while the breaker is open (no DB wait)', async () => {
    markDbUnavailable(5_000);
    const start = Date.now();
    const rows = await query('SELECT 1');
    expect(rows).toEqual([]);
    // Must return effectively instantly rather than waiting on a connection timeout.
    expect(Date.now() - start).toBeLessThan(200);
  });
});
