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

/**
 * Extract the first matching ISO2 country code from a text string.
 * Returns null if no match found.
 * @param {string} text
 * @returns {string|null}
 */
export function extractCountryCode(text) {
  if (!text) return null;
  // Normalize uppercase `US` (country abbreviation) to `united states` before lowercasing,
  // so it survives the stopword pass. Lowercase `us` (pronoun) has no equivalent expansion
  // and is stopped by UNIGRAM_STOPWORDS. `\b` avoids matching inside words like "plus".
  const normalized = text.replace(/\bUS\b/g, 'United States');
  const lower = normalized.toLowerCase();

  // Single left-to-right scan with local longest-match priority:
  // at each position try bigram first (strips punctuation so "West Bank," works),
  // then fall back to unigram. This preserves document order so the first
  // country mentioned in the headline wins regardless of alias length.
  const words = lower.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (i < words.length - 1) {
      const left = words[i].replace(/[^a-z]/g, '');
      const right = words[i + 1].replace(/[^a-z]/g, '');
      if (left && right) {
        const bigram = `${left} ${right}`;
        if (LOOKUP[bigram] && LOOKUP[bigram] !== 'XX') return LOOKUP[bigram];
      }
    }
    const clean = words[i].replace(/[^a-z]/g, '');
    if (clean.length < 2) continue;
    if (UNIGRAM_STOPWORDS.has(clean)) continue;
    if (LOOKUP[clean] && LOOKUP[clean] !== 'XX') return LOOKUP[clean];
  }
  return null;
}
