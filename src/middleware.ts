import { defineMiddleware } from 'astro:middleware';
import type { APIContext, MiddlewareNext } from 'astro';
import { authService } from './lib/services/auth';
import { isDbDown } from './lib/db/client';
import {
  buildEnvelope,
  decodeSessionCookie,
  encodeSessionCookie,
  extractToken,
} from './lib/auth/sessionCookie';
import { classifyRoute, runWithDbContext } from './lib/observability/dbContext';
import { flushErrorLog } from './lib/observability/errorLog';
import type { User } from './types';

const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  secure: import.meta.env.PROD,
  sameSite: 'lax' as const,
  maxAge: 60 * 60 * 24 * 30,
};

export const onRequest = defineMiddleware(async (context, next) => {
  // Tag every database wake-up with the route that caused it. A wake attributed
  // to `page` is the signal that a read path regressed back onto Postgres.
  const pathname = new URL(context.request.url).pathname;
  return runWithDbContext({ reason: classifyRoute(pathname), route: pathname }, async () => {
    const response = await handleRequest(context, next);
    // Serverless functions can be frozen immediately after responding, so persist
    // buffered log entries before handing the response back.
    await flushErrorLog();
    return response;
  });
});

async function handleRequest(context: APIContext, next: MiddlewareNext) {
  const { cookies, locals } = context;

  // 1. Handle Locale.
  // Chinese is the default for every new visitor regardless of Accept-Language
  // (requirements 4.1 and 4.2 both specify Chinese); only an explicit cookie,
  // set by the language switcher, changes it.
  const localeCookie = cookies.get('locale')?.value;
  const locale: 'zh' | 'en' = localeCookie === 'en' ? 'en' : 'zh';
  locals.locale = locale;

  // 2. Handle Authentication
  const cookieValue = cookies.get('session_token')?.value;
  if (!cookieValue) return next();

  const decoded = decodeSessionCookie(cookieValue);

  if (decoded.kind === 'invalid') {
    // A signed cookie that fails verification or is past its absolute expiry is
    // worthless — no database round-trip can rescue it.
    cookies.delete('session_token', { path: '/' });
    return next();
  }

  // Fast path: a valid signature inside the revalidation window means this
  // request is served without touching Postgres at all.
  if (decoded.kind === 'valid' && !decoded.needsRevalidation) {
    locals.user = {
      id: decoded.envelope.user.id,
      username: decoded.envelope.user.username,
      email: decoded.envelope.user.email,
      locale: decoded.envelope.user.locale,
    } as User;
    applySavedLocale(context, localeCookie, locale, decoded.envelope.user.locale);
    return next();
  }

  const token = extractToken(cookieValue);

  // During a DB outage, proceed as anonymous WITHOUT touching the cookie.
  // Otherwise a transient outage would log every user out (validateSession
  // can't reach the DB -> looks like an invalid token -> cookie deleted).
  if (!token || isDbDown()) return next();

  const result = await runWithDbContext(
    { reason: 'auth', route: new URL(context.request.url).pathname },
    () => authService.validateSessionDetailed(token)
  );

  if (result.success) {
    const { user, expiresAt } = result.data;
    locals.user = user;

    // Re-issue the signed cookie so the next ~30 minutes of requests skip the DB.
    const signed = encodeSessionCookie(
      buildEnvelope(
        token,
        { id: user.id, username: user.username, email: user.email, locale: user.locale },
        expiresAt
      )
    );
    if (signed) cookies.set('session_token', signed, SESSION_COOKIE_OPTIONS);

    applySavedLocale(context, localeCookie, locale, user.locale);
  } else if (!isDbDown()) {
    // Only clear a genuinely invalid/expired token. If the breaker tripped while
    // validating (DB went down mid-request), keep the cookie so the session
    // survives the outage.
    cookies.delete('session_token', { path: '/' });
  }

  return next();
}

/**
 * Apply the account's saved locale ONLY when this browser has no explicit cookie
 * yet (e.g. first visit on a new device). When a cookie exists it represents the
 * user's most recent choice — the switch endpoint keeps users.locale in sync — so
 * overriding it here would make language switching impossible for logged-in users.
 */
function applySavedLocale(
  context: Pick<APIContext, 'cookies' | 'locals'>,
  localeCookie: string | undefined,
  currentLocale: 'zh' | 'en',
  saved: string | undefined
): void {
  const hasExplicitCookie = localeCookie === 'en' || localeCookie === 'zh';
  if (hasExplicitCookie) return;
  if ((saved !== 'en' && saved !== 'zh') || saved === currentLocale) return;
  context.locals.locale = saved;
  context.cookies.set('locale', saved, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
}
