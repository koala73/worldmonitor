import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const SUPPORTED_LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'ar', 'zh', 'ja', 'tr'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>();

const LOCALE_LOADERS: Record<SupportedLanguage, () => Promise<TranslationDictionary>> = {
  en: async () => (await import('../locales/en.json')).default as TranslationDictionary,
  fr: async () => (await import('../locales/fr.json')).default as TranslationDictionary,
  de: async () => (await import('../locales/de.json')).default as TranslationDictionary,
  es: async () => (await import('../locales/es.json')).default as TranslationDictionary,
  it: async () => (await import('../locales/it.json')).default as TranslationDictionary,
  pl: async () => (await import('../locales/pl.json')).default as TranslationDictionary,
  pt: async () => (await import('../locales/pt.json')).default as TranslationDictionary,
  nl: async () => (await import('../locales/nl.json')).default as TranslationDictionary,
  sv: async () => (await import('../locales/sv.json')).default as TranslationDictionary,
  ru: async () => (await import('../locales/ru.json')).default as TranslationDictionary,
  ar: async () => (await import('../locales/ar.json')).default as TranslationDictionary,
  zh: async () => (await import('../locales/zh.json')).default as TranslationDictionary,
  ja: async () => (await import('../locales/ja.json')).default as TranslationDictionary,
  tr: async () => (await import('../locales/tr.json')).default as TranslationDictionary,
};

const RTL_LANGUAGES = new Set(['ar']);

function normalizeLanguage(lng: string): SupportedLanguage {
  const base = (lng || 'en').split('-')[0]?.toLowerCase() || 'en';
  if (SUPPORTED_LANGUAGE_SET.has(base as SupportedLanguage)) {
    return base as SupportedLanguage;
  }
  return 'en';
}

function applyDocumentDirection(lang: string): void {
  const base = lang.split('-')[0] || lang;
  document.documentElement.setAttribute('lang', base === 'zh' ? 'zh-CN' : base);
  if (RTL_LANGUAGES.has(base)) {
    document.documentElement.setAttribute('dir', 'rtl');
  } else {
    document.documentElement.removeAttribute('dir');
  }
}

async function ensureLanguageLoaded(lng: string): Promise<SupportedLanguage> {
  const normalized = normalizeLanguage(lng);
  if (loadedLanguages.has(normalized) && i18next.hasResourceBundle(normalized, 'translation')) {
    return normalized;
  }

  const translation = await LOCALE_LOADERS[normalized]();
  i18next.addResourceBundle(normalized, 'translation', translation, true, true);
  loadedLanguages.add(normalized);
  return normalized;
}

// Initialize i18n
export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) {
    const currentLanguage = normalizeLanguage(i18next.language || 'en');
    await ensureLanguageLoaded(currentLanguage);
    applyDocumentDirection(i18next.language || currentLanguage);
    return;
  }

  const fallbackTranslation = await LOCALE_LOADERS.en();
  loadedLanguages.add('en');

  await i18next
    .use(LanguageDetector)
    .init({
      resources: {
        en: { translation: fallbackTranslation },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      fallbackLng: 'en',
      debug: import.meta.env.DEV,
      interpolation: {
        escapeValue: false, // not needed for these simple strings
      },
      detection: {
        order: ['localStorage', 'navigator'],
        caches: ['localStorage'],
      },
    });

  const detectedLanguage = await ensureLanguageLoaded(i18next.language || 'en');
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
  const map: Record<string, string> = { en: 'en-US', zh: 'zh-CN', pt: 'pt-BR', ja: 'ja-JP', tr: 'tr-TR' };
  return map[lang] || lang;
}

export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
];
