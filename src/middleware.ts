import { defineMiddleware } from 'astro:middleware';
import { authService } from './lib/services/auth';
import { isDbDown } from './lib/db/client';

export const onRequest = defineMiddleware(async (context, next) => {
  const { cookies, locals, request } = context;

  // 1. Handle Locale
  let locale: 'zh' | 'en' = 'zh'; // Default to zh as per requirement
  const localeCookie = cookies.get('locale')?.value;

  if (localeCookie === 'en' || localeCookie === 'zh') {
    locale = localeCookie;
  } else {
    // Check Accept-Language header if no cookie
    const acceptLanguage = request.headers.get('accept-language');
    if (acceptLanguage && acceptLanguage.startsWith('en')) {
      // Only default to en if strictly detected, otherwise default to zh
      // But requirement say: "If browser is not Chinese, show Chinese (default)" ??
      // Wait, requirement 4.2 says: "WHEN user first visits site and browser language is NOT Chinese THEN Trend Now System SHALL show Chinese interface (Default language)"
      // Requirement 4.1 says: "WHEN user first visits site and browser language IS Chinese THEN ... default show Chinese"
      // So basically always default to Chinese unless user explicitly sets otherwise or maybe I misread?
      // "If browser language is NOT Chinese THEN show Chinese (default language)" - This means ignore browser language if it's not Chinese?
      // Let's re-read: "WHEN User first visits... and browser language is NOT Chinese THEN ... display Chinese interface (default language)"
      // This implies Chinese is the default regardless of browser language, unless we want to support detection.
      // Actually, usually we detect. But if the requirement says default is Chinese, I will stick to 'zh' unless cookie says 'en'.
      // Wait, Requirement 4 says "Support English and Chinese".
      // Let's look at Requirement 4.1 and 4.2 again.
      // 4.1: Browser=ZH -> Show ZH.
      // 4.2: Browser!=ZH -> Show ZH.
      // So default is ALWAYS ZH for new users.
      locale = 'zh';
    }
  }

  locals.locale = locale;

  // 2. Handle Authentication
  const token = cookies.get('session_token')?.value;

  // During a DB outage, skip session validation entirely and proceed as
  // anonymous for this request WITHOUT touching the cookie. Otherwise a
  // transient outage would log every user out (validateSession can't reach the
  // DB -> looks like an invalid token -> cookie deleted).
  if (token && !isDbDown()) {
    const result = await authService.validateSession(token);
    if (result.success) {
      locals.user = result.data;

      // Apply the saved locale preference ONLY when this browser has no explicit
      // cookie yet (e.g. first visit on a new device). When a cookie exists it
      // represents the user's most recent choice — the switch endpoint keeps
      // users.locale in sync — so overriding it here would make language
      // switching impossible for logged-in users (the old behaviour).
      const hasExplicitCookie = localeCookie === 'en' || localeCookie === 'zh';
      const saved = locals.user.locale;
      if (!hasExplicitCookie && (saved === 'en' || saved === 'zh') && saved !== locale) {
        locals.locale = saved;
        cookies.set('locale', saved, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
      }
    } else if (!isDbDown()) {
      // Only clear a genuinely invalid/expired token. If the breaker tripped
      // while validating (DB went down mid-request), keep the cookie so the
      // session survives the outage.
      cookies.delete('session_token', { path: '/' });
    }
  }

  return next();
});

