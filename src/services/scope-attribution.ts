import {
  countryMentionTerms,
  localizedCountryNames,
  mentionsCountry,
  mentionsLocalizedCountry,
  type CountryMentionTerms,
} from '../../shared/country-mention.js';
import { resolveCountryCode } from '../../shared/country-code-resolve';
import { SCOPE_ISO2_CODES } from '../../shared/tab-scope';
import { MONITORED_AIRPORTS } from '@/config/airports';

/**
 * Which country an item is about, for the dashboard focus (#10453).
 *
 * Headlines go through `shared/country-mention.js`, the repository's one
 * all-countries name matcher (names, aliases, case-sensitive demonyms,
 * exclusions such as "South Sudan" never naming Sudan). No new matcher here.
 *
 * Limits a caller should know:
 *   - A headline is attributed by the names it contains. A story about a
 *     country that never names it has no country.
 *   - Non-English headlines are checked against the focused countries' names
 *     in their own language, but the "is it about some OTHER country?" scan
 *     is English-only. A French headline about Germany therefore counts as
 *     "no country", not "hidden": the safe side, since those are counted and
 *     one click away.
 */

const termsByCode = new Map<string, CountryMentionTerms>();

function termsFor(code: string): CountryMentionTerms {
  let terms = termsByCode.get(code);
  if (!terms) {
    terms = countryMentionTerms(code);
    termsByCode.set(code, terms);
  }
  return terms;
}

// Each answer costs a handful of regexes, and a focus change re-asks the same
// headlines, so answers are memoized per text. Bounded: cleared when full.
const MAX_CACHED_TEXTS = 4000;
const mentionCache = new Map<string, Map<string, boolean>>();
const otherCountryCache = new Map<string, string | null>();

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= MAX_CACHED_TEXTS) cache.clear();
  cache.set(key, value);
  return value;
}

function mentions(text: string, code: string, lang: string): boolean {
  const key = `${lang}\u0000${text}`;
  let byCode = mentionCache.get(key);
  if (!byCode) byCode = remember(mentionCache, key, new Map<string, boolean>());
  const cached = byCode.get(code);
  if (cached !== undefined) return cached;
  let hit = mentionsCountry(text, termsFor(code));
  if (!hit && lang && lang !== 'en') {
    hit = mentionsLocalizedCountry(text, localizedCountryNames(code, lang), lang);
  }
  byCode.set(code, hit);
  return hit;
}

function firstOtherCountry(text: string): string | null {
  const cached = otherCountryCache.get(text);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const code of SCOPE_ISO2_CODES) {
    if (mentionsCountry(text, termsFor(code))) {
      found = code;
      break;
    }
  }
  return remember(otherCountryCache, text, found);
}

/**
 * The countries a headline names, for a focus whose countries are
 * `candidates` (chosen first, then neighbours):
 *   - the candidates it names, in candidate order, when it names any;
 *   - otherwise the first other country it names, so the caller can tell
 *     "about somewhere else" (hidden) from "about no country" (unattributed);
 *   - [] when it names no country.
 */
/**
 * Attribution reads at most this much of a headline. Titles come from
 * third-party feeds with no length bound of their own, and matching costs one
 * pass per candidate country (up to ~70 under a full focus). A real headline
 * is far shorter, and a country named only after this point is not a headline
 * subject.
 */
export const MAX_ATTRIBUTION_CHARS = 1000;

export function headlineCountries(text: string, candidates: readonly string[], lang?: string): string[] {
  const value = text.slice(0, MAX_ATTRIBUTION_CHARS).trim();
  if (!value) return [];
  const language = (lang ?? 'en').trim().toLowerCase() || 'en';
  const found = candidates.filter((code) => mentions(value, code, language));
  if (found.length > 0) return found;
  const other = firstOtherCountry(value);
  return other ? [other] : [];
}

const SUFFIX_SEPARATORS = new Set(['-', '\u2013', '\u2014', '|']);
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * The headline without a trailing " - Publisher" that names its own source.
 * Aggregated feeds append the outlet ("… - Bangkok Post"), and an outlet
 * named after a country ("Vietnam News", "Thai PBS World") would otherwise
 * attribute every story it carries to that country. Only the item's own
 * source is removed, so "Talks resume - Vietnam" keeps its country.
 */
export function withoutOwnSourceSuffix(title: string, source: string | null | undefined): string {
  const name = (source ?? '').trim().toLowerCase();
  if (!name) return title;
  // Match the WHOLE trailing source name, then its separator: a source such as
  // "Thailand - News" contains a separator itself. Linear, with no regex: a
  // regex here backtracked quadratically on whitespace runs in feed titles.
  const trimmed = title.trimEnd();
  if (trimmed.length <= name.length || trimmed.slice(-name.length).toLowerCase() !== name) return title;
  const head = trimmed.slice(0, trimmed.length - name.length);
  if (!isSpace(head[head.length - 1])) return title;
  const rest = head.trimEnd();
  const separator = rest[rest.length - 1];
  if (!separator || !SUFFIX_SEPARATORS.has(separator) || !isSpace(rest[rest.length - 2])) return title;
  return rest.slice(0, -1).trimEnd();
}

let airportCountries: Map<string, string> | null = null;

/**
 * ISO 3166-1 alpha-2 country of a monitored airport (src/config/airports.ts),
 * or null for an airport outside that list.
 */
export function airportCountry(iata: string): string | null {
  if (!airportCountries) {
    airportCountries = new Map();
    for (const airport of MONITORED_AIRPORTS) {
      const code = resolveCountryCode(airport.country);
      if (code) airportCountries.set(airport.iata.toUpperCase(), code);
    }
  }
  return airportCountries.get(String(iata || '').trim().toUpperCase()) ?? null;
}

/** ISO alpha-2 code for a country name as a feed writes it ("Myanmar (Burma)", "USA"), or null. */
export function countryCodeFromName(name: string | null | undefined): string | null {
  return name ? resolveCountryCode(name) : null;
}
