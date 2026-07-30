/**
 * Country-name → ISO2 normalizer backed by the repo's shared gazetteer
 * (`shared/country-names.json`, lowercase-name → uppercase-ISO2).
 *
 * The cron payload has `country` as a free-form string that may be:
 *   - already an ISO2 code ("US", "IR")
 *   - a full name ("United States", "Iran")
 *   - a multi-word name with the connector lowercase ("south korea")
 *   - the sentinel "Global" when no country applies
 *     (shared/brief-filter.js:135 fallback)
 *   - empty / unknown / garbage
 *
 * A null return tells the caller "no country-specific context applies"
 * — the analyst path still runs, just on world-level context. This is
 * NOT an error condition for sentinel values like "Global".
 */

import COUNTRY_NAMES_RAW from '../../shared/country-names.json';

const COUNTRY_NAMES = COUNTRY_NAMES_RAW as Record<string, string>;

// Build the valid-ISO2 set once so pass-through values can be
// validated against the authoritative gazetteer.
const ISO2_SET = new Set<string>(Object.values(COUNTRY_NAMES));

export function normalizeCountryToIso2(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // "Global" is the composer's non-country fallback
  // (shared/brief-filter.js:135). Map to null without treating as error.
  if (trimmed.toLowerCase() === 'global') return null;

  // ISO2 pass-through, but only if the gazetteer knows about it.
  // "USA" is intentionally rejected here — it's not in country-names.json
  // (the map uses "united states" → "US"), and accepting it would
  // bypass the gazetteer's source-of-truth discipline.
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    return ISO2_SET.has(upper) ? upper : null;
  }

  // Full-name lookup, case-insensitive.
  const lookup = COUNTRY_NAMES[trimmed.toLowerCase()];
  return typeof lookup === 'string' ? lookup : null;
}
