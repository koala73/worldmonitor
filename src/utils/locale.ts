/** Canonical, SSR/Node-safe Japanese-locale check.
 * Reads document.documentElement.lang (mirror of the active i18n language,
 * kept in sync by i18n's applyDocumentDirection). Avoids importing the i18n
 * module so it stays usable in Node test environments. */
export function isJapaneseLocale(): boolean {
  if (typeof document === 'undefined') return false;
  const lang = document.documentElement?.lang ?? '';
  return lang.split('-')[0]?.toLowerCase() === 'ja';
}
