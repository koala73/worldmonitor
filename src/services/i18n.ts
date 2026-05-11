import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English is always needed as fallback — bundle it eagerly.
import enTranslation from '../locales/en.json';

// Explicit-choice localStorage key. Written ONLY when the user manually picks
// a language via Settings → Language. The default detector's `i18nextLng`
// auto-cache is disabled (caches: []) — auto-detected navigator results no
// longer poison localStorage and override the user's actual browser locale on
// future visits. Anyone whose browser is French now sees French automatically;
// the moment they pick another language explicitly, that choice persists here.
const EXPLICIT_LOCALE_KEY = 'wm-locale-explicit';

const SUPPORTED_LANGUAGES = ['en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'ar', 'zh', 'ja', 'ko', 'ro', 'tr', 'th', 'vi'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>();

// Lazy-load only the locale that's actually needed — all others stay out of the bundle.
const localeModules = import.meta.glob<TranslationDictionary>(
  ['../locales/*.json', '!../locales/en.json'],
  { import: 'default' },
);

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
    const currentLanguage = normalizeLanguage(i18next.language || 'en');
    await ensureLanguageLoaded(currentLanguage);
    applyDocumentDirection(i18next.language || currentLanguage);
    return;
  }

  loadedLanguages.add('en');

  // One-time migration: i18next-browser-languagedetector previously cached
  // every detection result here, so users whose browser is now French but
  // who landed on `en` at any point in the past stayed stuck on English.
  // Drop the legacy auto-cache once. The new explicit-choice key
  // (`wm-locale-explicit`) is preserved untouched.
  try { localStorage.removeItem('i18nextLng'); } catch { /* private mode */ }

  // Custom detector: reads ONLY the explicit-choice key. Returns undefined
  // when unset so detection falls through to navigator. This replaces the
  // default `localStorage` step (which would read i18next's auto-cache key)
  // so a user whose browser is French always lands on French unless they've
  // explicitly chosen otherwise via Settings → Language.
  const detector = new LanguageDetector();
  detector.addDetector({
    name: 'wmExplicit',
    lookup: () => {
      try { return localStorage.getItem(EXPLICIT_LOCALE_KEY) || undefined; }
      catch { return undefined; }
    },
    cacheUserLanguage: () => { /* writes go through explicit changeLanguage() */ },
  });

  await i18next
    .use(detector)
    .init({
      resources: {
        en: { translation: enTranslation as TranslationDictionary },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      fallbackLng: 'en',
      debug: import.meta.env.DEV,
      interpolation: {
        escapeValue: false, // not needed for these simple strings
      },
      detection: {
        order: ['wmExplicit', 'navigator'],
        caches: [], // never auto-write — only changeLanguage() persists
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

// Helper to change language. Persists to the explicit-choice key so the
// detector picks it up on next load instead of falling through to navigator.
//
// To revert to navigator-based auto-detection later (e.g. a future
// "Use browser language" option in Settings → Language), call
// `localStorage.removeItem(EXPLICIT_LOCALE_KEY)` and reload — the next
// initI18n() will fall through `wmExplicit` and detect from navigator.
// We deliberately don't ship that helper now since no UI consumes it.
export async function changeLanguage(lng: string): Promise<void> {
  const normalized = await ensureLanguageLoaded(lng);
  try { localStorage.setItem(EXPLICIT_LOCALE_KEY, normalized); } catch { /* private mode */ }
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
  const map: Record<string, string> = { en: 'en-US', bg: 'bg-BG', cs: 'cs-CZ', el: 'el-GR', zh: 'zh-CN', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', ro: 'ro-RO', tr: 'tr-TR', th: 'th-TH', vi: 'vi-VN' };
  return map[lang] || lang;
}

export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'bg', label: 'Български', flag: '🇧🇬' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'cs', label: 'Čeština', flag: '🇨🇿' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'el', label: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'ro', label: 'Română', flag: '🇷🇴' },
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
];
