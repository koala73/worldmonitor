/**
 * The country-headline matcher the country panel uses.
 *
 * Extracted from `CountryIntelManager` (src/app/country-intel.ts) in #7526 so
 * the country-coverage RPC decides "is this headline about this country?" the
 * same way the panel does. `server/` may not import `src/app/`
 * (scripts/lint-boundaries.mjs), so the rules live here and both surfaces
 * import them. `CountryIntelManager` keeps its static methods as thin
 * delegates, so no UI call site changed.
 *
 * DELIBERATELY NOT `shared/country-mention.js`. That module is the one matcher
 * for grounding a country BRIEF on the news digest: it covers all ~194
 * countries via ICU display names, demonyms and exclusions, and answers a plain
 * "is this country mentioned?". This module answers a different question — "is
 * this headline PRIMARILY about this country?" — using a curated alias list for
 * the ~23 countries the panel tracks plus a first-mention precedence rule that
 * hands "Israel strikes Iran" to Israel, not Iran. Redesigning the panel's
 * matching is an explicit non-goal of #7526, so the two coexist on purpose.
 * Before adding a third, extend one of these.
 */

/**
 * Curated aliases per country: names, demonyms, capitals and the proper nouns
 * that stand in for the state in a headline. A country absent from this map
 * falls back to its display name (see `getCountrySearchTerms`).
 */
export const COUNTRY_ALIASES: Record<string, string[]> = {
  IL: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'netanyahu', 'idf', 'west bank', 'tel aviv', 'jerusalem'],
  IR: ['iran', 'iranian', 'tehran', 'persian', 'irgc', 'khamenei'],
  RU: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'ukraine war'],
  UA: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'zelenskyy'],
  CN: ['china', 'chinese', 'beijing', 'taiwan strait', 'south china sea', 'xi jinping'],
  TW: ['taiwan', 'taiwanese', 'taipei'],
  KP: ['north korea', 'pyongyang', 'kim jong'],
  KR: ['south korea', 'seoul'],
  SA: ['saudi', 'riyadh', 'mbs'],
  SY: ['syria', 'syrian', 'damascus', 'assad'],
  YE: ['yemen', 'houthi', 'sanaa'],
  IQ: ['iraq', 'iraqi', 'baghdad'],
  AF: ['afghanistan', 'afghan', 'kabul', 'taliban'],
  PK: ['pakistan', 'pakistani', 'islamabad'],
  IN: ['india', 'indian', 'new delhi', 'modi'],
  EG: ['egypt', 'egyptian', 'cairo', 'suez'],
  LB: ['lebanon', 'lebanese', 'beirut'],
  TR: ['turkey', 'turkish', 'ankara', 'erdogan', 'türkiye'],
  US: ['united states', 'US', 'u.s.', 'u.s', 'american', 'washington', 'pentagon', 'white house'],
  GB: ['united kingdom', 'british', 'london', 'uk '],
  FR: ['france', 'french', 'paris'],
  BR: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro'],
  AE: ['united arab emirates', 'uae', 'emirati', 'dubai', 'abu dhabi'],
};

const otherCountryTermsCache = new Map<string, string[]>();

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Index of the first whole-word occurrence of `term` in `text`, or -1.
 *
 * Plain two/three-letter country acronyms are case-sensitive so US does not
 * match the pronoun "us". Dotted forms such as U.S. are unambiguous and remain
 * case-insensitive with every full-name and demonym alias.
 */
export function countryTermIndex(text: string, term: string): number {
  const trimmedTerm = term.trim();
  if (!trimmedTerm) return -1;
  const caseSensitive = /^[A-Z]{2,3}$/.test(trimmedTerm);
  const matchText = caseSensitive ? text : text.toLowerCase();
  const matchTerm = caseSensitive ? trimmedTerm : trimmedTerm.toLowerCase();
  const match = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(matchTerm)}(?=$|[^A-Za-z0-9])`).exec(matchText);
  return match ? match.index + (match[1] ?? '').length : -1;
}

/** Earliest index at which any of `terms` appears in `text`, or `Infinity`. */
export function firstMentionPosition(text: string, terms: readonly string[]): number {
  let earliest = Infinity;
  for (const term of terms) {
    const idx = countryTermIndex(text, term);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return earliest;
}

/** Every alias belonging to a country other than `code`. Memoized per code. */
export function getOtherCountryTerms(code: string): string[] {
  const normalizedCode = code.toUpperCase();
  const cached = otherCountryTermsCache.get(normalizedCode);
  if (cached) return cached;

  const dedup = new Set<string>();
  Object.entries(COUNTRY_ALIASES).forEach(([countryCode, aliases]) => {
    if (countryCode === normalizedCode) return;
    aliases.forEach((alias) => {
      const trimmed = alias.trim();
      if (trimmed.length > 0) dedup.add(trimmed);
    });
  });

  const terms = [...dedup];
  otherCountryTermsCache.set(normalizedCode, terms);
  return terms;
}

/**
 * Terms that stand for this country in a headline: the curated aliases when the
 * country has them, otherwise its resolved display name. Returns `[]` when the
 * caller could only supply the ISO code as the name — a bare code is too
 * collision-prone to search on.
 */
export function getCountrySearchTerms(country: string, code: string): string[] {
  const aliases = COUNTRY_ALIASES[code.toUpperCase()];
  if (aliases) return aliases;
  if (/^[A-Z]{2}$/i.test(country.trim())) return [];
  return [country];
}

/**
 * True when `title` is primarily about this country: the country is mentioned,
 * and no OTHER tracked country is mentioned earlier. "Israel strikes Iran"
 * belongs to Israel; "Iran retaliates against Israel" belongs to Iran.
 */
export function isCountryHeadline(title: string, country: string, code: string): boolean {
  const searchTerms = getCountrySearchTerms(country, code);
  const otherCountryTerms = getOtherCountryTerms(code);
  const ourPos = firstMentionPosition(title, searchTerms);
  const otherPos = firstMentionPosition(title, otherCountryTerms);
  return ourPos !== Infinity && (otherPos === Infinity || ourPos <= otherPos);
}
