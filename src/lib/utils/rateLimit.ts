/**
 * Lightweight in-memory sliding-window rate limiter for write endpoints
 * (login, register, feedback, newsletter, BP generation).
 *
 * Serverless caveat (stated honestly): state lives per function instance, so a
 * cold start resets counters and parallel instances count independently. This
 * is a baseline defence that stops naive brute-force/abuse loops hitting one
 * warm instance — not a distributed quota. A shared store (e.g. a DB counter)
 * would be needed for hard guarantees.
 */

interface WindowEntry {
  /** Epoch-ms timestamps of accepted hits, newest last. */
  hits: number[];
}

const buckets = new Map<string, WindowEntry>();

/** Prevent unbounded growth if many unique keys show up. */
const MAX_BUCKETS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the oldest hit leaves the window (advisory Retry-After). */
  retryAfterSeconds: number;
}

/**
 * Record + check a hit for `key`. Allows at most `limit` hits per `windowMs`.
 * Pure with respect to the injected clock for unit testing.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitResult {
  let entry = buckets.get(key);
  if (!entry) {
    if (buckets.size >= MAX_BUCKETS) {
      // Drop the oldest bucket (Map preserves insertion order).
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    entry = { hits: [] };
    buckets.set(key, entry);
  }

  const cutoff = now - windowMs;
  entry.hits = entry.hits.filter((t) => t > cutoff);

  if (entry.hits.length >= limit) {
    const oldest = entry.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  entry.hits.push(now);
  return { allowed: true, remaining: limit - entry.hits.length, retryAfterSeconds: 0 };
}

/** Clear all counters (tests). */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Best-effort client IP from a request behind the Netlify proxy. */
export function clientIpFromRequest(request: Request): string {
  const h = request.headers;
  return (
    h.get('x-nf-client-connection-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/** Standard 429 JSON response for a blocked request. */
export function rateLimitResponse(result: RateLimitResult, message = '请求过于频繁，请稍后再试'): Response {
  return new Response(JSON.stringify({ success: false, error: message, code: 'RATE_LIMITED' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(result.retryAfterSeconds),
    },
  });
}
