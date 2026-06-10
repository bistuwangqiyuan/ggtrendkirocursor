import { describe, test, expect } from 'vitest';
import { zh } from '../../src/lib/i18n/zh';
import { en } from '../../src/lib/i18n/en';
import { isValidNewsletterEmail } from '../../src/lib/validators/newsletter';

function paths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? paths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );
}

describe('i18n zh/en parity', () => {
  const zp = new Set(paths(zh as unknown as Record<string, unknown>));
  const ep = new Set(paths(en as unknown as Record<string, unknown>));

  test('same number of keys', () => {
    expect(zp.size).toBe(ep.size);
  });

  test('no keys only in zh', () => {
    const onlyZh = [...zp].filter((k) => !ep.has(k));
    expect(onlyZh).toEqual([]);
  });

  test('no keys only in en', () => {
    const onlyEn = [...ep].filter((k) => !zp.has(k));
    expect(onlyEn).toEqual([]);
  });
});

describe('isValidNewsletterEmail', () => {
  test('accepts valid emails', () => {
    expect(isValidNewsletterEmail('user@example.com')).toBe(true);
    expect(isValidNewsletterEmail('  user@example.com  ')).toBe(true);
  });

  test('rejects invalid emails', () => {
    expect(isValidNewsletterEmail('')).toBe(false);
    expect(isValidNewsletterEmail('not-an-email')).toBe(false);
    expect(isValidNewsletterEmail('@missing.local')).toBe(false);
    expect(isValidNewsletterEmail('a@')).toBe(false);
  });
});
