export const UI_LANGUAGES: readonly ['en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'uk', 'ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi', 'sw'];
export type UiLanguage = typeof UI_LANGUAGES[number];
export const UI_LANGUAGE_SET: ReadonlySet<string>;
export const RTL_UI_LANGUAGES: readonly ['ar', 'fa'];
/** True for languages written right to left (ar, fa). */
export function isRtlLanguage(code: string): boolean;
/** Value for the HTML dir attribute. */
export function htmlDirFor(code: string): 'rtl' | 'ltr';
/** English names, used in LLM prompts. Same content as TRANSLATE_LANGUAGE_NAMES. */
export const UI_LANGUAGE_NAMES: Readonly<Record<UiLanguage, string>>;
export function isUiLanguage(value: unknown): value is UiLanguage;
/** override ?? explicit UI choice ?? 'en'. Unknown values are ignored. */
export function resolveBriefLanguage(input: { uiLanguage?: string | null; briefLanguage?: string | null }): UiLanguage;
/** BCP 47 tag for the HTML lang attribute and Intl: zh → "zh-CN", zh-TW → "zh-TW", others unchanged. */
export function htmlLangFor(code: string): string;
/** Languages whose script the magazine subsets cover. */
export const BRIEF_SUBSET_LANGUAGES: readonly string[];
/** Script class used for typography switches. */
export function scriptClassFor(code: string): 'latin' | 'cyrillic' | 'greek' | 'cjk' | 'arabic' | 'devanagari' | 'thai';
