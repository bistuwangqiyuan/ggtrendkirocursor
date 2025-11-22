import { defineMiddleware } from 'astro:middleware';
import { authService } from './lib/services/auth';

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
  
  if (token) {
    const result = await authService.validateSession(token);
    if (result.success) {
      locals.user = result.data;
      
      // If user has a saved locale preference, use it
      if (locals.user.locale && locals.user.locale !== locale) {
        locals.locale = locals.user.locale;
        // Update cookie to match user preference
        cookies.set('locale', locals.user.locale, { path: '/', maxAge: 60 * 60 * 24 * 365 });
      }
    } else {
      // Invalid token (expired or wrong), clean it up
      cookies.delete('session_token', { path: '/' });
    }
  }

  return next();
});

