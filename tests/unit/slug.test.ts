import { describe, it, expect } from 'vitest';
import { slugifyKeyword, slugToLikePattern } from '../../src/lib/utils/slug';

describe('slugifyKeyword', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyKeyword('Taylor Swift')).toBe('taylor-swift');
  });

  it('collapses punctuation runs into single hyphens', () => {
    expect(slugifyKeyword("D'Angelo & Sons, Inc.")).toBe('d-angelo-sons-inc');
  });

  it('trims leading/trailing separators', () => {
    expect(slugifyKeyword('  -hello world-  ')).toBe('hello-world');
  });

  it('preserves unicode letters and numbers', () => {
    expect(slugifyKeyword('东京 2026')).toBe('东京-2026');
  });

  it('returns empty string for pure punctuation', () => {
    expect(slugifyKeyword('!!! ---')).toBe('');
  });

  it('is idempotent on its own output', () => {
    const s = slugifyKeyword('Some Complex "Keyword" (2026)!');
    expect(slugifyKeyword(s)).toBe(s);
  });
});

describe('slugToLikePattern', () => {
  it('turns hyphen runs into % wildcards', () => {
    expect(slugToLikePattern('taylor-swift')).toBe('taylor%swift');
  });

  it('escapes ILIKE wildcards', () => {
    expect(slugToLikePattern('100%_done')).toBe('100\\%\\_done');
  });

  it('round-trips: pattern matches the original keyword shape', () => {
    // "d-angelo-sons" -> "d%angelo%sons" which ILIKE-matches "D'Angelo & Sons"
    const slug = slugifyKeyword("D'Angelo & Sons");
    const pattern = slugToLikePattern(slug);
    expect(pattern).toBe('d%angelo%sons');
  });
});
