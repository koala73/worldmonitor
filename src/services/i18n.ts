import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { I18N_CONFIG } from '../config/i18n-config';

// English is always needed as fallback — bundle it eagerly.
import enTranslation from '../locales/en.json';

const SUPPORTED_LANGUAGES = I18N_CONFIG.SUPPORTED_LOCALES.map(loc => loc.code);
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<string>();

// Lazy-load only the locale that's actually needed — all others stay out of the bundle.
const localeModules = import.meta.glob<TranslationDictionary>(
  ['../locales/*.json', '!../locales/en.json'],
  { import: 'default' },
);

const RTL_LANGUAGES = new Set<string>(I18N_CONFIG.SUPPORTED_LOCALES.filter(loc => loc.dir === 'rtl').map(loc => loc.code));

function normalizeLanguage(lng: string): SupportedLanguage {
  const base = (lng || I18N_CONFIG.DEFAULT_LANGUAGE).split('-')[0]?.toLowerCase() || I18N_CONFIG.DEFAULT_LANGUAGE;
  if (SUPPORTED_LANGUAGE_SET.has(base)) {
    return base as SupportedLanguage;
  }
  return 'en';
}

function applyDocumentDirection(lang: string): void {
  const base = lang.split('-')[0] || lang;
  document.documentElement.setAttribute('lang', base === 'zh' ? 'zh-CN' : base);
  if (RTL_LANGUAGES.has(base)) {
    document.documentElement.setAttribute('dir', 'rtl');
    document.body.classList.add('dir-rtl');
  } else {
    document.documentElement.removeAttribute('dir');
    document.body.classList.remove('dir-rtl');
  }
}

async function ensureLanguageLoaded(lng: string): Promise<SupportedLanguage> {
  const normalized = normalizeLanguage(lng);
  if (loadedLanguages.has(normalized) && i18next.hasResourceBundle(normalized, 'translation')) {
    return normalized;
  }

  let translation: TranslationDictionary;
  if (normalized === 'en') {
    translation = enTranslation as TranslationDictionary;
  } else {
    const loader = localeModules[`../locales/${normalized}.json`];
    if (!loader) {
      console.warn(`No locale file for "${normalized}", falling back to English`);
      translation = enTranslation as TranslationDictionary;
    } else {
      translation = await loader();
    }
  }

  i18next.addResourceBundle(normalized, 'translation', translation, true, true);
  loadedLanguages.add(normalized);
  return normalized;
}

// Initialize i18n
export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) {
    const currentLanguage = normalizeLanguage(i18next.language || I18N_CONFIG.DEFAULT_LANGUAGE);
    await ensureLanguageLoaded(currentLanguage);
    applyDocumentDirection(i18next.language || currentLanguage);
    return;
  }

  loadedLanguages.add('en');

  await i18next
    .use(LanguageDetector)
    .init({
      resources: {
        en: { translation: enTranslation as TranslationDictionary },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      fallbackLng: I18N_CONFIG.FALLBACK_LANGUAGE,
      debug: import.meta.env.DEV,
      interpolation: {
        escapeValue: false, // not needed for these simple strings
      },
      detection: {
        order: ['localStorage', 'navigator'],
        caches: ['localStorage'],
      },
    });

  const detectedLanguage = await ensureLanguageLoaded(i18next.language || I18N_CONFIG.DEFAULT_LANGUAGE);
  if (detectedLanguage !== 'en') {
    // Re-trigger translation resolution now that the detected bundle is loaded.
    await i18next.changeLanguage(detectedLanguage);
  }

  applyDocumentDirection(i18next.language || detectedLanguage);
}

// Helper to translate
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

// Helper to change language
export async function changeLanguage(lng: string): Promise<void> {
  const normalized = await ensureLanguageLoaded(lng);
  await i18next.changeLanguage(normalized);
  applyDocumentDirection(normalized);
  window.location.reload(); // Simple reload to update all components for now
}

// Helper to get current language (normalized to short code)
export function getCurrentLanguage(): string {
  const lang = i18next.language || 'en';
  return lang.split('-')[0]!;
}

export function isRTL(): boolean {
  return RTL_LANGUAGES.has(getCurrentLanguage());
}

export function getLocale(): string {
  const lang = getCurrentLanguage();
  const map: Record<string, string> = { en: 'en-US', el: 'el-GR', zh: 'zh-CN', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', tr: 'tr-TR', th: 'th-TH', vi: 'vi-VN' };
  return map[lang] || lang;
}

export const LANGUAGES = [...I18N_CONFIG.SUPPORTED_LOCALES];

/**
 * Resolves a country code (e.g., "US", "USA") or fallback name to a localized country name.
 * Uses native Intl.DisplayNames to avoid shipping a massive territory dictionary.
 */
export function getLocalizedCountryName(codeOrName: string): string {
  if (!codeOrName) return '';
  const lang = getCurrentLanguage();

  // Clean up input
  let code = codeOrName.trim().toUpperCase();

  // If we receive a 3-letter code and know its 2-letter equivalent, we can convert.
  // Standard Intl.DisplayNames expects region subtags (ISO-3166-1 alpha-2).
  // E.g., USA -> US, GBR -> GB. Here is a tiny map for common ones we use:
  const alpha3To2: Record<string, string> = {
    'USA': 'US', 'GBR': 'GB', 'CHN': 'CN', 'RUS': 'RU', 'FRA': 'FR',
    'DEU': 'DE', 'JPN': 'JP', 'IND': 'IN', 'BRA': 'BR', 'CAN': 'CA',
    'IRN': 'IR', 'IRQ': 'IQ', 'ISR': 'IL', 'SYR': 'SY', 'SAU': 'SA'
  };

  if (code.length === 3 && alpha3To2[code]) {
    code = alpha3To2[code];
  }

  // If it's strictly a 2-letter code, try to natively translate it
  if (code.length === 2) {
    try {
      const displayNames = new Intl.DisplayNames([lang], { type: 'region' });
      const localized = displayNames.of(code);
      if (localized) return localized;
    } catch {
      // Ignore if unsupported or invalid
    }
  }

  // If it's a known english name or unmatched code, fall back to the raw string
  return codeOrName;
}
