const RADIO_COUNTRY_MAX_LENGTH = 80;

const ISO_ALPHA_2_CODES = Object.freeze(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO
JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR
MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO
RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV
TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/));

const ISO_ALPHA_2_SET = new Set(ISO_ALPHA_2_CODES);
const ENGLISH_REGION_NAMES = typeof Intl?.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[‐‑‒–—-]+/g, ' ')
    .replace(/[.’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTRY_NAME_TO_CODE = new Map();
for (const code of ISO_ALPHA_2_CODES) {
  const displayName = ENGLISH_REGION_NAMES?.of(code);
  if (displayName && displayName !== code) COUNTRY_NAME_TO_CODE.set(countryKey(displayName), code);
}

for (const [name, code] of Object.entries({
  america: 'US',
  'united states of america': 'US',
  usa: 'US',
  'u s': 'US',
  'u s a': 'US',
  britain: 'GB',
  'great britain': 'GB',
  uk: 'GB',
  'u k': 'GB',
  'south korea': 'KR',
  'north korea': 'KP',
  russia: 'RU',
  vietnam: 'VN',
  'czech republic': 'CZ',
  'ivory coast': 'CI',
  laos: 'LA',
  bolivia: 'BO',
  tanzania: 'TZ',
  moldova: 'MD',
  brunei: 'BN',
  'cape verde': 'CV',
  'the netherlands': 'NL',
})) COUNTRY_NAME_TO_CODE.set(countryKey(name), code);

function canonicalCountryName(code) {
  return ENGLISH_REGION_NAMES?.of(code) || code;
}

/**
 * Normalize a bounded country code or English/common country name.
 * Invalid or ambiguous values fail closed instead of broadening selection.
 */
export function normalizeRadioCountryInput(value) {
  if (value === undefined || value === null || value === '') {
    return Object.freeze({ valid: true, empty: true, code: '', name: '' });
  }
  if (typeof value !== 'string' || value.length > RADIO_COUNTRY_MAX_LENGTH) {
    return Object.freeze({ valid: false, empty: false, code: '', name: '' });
  }
  const trimmed = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (
    !trimmed
    || trimmed.length > RADIO_COUNTRY_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(trimmed)
    || !/^[\p{L}\p{M}.&'’()\-\s]+$/u.test(trimmed)
  ) return Object.freeze({ valid: false, empty: false, code: '', name: '' });

  const possibleCode = trimmed.toUpperCase();
  const code = ISO_ALPHA_2_SET.has(possibleCode)
    ? possibleCode
    : COUNTRY_NAME_TO_CODE.get(countryKey(trimmed)) || '';
  if (!code) return Object.freeze({ valid: false, empty: false, code: '', name: '' });
  return Object.freeze({
    valid: true,
    empty: false,
    code,
    name: canonicalCountryName(code),
  });
}

/** Return whether a value is a recognized ISO 3166-1 alpha-2 code. */
export function isRadioCountryCode(value) {
  return typeof value === 'string' && ISO_ALPHA_2_SET.has(value.toUpperCase());
}
