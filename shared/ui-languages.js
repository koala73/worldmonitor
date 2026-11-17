/**
 * The dashboard's UI languages, shared by the browser, Convex and the
 * server so the brief language (epic #10877) and LLM prompt names use one
 * list. Pure data and functions: no DOM, Node or Convex imports.
 *
 * Order matches SUPPORTED_LANGUAGES in src/services/i18n.ts, which stays a
 * literal (scripts regex-parse it); tests/ui-languages.test.mjs pins them.
 */

/** @type {readonly ['en','bg','cs','fr','de','el','es','hr','hu','it','pl','pt','nl','sv','ru','uk','ar','fa','zh','zh-TW','ja','ko','ro','tr','th','vi','hi','sw']} */
export const UI_LANGUAGES = Object.freeze([
  'en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl', 'sv',
  'ru', 'uk', 'ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi', 'sw',
]);

/** @type {ReadonlySet<string>} */
export const UI_LANGUAGE_SET = new Set(UI_LANGUAGES);

/** @type {readonly ['ar','fa']} */
export const RTL_UI_LANGUAGES = Object.freeze(['ar', 'fa']);

/** True for languages written right to left (ar, fa). */
export function isRtlLanguage(code) {
  return RTL_UI_LANGUAGES.includes(code);
}

/** Value for the HTML dir attribute. */
export function htmlDirFor(code) {
  return isRtlLanguage(code) ? 'rtl' : 'ltr';
}

/** English names, used in LLM prompts (a bare code like `ja` is not enough). */
export const UI_LANGUAGE_NAMES = Object.freeze({
  en: 'English', bg: 'Bulgarian', cs: 'Czech', fr: 'French', de: 'German', el: 'Greek',
  es: 'Spanish', hr: 'Croatian', hu: 'Hungarian', it: 'Italian', pl: 'Polish',
  pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish', sw: 'Swahili', ru: 'Russian',
  uk: 'Ukrainian', ar: 'Arabic', fa: 'Persian', zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese', ja: 'Japanese', ko: 'Korean', ro: 'Romanian',
  tr: 'Turkish', th: 'Thai', vi: 'Vietnamese', hi: 'Hindi',
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUiLanguage(value) {
  return typeof value === 'string' && UI_LANGUAGE_SET.has(value);
}

/**
 * The brief language: the notification-settings override, else the explicit
 * Settings choice, else English. Values outside the list are ignored.
 *
 * @param {{ uiLanguage?: string | null; briefLanguage?: string | null }} input
 * @returns {string}
 */
export function resolveBriefLanguage(input) {
  if (isUiLanguage(input?.briefLanguage)) return /** @type {string} */ (input.briefLanguage);
  if (isUiLanguage(input?.uiLanguage)) return /** @type {string} */ (input.uiLanguage);
  return 'en';
}

/** BCP 47 tag for the HTML lang attribute and Intl: zh → "zh-CN", zh-TW → "zh-TW", others unchanged. */
export function htmlLangFor(code) {
  return code === 'zh' ? 'zh-CN' : code;
}

const NO_SUBSET_LANGUAGES = new Set(['ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'hi', 'th']);

/** Languages whose script the magazine font subsets cover. */
export const BRIEF_SUBSET_LANGUAGES = Object.freeze(UI_LANGUAGES.filter((code) => !NO_SUBSET_LANGUAGES.has(code)));

const SCRIPT_CLASSES = {
  bg: 'cyrillic', ru: 'cyrillic', uk: 'cyrillic',
  el: 'greek',
  zh: 'cjk', 'zh-TW': 'cjk', ja: 'cjk', ko: 'cjk',
  ar: 'arabic', fa: 'arabic',
  hi: 'devanagari',
  th: 'thai',
};

/** Script class used for typography switches. */
export function scriptClassFor(code) {
  return SCRIPT_CLASSES[code] ?? 'latin';
}
