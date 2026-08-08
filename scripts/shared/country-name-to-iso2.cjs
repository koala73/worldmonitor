'use strict';

// Canonical country-name → ISO-3166 alpha-2 map (~306 entries incl. aliases,
// maintained by scripts/build-country-names.cjs). Keys are pre-normalized:
// lowercase, diacritics stripped, '&' → ' and ', punctuation collapsed.
const COUNTRY_NAMES = require('./country-names.json');

// Aliases the canonical map lacks. UCDP emits 'Bosnia-Herzegovina' (hyphen,
// no 'and'), which normalizes to a token country-names.json doesn't carry.
const EXTRA_ALIASES = Object.freeze({
  'bosnia herzegovina': 'BA',
});

const COUNTRY_NAME_TO_ISO2 = Object.freeze(
  Object.assign({}, COUNTRY_NAMES, EXTRA_ALIASES),
);

// Mirrors the key normalization in scripts/build-country-names.cjs so lookups
// hit the same token space the JSON was built with.
function normalizeCountryToken(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''‘’`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countryNameToIso2(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();

  const direct = COUNTRY_NAME_TO_ISO2[normalizeCountryToken(trimmed)];
  if (direct) return direct;

  // UCDP-style historical parenthetical: 'Yemen (North Yemen)',
  // 'Russia (Soviet Union)', 'DR Congo (Zaire)' — resolve via the modern name.
  const stripped = trimmed.replace(/\s*\([^)]*\)\s*$/, '');
  if (stripped !== trimmed) {
    const viaStripped = COUNTRY_NAME_TO_ISO2[normalizeCountryToken(stripped)];
    if (viaStripped) return viaStripped;
  }

  // Bare ISO2 passthrough. Checked AFTER the alias map so 'UK' → GB, not 'UK'.
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

module.exports = {
  COUNTRY_NAME_TO_ISO2,
  countryNameToIso2,
};
