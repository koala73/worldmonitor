export const UI_LANGUAGES: readonly ['en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl', 'sv', 'ru', 'uk', 'ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi', 'sw'];
export type UiLanguage = typeof UI_LANGUAGES[number];
export const UI_LANGUAGE_SET: ReadonlySet<string>;
export const RTL_UI_LANGUAGES: readonly ['ar', 'fa'];
/** English names, used in LLM prompts. Same content as TRANSLATE_LANGUAGE_NAMES. */
export const UI_LANGUAGE_NAMES: Readonly<Record<UiLanguage, string>>;
export function isUiLanguage(value: unknown): value is UiLanguage;
/** override ?? explicit UI choice ?? 'en'. Unknown values are ignored. */
export function resolveBriefLanguage(input: { uiLanguage?: string | null; briefLanguage?: string | null }): UiLanguage;
