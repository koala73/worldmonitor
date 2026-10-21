/**
 * Lightweight geopolitical keyword → ISO2 extractor.
 * Uses country-names.json as the base, extended with common city/region aliases
 * and short-form geopolitical names that appear frequently in news headlines.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const countryNames = require(join(__dirname, 'country-names.json'));
// City and region names → ISO2 (scripts/build-news-places.mjs). Only extractCountryCodes
// reads it; extractCountryCode keeps country and alias names only.
const newsPlaces = require(join(__dirname, 'news-places.json'));
const MAX_PLACE_WORDS = 4;

// City/region/capital aliases → ISO2 not covered by country-names.json
const ALIAS_MAP = {
  // Major capitals and common short forms
  'moscow': 'RU', 'kremlin': 'RU', 'russian': 'RU',
  'beijing': 'CN', 'chinese': 'CN', 'prc': 'CN',
  'washington': 'US', 'american': 'US', 'pentagon': 'US',
  'kyiv': 'UA', 'ukrainian': 'UA',
  'tehran': 'IR', 'iranian': 'IR',
  'pyongyang': 'KP', 'north korean': 'KP',
  'taipei': 'TW', 'taiwanese': 'TW',
  'riyadh': 'SA', 'saudi': 'SA',
  'houthi': 'YE', 'houthis': 'YE', 'hezbollah': 'LB',
  'tel aviv': 'IL', 'israeli': 'IL',
  'gaza': 'PS', 'west bank': 'PS', 'palestinian': 'PS',
  'damascus': 'SY', 'syrian': 'SY',
  'kabul': 'AF', 'afghan': 'AF',
  'islamabad': 'PK', 'pakistani': 'PK',
  'new delhi': 'IN', 'indian': 'IN',
  'ankara': 'TR', 'turkish': 'TR',
  'berlin': 'DE', 'german': 'DE',
  'paris': 'FR', 'french': 'FR',
  'london': 'GB', 'british': 'GB', 'uk': 'GB',
  'tokyo': 'JP', 'japanese': 'JP',
  'seoul': 'KR', 'south korean': 'KR',
  'manila': 'PH', 'philippine': 'PH',
  'hanoi': 'VN', 'vietnamese': 'VN',
  'caracas': 'VE', 'venezuelan': 'VE',
  'havana': 'CU', 'cuban': 'CU',
  'minsk': 'BY', 'belarusian': 'BY',
  'belgrade': 'RS', 'serbian': 'RS',
  'warsaw': 'PL', 'polish': 'PL',
  'budapest': 'HU', 'hungarian': 'HU',
  'prague': 'CZ', 'czech': 'CZ',
  'baghdad': 'IQ', 'iraqi': 'IQ',
  'sanaa': 'YE', 'yemeni': 'YE',
  'tripoli': 'LY', 'libyan': 'LY',
  'khartoum': 'SD', 'sudanese': 'SD',
  'addis ababa': 'ET', 'ethiopian': 'ET',
  'nairobi': 'KE', 'kenyan': 'KE',
  'lagos': 'NG', 'nigerian': 'NG',
  'pretoria': 'ZA', 'south african': 'ZA',
  'brasilia': 'BR', 'brazilian': 'BR',
  'bogota': 'CO', 'colombian': 'CO',
  'buenos aires': 'AR', 'argentine': 'AR',
  'lima': 'PE', 'peruvian': 'PE',
  'mexico city': 'MX', 'mexican': 'MX',
  'ottawa': 'CA', 'canadian': 'CA',
  'canberra': 'AU', 'australian': 'AU',
  // Geo regions / alliances used in headlines
  // XX = supranational/multi-country marker; extractCountryCode() returns null for these
  'nato': 'XX',
  'eu': 'XX',
  'europe': 'XX',
  'ukraine': 'UA',
  'taiwan': 'TW',
};

// Unigrams that are ambiguous in English news (person names, US states, etc.).
// These fire too often as false positives when matched as bare words.
// Bigram aliases (e.g. 'south africa') still work; only bare single-word matches are blocked.
const UNIGRAM_STOPWORDS = new Set([
  'chad',    // common English given name
  'jordan',  // common English given name + US-adjacent context
  'georgia', // US state
  'niger',   // easily confused; 'nigerian' alias covers the country
  'guinea',  // 'guinea' appears in many compound names (Equatorial Guinea, etc.)
  'mali',    // common suffix in names (Somali, Bengali, etc.) — 'malian' is rare in headlines
  'peru',    // low geopolitical frequency; false positives in product names
]);

// Build a merged lookup (alias map takes precedence over country-names.json)
const LOOKUP = {};
for (const [name, iso2] of Object.entries(countryNames)) {
  LOOKUP[name.toLowerCase()] = iso2;
}
for (const [alias, iso2] of Object.entries(ALIAS_MAP)) {
  LOOKUP[alias.toLowerCase()] = iso2;
}

// Yields each ISO2 code in reading order. A multi-word match consumes its words, so
// "south sudan" never also yields "sudan".
function* scanCountryCodes(text, { places = false } = {}) {
  if (!text) return;
  // Normalize uppercase `US` (country abbreviation) to `united states` before lowercasing,
  // so it survives the stopword pass. Lowercase `us` (pronoun) has no equivalent expansion
  // and is stopped by UNIGRAM_STOPWORDS. `\b` avoids matching inside words like "plus".
  // Every non-letter separates words, so "Kharkiv’s" and "Mosul–Aleppo" still name places.
  const normalized = text.replace(/\bU\.S\.(?:A\.)?/g, 'United States ').replace(/\bUS\b/g, 'United States')
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z\s]+/g, ' ');

  const words = normalized.split(/\s+/).filter(Boolean);
  const placeWords = places ? words.map((w) => w.replace(/[^a-z]/g, '')) : null;
  for (let i = 0; i < words.length; i++) {
    if (placeWords) {
      const placeMatch = matchPlace(placeWords, i);
      if (placeMatch) {
        yield placeMatch.iso2;
        i += placeMatch.length - 1;
        continue;
      }
    }
    if (i < words.length - 1) {
      const left = words[i].replace(/[^a-z]/g, '');
      const right = words[i + 1].replace(/[^a-z]/g, '');
      if (left && right) {
        const bigram = `${left} ${right}`;
        if (LOOKUP[bigram]) {
          if (LOOKUP[bigram] !== 'XX') yield LOOKUP[bigram];
          i++;
          continue;
        }
      }
    }
    const clean = words[i].replace(/[^a-z]/g, '');
    if (clean.length < 2) continue;
    if (UNIGRAM_STOPWORDS.has(clean)) continue;
    if (LOOKUP[clean] && LOOKUP[clean] !== 'XX') yield LOOKUP[clean];
  }
}

// Longest place name starting at placeWords[start], unless a country or alias name starts there
// too: "South Sudan" must stay a country even if a place shares its first word.
function matchPlace(placeWords, start) {
  for (let n = Math.min(MAX_PLACE_WORDS, placeWords.length - start); n >= 1; n--) {
    const phrase = placeWords.slice(start, start + n);
    if (phrase.some((w) => !w)) continue;
    const name = phrase.join(' ');
    if (LOOKUP[name]) return null;
    if (newsPlaces[name]) return { iso2: newsPlaces[name], length: n };
  }
  return null;
}

/**
 * Extract the first matching ISO2 country code from a text string.
 * Returns null if no match found.
 * @param {string} text
 * @returns {string|null}
 */
export function extractCountryCode(text) {
  for (const code of scanCountryCodes(text)) return code;
  return null;
}

/**
 * Every distinct ISO2 country code a text string names, by country, alias, city or
 * region name, in reading order.
 * @param {string} text
 * @returns {string[]}
 */
export function extractCountryCodes(text) {
  return [...new Set(scanCountryCodes(stripPublisherSuffix(text), { places: true }))];
}

/**
 * A top story's countries: the primary countryCode (first country or alias name, the
 * long-standing rule) and every country the title names, primary first. Both ignore a
 * trailing publisher credit.
 * @param {string} title
 * @returns {{ countryCode: string|null, countryCodes: string[] }}
 */
export function extractStoryCountries(title) {
  const countryCodes = extractCountryCodes(title);
  // The strict name scan cannot see place names, so "New Mexico" reads as MX there; keep its
  // pick only when the place-aware scan agrees the title names that country.
  const strict = extractCountryCode(stripPublisherSuffix(title));
  const countryCode = (strict && countryCodes.includes(strict) ? strict : countryCodes[0]) ?? null;
  if (!countryCode) return { countryCode, countryCodes };
  return { countryCode, countryCodes: [countryCode, ...countryCodes.filter((code) => code !== countryCode)] };
}

// A tail naming a country is a credit only when it also reads like an outlet name.
export const PUBLISHER_CREDIT_WORDS = /\b(?:post|times|news|journal|herald|tribune|guardian|telegraph|gazette|press|reuters|bloomberg|jazeera|bbc|cnn|nbc|cbs|npr|afp|tv|television|radio|daily|weekly|observer|independent|monitor|chronicle|express|mail|standard|insider|magazine|media|network|wire|agency|today|online)\b|\.(?:com|org|net|gov)\b/i;
// Only the end of a title can hold a credit; searching a bounded tail keeps the match
// linear on whitespace-heavy titles.
const CREDIT_TAIL_CHARS = 120;

/**
 * Drop a trailing " - The Washington Post" / " | Al Jazeera" publisher credit, so the
 * outlet's home country is not read as a country the story is about. A tail of six words
 * or fewer is a credit when it reads like an outlet name or names no country; "India –
 * Pakistan tensions rise" keeps its ending.
 * @param {string} text
 * @returns {string}
 */
export function stripPublisherSuffix(text) {
  if (!text) return text;
  const tailStart = Math.max(0, text.length - CREDIT_TAIL_CHARS);
  const credit = /\s[-–—|]\s+([^-–—|]+)$/.exec(text.slice(tailStart));
  if (!credit) return text;
  const tail = credit[1].trim();
  if (tail.split(/\s+/).length > 6) return text;
  const isCredit = PUBLISHER_CREDIT_WORDS.test(tail) || scanCountryCodes(tail, { places: true }).next().done;
  return isCredit ? text.slice(0, tailStart + credit.index) : text;
}
