/**
 * CDN cache directives for read-only routes.
 *
 * Two layers, on purpose:
 * - `Cache-Control: max-age=0, must-revalidate` — browsers always revalidate, so
 *   a user never sees stale content from their own disk cache.
 * - `Netlify-CDN-Cache-Control` — the edge may serve a cached copy for `sMaxAge`
 *   and a stale copy for `staleWhileRevalidate` while it refreshes in the
 *   background. `durable` opts into Netlify's shared cache tier so a hit in one
 *   region isn't a miss in every other.
 *
 * CORRECTNESS CONSTRAINT: these pages render session-dependent markup (the
 * header shows the signed-in user). A shared cache must therefore never store a
 * response produced for an authenticated request — otherwise one user's rendered
 * header would be served to everyone. Authenticated requests get
 * `private, no-store`, and `Vary: Cookie` keeps the anonymous entry from being
 * handed to a request carrying a different cookie set.
 */

export interface CacheProfile {
  /** Seconds the CDN may serve a cached response without revalidating. */
  sMaxAge: number;
  /** Seconds the CDN may serve a stale response while revalidating behind it. */
  staleWhileRevalidate: number;
  /** Cache tags, for targeted purges via Netlify's purge API. */
  tags?: string[];
}

const DAY = 86_400;

/**
 * Freshness windows are set against the data's real update cadence: trends are
 * collected every 3h, so a 15-minute edge TTL is far tighter than the data
 * changes. Long stale-while-revalidate windows mean a cold snapshot never
 * produces a slow page.
 */
export const CACHE_PROFILES = {
  trends: { sMaxAge: 900, staleWhileRevalidate: DAY, tags: ['trends'] },
  landingIndex: { sMaxAge: 1800, staleWhileRevalidate: 7 * DAY, tags: ['landing'] },
  landingDetail: { sMaxAge: 3600, staleWhileRevalidate: 7 * DAY, tags: ['landing'] },
  bpList: { sMaxAge: 900, staleWhileRevalidate: DAY, tags: ['bp'] },
  bpDetail: { sMaxAge: 3600, staleWhileRevalidate: 7 * DAY, tags: ['bp'] },
  monitor: { sMaxAge: 600, staleWhileRevalidate: DAY, tags: ['monitor'] },
  sitemap: { sMaxAge: 3600, staleWhileRevalidate: DAY, tags: ['sitemap'] },
  /** Marketing pages: no data dependency at all. */
  staticPage: { sMaxAge: 6 * 3600, staleWhileRevalidate: 7 * DAY, tags: ['static'] },
  /** Read-only JSON APIs. */
  readApi: { sMaxAge: 300, staleWhileRevalidate: 3600, tags: ['api'] },
} as const satisfies Record<string, CacheProfile>;

export interface CacheContext {
  /** True when the request carries a session (or a session cookie). */
  authenticated: boolean;
}

/**
 * For responses that must never be stored by any cache: authenticated requests,
 * and content still being generated (a cached "generating" copy would pin the
 * visitor to it after the real report lands).
 */
export const NO_STORE_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

/**
 * Build the response headers for a cacheable read-only route. Pure, so the
 * policy is unit-testable without a running server.
 */
export function computeCacheHeaders(
  profile: CacheProfile,
  context: CacheContext = { authenticated: false }
): Record<string, string> {
  if (context.authenticated) return { ...NO_STORE_HEADERS };
  const headers: Record<string, string> = {
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Netlify-CDN-Cache-Control':
      `public, durable, s-maxage=${profile.sMaxAge}, stale-while-revalidate=${profile.staleWhileRevalidate}`,
    Vary: 'Cookie',
  };
  if (profile.tags && profile.tags.length > 0) headers['Cache-Tag'] = profile.tags.join(',');
  return headers;
}

/** Minimal shape of the Astro context bits this helper needs. */
interface AstroCacheTarget {
  cookies: { get(name: string): { value: string } | undefined };
  locals: { user?: unknown };
  response: { headers: Headers };
}

/**
 * Apply a cache profile to an Astro page/endpoint response, treating any request
 * with a session as private.
 */
export function applyPageCache(astro: AstroCacheTarget, profile: CacheProfile): void {
  const authenticated = !!astro.locals?.user || !!astro.cookies.get('session_token')?.value;
  for (const [key, value] of Object.entries(computeCacheHeaders(profile, { authenticated }))) {
    astro.response.headers.set(key, value);
  }
}
