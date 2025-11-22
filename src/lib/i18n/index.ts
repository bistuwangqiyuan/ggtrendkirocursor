import { zh } from './zh';
import { en } from './en';

export type Locale = 'zh' | 'en';
export type Translations = typeof zh;

const translations: Record<Locale, Translations> = { zh, en };

export function getTranslations(locale: Locale): Translations {
  return translations[locale] || translations.zh;
}

// Helper to get nested keys safely
export function t(locale: Locale, key: string): string {
  const keys = key.split('.');
  let value: any = getTranslations(locale);

  for (const k of keys) {
    value = value?.[k];
  }

  return typeof value === 'string' ? value : key;
}

