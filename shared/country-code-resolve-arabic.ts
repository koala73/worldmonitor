import ARABIC_COUNTRY_NAMES from './country-names-ar.json';

/**
 * Arabic country names for caller-supplied country arguments (#9722).
 *
 * Kept apart from shared/country-code-resolve.ts on purpose: that module ships
 * in the dashboard bundle (src/config/trade-route-lanes.ts), and these names
 * are only needed where an agent passes a country, at the MCP tool layer.
 *
 * The data is generated from CLDR by scripts/build-country-names-ar.mjs and
 * stored as written. Lookup keys come from normalizeArabicCountryToken, which
 * folds the spelling variants Arabic text routinely carries.
 */

/** Same cap as MAX_DESIGNATOR_LENGTH in shared/country-code-resolve.ts. */
const MAX_DESIGNATOR_LENGTH = 128;
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const ISO2_PATTERN = /^[A-Z]{2}$/;

/**
 * Lookup key for an Arabic country name.
 *
 * - NFKD maps presentation forms to base letters and splits hamza and madda
 *   off alef, waw and yaa as combining marks (أ إ آ ؤ ئ).
 * - Harakat, Quranic marks, those combining marks and tatweel are removed.
 * - Letter variants fold: alef wasla to alef, alef maqsura and Persian yeh to
 *   yaa, keheh to kaf, taa marbuta to haa.
 * - Punctuation (Arabic comma, dashes, parentheses) becomes a space.
 * - The article "ال" is dropped from each word of four or more letters, so
 *   "السعودية" and "سعودية" share a key.
 */
export function normalizeArabicCountryToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[ٱ-ٳٵ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => (word.length >= 4 && word.startsWith('ال') ? word.slice(2) : word))
    .join(' ');
}

/**
 * Null-prototype index from normalized name to alpha-2. A key two countries
 * share is dropped rather than given to either: an ambiguous name should be
 * reported unresolved, not answered for the wrong country. The data test keeps
 * the shipped file free of such keys.
 */
const ARABIC_NAME_TO_ISO2: Record<string, string> = (() => {
  const index: Record<string, string> = Object.create(null);
  const ambiguous = new Set<string>();
  for (const [code, names] of Object.entries(ARABIC_COUNTRY_NAMES.names as Record<string, string[]>)) {
    if (!ISO2_PATTERN.test(code)) continue;
    for (const name of names) {
      const key = normalizeArabicCountryToken(name);
      if (!key) continue;
      if (index[key] && index[key] !== code) ambiguous.add(key);
      index[key] = code;
    }
  }
  for (const key of ambiguous) delete index[key];
  return index;
})();

/**
 * The Arabic name to speak or print for an alpha-2 code: the first, CLDR,
 * entry for that code ("الإمارات العربية المتحدة"), or null when the code has
 * no Arabic name. Used by the Arabic spoken mode (#9722).
 */
export function arabicCountryDisplayName(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const iso2 = code.trim().toUpperCase();
  if (!ISO2_PATTERN.test(iso2)) return null;
  const names = (ARABIC_COUNTRY_NAMES.names as Record<string, string[]>)[iso2];
  const name = Array.isArray(names) ? names[0] : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Resolve an Arabic country name to alpha-2, or null. Latin input is never matched. */
export function resolveArabicCountryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_DESIGNATOR_LENGTH || !ARABIC_SCRIPT.test(trimmed)) return null;
  const hit = ARABIC_NAME_TO_ISO2[normalizeArabicCountryToken(trimmed)];
  return typeof hit === 'string' && ISO2_PATTERN.test(hit) ? hit : null;
}
