import { describe, test, expect } from 'vitest';
import { isValidEmail, isValidPassword, isValidUsername, sanitizeInput } from '../../src/lib/utils/validation';
import { formatNumber, formatGrowthRate } from '../../src/lib/utils/format';

describe('Validation Utils', () => {
  test('isValidEmail validates email correctly', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name@domain.co.uk')).toBe(true);
    expect(isValidEmail('invalid')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  test('isValidUsername validates username correctly', () => {
    expect(isValidUsername('validUser')).toBe(true);
    expect(isValidUsername('user_123')).toBe(true);
    expect(isValidUsername('us')).toBe(false); // Too short
    expect(isValidUsername('a'.repeat(21))).toBe(false); // Too long
    expect(isValidUsername('invalid space')).toBe(false);
  });

  test('isValidPassword validates password correctly', () => {
    expect(isValidPassword('StrongPass1')).toBe(true);
    expect(isValidPassword('weak')).toBe(false); // Too short
    expect(isValidPassword('NoNumbers')).toBe(false); // No numbers
    expect(isValidPassword('nonumbers')).toBe(false); // No uppercase
    expect(isValidPassword('12345678')).toBe(false); // No letters
  });

  test('sanitizeInput escapes HTML characters', () => {
    expect(sanitizeInput('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sanitizeInput('User "Input"')).toBe('User &quot;Input&quot;');
  });
});

describe('Format Utils', () => {
  test('formatNumber formats with commas', () => {
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1000000)).toBe('1,000,000');
    expect(formatNumber(123)).toBe('123');
  });

  test('formatGrowthRate formats percentage', () => {
    expect(formatGrowthRate(10)).toBe('+10%');
    expect(formatGrowthRate(-5)).toBe('-5%');
    expect(formatGrowthRate(0)).toBe('0%');
  });
});

