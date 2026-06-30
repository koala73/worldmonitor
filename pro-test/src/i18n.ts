import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';

type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGES = ['en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'ar', 'fa', 'zh', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
const SUPPORTED_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>(['en']);

const RTL_LANGUAGES = new Set(['ar', 'fa']);

const localeModules = import.meta.glob<TranslationDictionary>(
  ['./locales/*.json', '!./locales/en.json'],
  { import: 'default' },
);

function normalize(lng: string): SupportedLanguage {
  const base = (lng || 'en').split('-')[0]?.toLowerCase() || 'en';
  return SUPPORTED_SET.has(base as SupportedLanguage) ? base as SupportedLanguage : 'en';
}

async function ensureLoaded(lng: string): Promise<SupportedLanguage> {
  const n = normalize(lng);
  if (loadedLanguages.has(n)) return n;
  const loader = localeModules[`./locales/${n}.json`];
  const translation = loader ? await loader() : en as TranslationDictionary;
  i18next.addResourceBundle(n, 'translation', translation, true, true);
  loadedLanguages.add(n);
  return n;
}

// IETF BCP 47 region codes for og:locale (so social-card renderers pick the
// right preview language). Falls back to ${lang}_${LANG.toUpperCase()} for
// anything not in this map.
//
// Mirror of ogLocaleMap in src/App.ts. The two packages have separate Vite
// roots and bundlers and can't share an import — keep the tables aligned by
// hand when adding a locale here OR there.
const OG_LOCALE: Record<string, string> = {
  en: 'en_US', bg: 'bg_BG', cs: 'cs_CZ', fr: 'fr_FR', de: 'de_DE', el: 'el_GR',
  es: 'es_ES', hr: 'hr_HR', hu: 'hu_HU', it: 'it_IT', pl: 'pl_PL', pt: 'pt_BR',
  nl: 'nl_NL', sv: 'sv_SE', ru: 'ru_RU', ar: 'ar_SA', fa: 'fa_IR', zh: 'zh_CN',
  ja: 'ja_JP', ko: 'ko_KR', ro: 'ro_RO', tr: 'tr_TR', th: 'th_TH', vi: 'vi_VN',
  hi: 'hi_IN',
};

function applyMetaTags(prefix = 'meta'): void {
  const title = i18next.t(`${prefix}.title`);
  const desc = i18next.t(`${prefix}.description`);
  const ogTitle = i18next.t(`${prefix}.ogTitle`);
  const ogDesc = i18next.t(`${prefix}.ogDescription`);
  const base = currentLanguageBase();

  document.title = title;
  const set = (sel: string, val: string) => {
    const el = document.querySelector(sel);
    if (el) el.setAttribute('content', val);
  };
  set('meta[name="description"]', desc);
  set('meta[property="og:title"]', ogTitle);
  set('meta[property="og:description"]', ogDesc);
  set('meta[property="og:locale"]', OG_LOCALE[base] || `${base}_${base.toUpperCase()}`);
  set('meta[name="twitter:title"]', ogTitle);
  set('meta[name="twitter:description"]', ogDesc);
}

// Marketing site has no language switcher — querystring (`?lang=fr`) is the
// only manual override. So detection order is querystring → navigator. We
// intentionally drop the default `localStorage` step + auto-cache: a stale
// `i18nextLng=en` stamp from any earlier visit would otherwise pin a French
// browser to English forever and silently bury the localized copy we ship.
//
// CONSEQUENCE: the `?lang=` querystring is EPHEMERAL — it does not persist
// across in-page navigations that strip the search string. The hreflang
// `?lang=XX` URLs in <head> are the canonical shareable/bookmarkable
// locale-stable links. If anyone ever adds in-page links from /pro that
// drop ?lang=, they need to either propagate the param or surface a
// language switcher; otherwise the recipient lands on browser-default.
export async function initI18n(options?: { metaPrefix?: string }): Promise<void> {
  const metaPrefix = options?.metaPrefix ?? 'meta';
  if (i18next.isInitialized) return;
  // One-time migration: drop the legacy `i18nextLng` auto-cache so users
  // whose browser is e.g. French but who got pinned to `en` on any past
  // visit get auto-recovered to navigator-driven detection.
  try { localStorage.removeItem('i18nextLng'); } catch { /* private mode */ }
  await i18next.use(LanguageDetector).init({
    resources: { en: { translation: en as TranslationDictionary } },
    supportedLngs: [...SUPPORTED_LANGUAGES],
    nonExplicitSupportedLngs: true,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    detection: { order: ['querystring', 'navigator'], lookupQuerystring: 'lang', caches: [] },
  });
  const detected = await ensureLoaded(i18next.language || 'en');
  if (detected !== 'en') await i18next.changeLanguage(detected);
  const base = (i18next.language || detected).split('-')[0] || 'en';
  document.documentElement.setAttribute('lang', base === 'zh' ? 'zh-CN' : base);
  if (RTL_LANGUAGES.has(base)) document.documentElement.setAttribute('dir', 'rtl');
  applyMetaTags(metaPrefix);
}

export async function initStaticI18n(): Promise<void> {
  if (i18next.isInitialized) {
    if (currentLanguageBase() !== 'en') {
      await i18next.changeLanguage('en');
    }
    return;
  }
  await i18next.init({
    resources: { en: { translation: en as TranslationDictionary } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
}

export function currentLanguageBase(): string {
  return (i18next.language || 'en').split('-')[0] || 'en';
}

export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

/**
 * Look up a translation that's expected to be an array (e.g. localized
 * pricing tier feature lists). Returns null when the key resolves to a
 * non-array (typical when the locale hasn't translated this entry yet) so
 * callers can fall back to their English source-of-truth without leaking
 * the raw key as a string.
 */
export function tArray(key: string): string[] | null {
  const value: unknown = i18next.t(key, { returnObjects: true, defaultValue: null });
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string') ? value : null;
}
