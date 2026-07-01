import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { readQueryLanguage, stripQueryLanguage } from '@/utils/i18n-url';

// Keep only first-paint English strings in the entry chunk. The full English
// dictionary is loaded through localeModules so it can split like other locales.
import enShellTranslation from '../locales/en.shell.json';

// Explicit-choice localStorage key. Written ONLY when the user manually picks
// a language via Settings → Language. The default detector's `i18nextLng`
// auto-cache is disabled (caches: []) — auto-detected navigator results no
// longer poison localStorage and override the user's actual browser locale on
// future visits. Anyone whose browser is French now sees French automatically;
// the moment they pick another language explicitly, that choice persists here.
const EXPLICIT_LOCALE_KEY = 'wm-locale-explicit';

const SUPPORTED_LANGUAGES = ['en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'ar', 'fa', 'zh', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
type TranslationDictionary = Record<string, unknown>;

// Window event fired once the full (non-shell) dictionary for the active
// language has been merged into i18next. The App listens for it to heal any
// raw-key placeholders rendered during the shell-only first-paint window.
// Shared constant so producer (here) and consumer (App.ts) can't drift.
export const I18N_RESOURCES_LOADED_EVENT = 'wm:i18n:resources-loaded';
export interface I18nResourcesLoadedDetail {
  language: SupportedLanguage;
}

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>();

// Lazy-load only the locale that's actually needed — all others stay out of the bundle.
const localeModules = import.meta.glob<TranslationDictionary>(
  ['../locales/*.json', '!../locales/en.shell.json'],
  { import: 'default' },
);

const RTL_LANGUAGES = new Set(['ar', 'fa']);

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
  const loader = localeModules[`../locales/${normalized}.json`];
  if (!loader) {
    console.warn(`No locale file for "${normalized}", falling back to English`);
    const englishLoader = localeModules['../locales/en.json'];
    if (englishLoader) {
      translation = await englishLoader();
    } else {
      // Last-resort fallback: install the shell-only subset under this code.
      // This is a degraded bundle (first-paint keys only); log it so the
      // permanent partial state isn't silently indistinguishable from success.
      console.warn(`Full English locale unavailable; installing shell-only bundle for "${normalized}"`);
      translation = enShellTranslation as TranslationDictionary;
    }
  } else {
    translation = await loader();
  }

  i18next.addResourceBundle(normalized, 'translation', translation, true, true);
  loadedLanguages.add(normalized);
  return normalized;
}

function notifyLanguageResourcesLoaded(language: SupportedLanguage): void {
  if (normalizeLanguage(i18next.language || 'en') !== language) return;

  const dispatch = (): void => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<I18nResourcesLoadedDetail>(I18N_RESOURCES_LOADED_EVENT, { detail: { language } }),
      );
    }
  };

  // The full bundle is already registered (addResourceBundle ran inside
  // ensureLanguageLoaded), so t() resolves correctly regardless of what happens
  // next. We still re-run changeLanguage to refresh i18next's resolved store and
  // notify any future `languageChanged` subscribers — there are none today, so
  // the DOM healer fired by the event below is the actual repair path. Dispatch
  // in `finally` so the event (and heal) lands AFTER changeLanguage settles,
  // never racing a half-applied change, and still fires if it rejects.
  void i18next.changeLanguage(i18next.language || language)
    .catch((error) => {
      console.warn(`Failed to refresh i18next after loading "${language}" locale`, error);
    })
    .finally(dispatch);
}

const ENGLISH_PRELOAD_MAX_ATTEMPTS = 3;
const ENGLISH_PRELOAD_BASE_DELAY_MS = 2000;

function preloadEnglishTranslation(attempt = 0): void {
  if (loadedLanguages.has('en')) return;
  void ensureLanguageLoaded('en')
    .then((language) => notifyLanguageResourcesLoaded(language))
    .catch((error) => {
      // English now lives in its own lazy chunk. If that chunk fails, the eager
      // shell still renders first paint, but non-shell English keys stay raw for
      // the rest of the session — for the majority (English) cohort. Retry with
      // bounded backoff, then once more when connectivity returns, and surface
      // the failure to Sentry so the degraded state isn't silent.
      console.warn(`Failed to preload full English locale (attempt ${attempt + 1})`, error);
      enqueueSentryCall((s) => s.captureException(error, {
        tags: { module: 'i18n', locale: 'en', action: 'preloadEnglishTranslation' },
        level: 'warning',
      }));

      if (loadedLanguages.has('en')) return;
      if (attempt + 1 < ENGLISH_PRELOAD_MAX_ATTEMPTS) {
        const delayMs = ENGLISH_PRELOAD_BASE_DELAY_MS * 2 ** attempt;
        setTimeout(() => preloadEnglishTranslation(attempt + 1), delayMs);
      } else if (typeof window !== 'undefined') {
        window.addEventListener('online', () => preloadEnglishTranslation(0), { once: true });
      }
    });
}

// Initialize i18n
export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) {
    const currentLanguage = normalizeLanguage(i18next.language || 'en');
    await ensureLanguageLoaded(currentLanguage);
    applyDocumentDirection(i18next.language || currentLanguage);
    return;
  }

  // One-time migration: i18next-browser-languagedetector previously cached
  // every detection result here, so users whose browser is now French but
  // who landed on `en` at any point in the past stayed stuck on English.
  // Drop the legacy auto-cache once. The new explicit-choice key
  // (`wm-locale-explicit`) is preserved untouched.
  try { localStorage.removeItem('i18nextLng'); } catch { /* private mode */ }

  // Custom detectors:
  // - wmQuery honors shareable/SEO language URLs such as /dashboard?lang=fa.
  // - wmExplicit reads ONLY the explicit-choice key. Returns undefined when
  //   unset so detection falls through to navigator. This replaces the default
  //   `localStorage` step (which would read i18next's auto-cache key) so a user
  //   whose browser is French always lands on French unless they've explicitly
  //   chosen otherwise via Settings → Language.
  const detector = new LanguageDetector();
  detector.addDetector({
    name: 'wmQuery',
    lookup: () => readQueryLanguage(window.location.href),
    cacheUserLanguage: () => { /* URL language is explicit per request, not persisted */ },
  });
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
        en: { translation: enShellTranslation as TranslationDictionary },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      fallbackLng: 'en',
      debug: import.meta.env.DEV,
      interpolation: {
        escapeValue: false, // not needed for these simple strings
      },
      detection: {
        order: ['wmQuery', 'wmExplicit', 'navigator'],
        caches: [], // never auto-write — only changeLanguage() persists
      },
    });

  const detectedLanguage = normalizeLanguage(i18next.language || 'en');
  if (detectedLanguage === 'en') {
    preloadEnglishTranslation();
  } else {
    await Promise.all([
      ensureLanguageLoaded(detectedLanguage),
      ensureLanguageLoaded('en'),
    ]);
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
  // Drop any `?lang=` from the URL before reloading. `wmQuery` is first in
  // detection.order, so a stale query param would out-rank the explicit choice
  // we just persisted and silently revert the language on this very reload.
  try {
    const stripped = stripQueryLanguage(window.location.href);
    if (stripped !== window.location.href) {
      window.history.replaceState(window.history.state, '', stripped);
    }
  } catch { /* history unavailable */ }
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
  const map: Record<string, string> = { en: 'en-US', bg: 'bg-BG', cs: 'cs-CZ', el: 'el-GR', fa: 'fa-IR', zh: 'zh-CN', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', ro: 'ro-RO', tr: 'tr-TR', th: 'th-TH', vi: 'vi-VN', hi: 'hi-IN' };
  return map[lang] || lang;
}

export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'bg', label: 'Български', flag: '🇧🇬' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'fa', label: 'فارسی', flag: '🇮🇷' },
  { code: 'cs', label: 'Čeština', flag: '🇨🇿' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'el', label: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'hr', label: 'Hrvatski', flag: '🇭🇷' },
  { code: 'hu', label: 'Magyar', flag: '🇭🇺' },
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
  { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
];
