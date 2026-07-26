import { describe, it, expect } from 'vitest';
import {
  CACHE_PROFILES,
  NO_STORE_HEADERS,
  applyPageCache,
  computeCacheHeaders,
} from '../../src/lib/cache/httpCache';

describe('computeCacheHeaders', () => {
  it('lets the edge cache anonymous responses but forces browser revalidation', () => {
    const h = computeCacheHeaders(CACHE_PROFILES.trends);
    expect(h['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    expect(h['Netlify-CDN-Cache-Control']).toBe(
      'public, durable, s-maxage=900, stale-while-revalidate=86400'
    );
  });

  it('never allows a shared cache to store an authenticated response', () => {
    // Regression guard: caching a page rendered for a signed-in user would serve
    // that user's header to every other visitor.
    const h = computeCacheHeaders(CACHE_PROFILES.trends, { authenticated: true });
    expect(h['Cache-Control']).toBe('private, no-store');
    expect(h['Netlify-CDN-Cache-Control']).toBeUndefined();
    expect(h['Cache-Tag']).toBeUndefined();
  });

  it('varies on Cookie so a locale-specific render is not shared across locales', () => {
    expect(computeCacheHeaders(CACHE_PROFILES.trends).Vary).toBe('Cookie');
    expect(computeCacheHeaders(CACHE_PROFILES.trends, { authenticated: true }).Vary).toBe('Cookie');
  });

  it('emits cache tags for targeted purges', () => {
    expect(computeCacheHeaders(CACHE_PROFILES.bpDetail)['Cache-Tag']).toBe('bp');
  });

  it('omits the tag header when a profile has none', () => {
    const h = computeCacheHeaders({ sMaxAge: 60, staleWhileRevalidate: 120 });
    expect(h['Cache-Tag']).toBeUndefined();
    expect(h['Netlify-CDN-Cache-Control']).toContain('s-maxage=60');
  });

  it('returns a fresh object each call so callers cannot mutate shared state', () => {
    const a = computeCacheHeaders(CACHE_PROFILES.trends, { authenticated: true });
    a['Cache-Control'] = 'tampered';
    expect(NO_STORE_HEADERS['Cache-Control']).toBe('private, no-store');
  });
});

describe('CACHE_PROFILES', () => {
  it('keeps every edge TTL well under the 3-hour data refresh cadence', () => {
    for (const [name, profile] of Object.entries(CACHE_PROFILES)) {
      expect(profile.sMaxAge, name).toBeGreaterThan(0);
      expect(profile.sMaxAge, name).toBeLessThanOrEqual(6 * 3600);
      expect(profile.staleWhileRevalidate, name).toBeGreaterThanOrEqual(profile.sMaxAge);
    }
  });
});

describe('applyPageCache', () => {
  function fakeAstro(opts: { user?: unknown; cookie?: string } = {}) {
    const headers = new Headers();
    return {
      cookies: { get: (n: string) => (n === 'session_token' && opts.cookie ? { value: opts.cookie } : undefined) },
      locals: { user: opts.user },
      response: { headers },
    };
  }

  it('applies public caching for an anonymous request', () => {
    const astro = fakeAstro();
    applyPageCache(astro, CACHE_PROFILES.landingDetail);
    expect(astro.response.headers.get('Netlify-CDN-Cache-Control')).toContain('s-maxage=3600');
  });

  it('treats a session cookie as authenticated even before locals.user is set', () => {
    const astro = fakeAstro({ cookie: 'abc' });
    applyPageCache(astro, CACHE_PROFILES.landingDetail);
    expect(astro.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(astro.response.headers.get('Netlify-CDN-Cache-Control')).toBeNull();
  });

  it('treats a resolved user as authenticated', () => {
    const astro = fakeAstro({ user: { id: 'u1' } });
    applyPageCache(astro, CACHE_PROFILES.trends);
    expect(astro.response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
