import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';

type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGES = ['en', 'ar', 'bg', 'cs', 'de', 'el', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'vi', 'zh'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
const SUPPORTED_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>(['en']);

const RTL_LANGUAGES = new Set(['ar']);

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

export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) return;
  await i18next.use(LanguageDetector).init({
    resources: { en: { translation: en as TranslationDictionary } },
    supportedLngs: [...SUPPORTED_LANGUAGES],
    nonExplicitSupportedLngs: true,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    detection: { order: ['querystring', 'localStorage', 'navigator'], lookupQuerystring: 'lang', caches: ['localStorage'] },
  });
  const detected = await ensureLoaded(i18next.language || 'en');
  if (detected !== 'en') await i18next.changeLanguage(detected);
  const base = (i18next.language || detected).split('-')[0] || 'en';
  document.documentElement.setAttribute('lang', base === 'zh' ? 'zh-CN' : base);
  if (RTL_LANGUAGES.has(base)) document.documentElement.setAttribute('dir', 'rtl');
}

export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}
