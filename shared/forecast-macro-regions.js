// @ts-check
// Maps the free-text `Forecast.region` string (as written by the seed) to a
// macro region id. Used client-side by ForecastPanel to filter forecasts when
// the Forecast proto does not expose macroRegion directly.
//
// The seed emits Forecast.region as any of:
//   1. A country name via `region: c.name` (conflict / political / cyber /
//      infrastructure rows). c.name comes from scripts/data/country-codes.json
//      and covers every ISO country — "Algeria", "Niger", "Kazakhstan",
//      "Uruguay", "Vietnam", "New Zealand", etc.
//   2. A theater or geo label ("Middle East", "Red Sea", "Baltic Sea",
//      "Northern Europe", "South China Sea", "Sahel", "Horn of Africa", ...).
//   3. The literal string "Global" for cross-market / global macro signals.
//
// The earlier version of this file mirrored scripts/seed-forecasts.mjs's
// MACRO_REGION_MAP (~50 entries) 1:1, which silently dropped every row whose
// region wasn't explicitly listed — nearly every country feed, every
// "Northern Europe" market row, every "Uruguay" conflict row. This version
// broadens classification via a 3-stage lookup:
//
//   1. Lowercase-name lookup against COUNTRY_NAME_TO_ISO2 (302 entries).
//   2. ISO2 -> region via ISO2_TO_REGION (218 entries), a copy of the
//      World Bank taxonomy with strategic overrides (AF/PK/LK -> south-asia,
//      TR -> mena, MX -> north-america, TW -> east-asia).
//   3. Theater / geo-label fallback via THEATER_TO_REGION.
//
// Unknown strings (including "Global") return null so they only surface under
// the "All Regions" pill and never appear under a specific region filter.
// Note: "Global" resolves to 'global' explicitly so callers can distinguish
// "truly global" from "unknown".

/**
 * @typedef {'mena'
 *   | 'east-asia'
 *   | 'europe'
 *   | 'north-america'
 *   | 'south-asia'
 *   | 'latam'
 *   | 'sub-saharan-africa'
 *   | 'global'} ForecastMacroRegionId
 */

/** @type {Readonly<Record<string, ForecastMacroRegionId>>} */
const ISO2_TO_REGION = Object.freeze({
  AD: 'europe',             AE: 'mena',               AF: 'south-asia',
  AG: 'latam',              AL: 'europe',             AM: 'europe',
  AO: 'sub-saharan-africa', AR: 'latam',              AS: 'east-asia',
  AT: 'europe',             AU: 'east-asia',          AW: 'latam',
  AZ: 'europe',             BA: 'europe',             BB: 'latam',
  BD: 'south-asia',         BE: 'europe',             BF: 'sub-saharan-africa',
  BG: 'europe',             BH: 'mena',               BI: 'sub-saharan-africa',
  BJ: 'sub-saharan-africa', BM: 'north-america',      BN: 'east-asia',
  BO: 'latam',              BR: 'latam',              BS: 'latam',
  BT: 'south-asia',         BW: 'sub-saharan-africa', BY: 'europe',
  BZ: 'latam',              CA: 'north-america',      CD: 'sub-saharan-africa',
  CF: 'sub-saharan-africa', CG: 'sub-saharan-africa', CH: 'europe',
  CI: 'sub-saharan-africa', CL: 'latam',              CM: 'sub-saharan-africa',
  CN: 'east-asia',          CO: 'latam',              CR: 'latam',
  CU: 'latam',              CV: 'sub-saharan-africa', CW: 'latam',
  CY: 'europe',             CZ: 'europe',             DE: 'europe',
  DJ: 'mena',               DK: 'europe',             DM: 'latam',
  DO: 'latam',              DZ: 'mena',               EC: 'latam',
  EE: 'europe',             EG: 'mena',               ER: 'sub-saharan-africa',
  ES: 'europe',             ET: 'sub-saharan-africa', FI: 'europe',
  FJ: 'east-asia',          FM: 'east-asia',          FO: 'europe',
  FR: 'europe',             GA: 'sub-saharan-africa', GB: 'europe',
  GD: 'latam',              GE: 'europe',             GH: 'sub-saharan-africa',
  GI: 'europe',             GL: 'europe',             GM: 'sub-saharan-africa',
  GN: 'sub-saharan-africa', GQ: 'sub-saharan-africa', GR: 'europe',
  GT: 'latam',              GU: 'east-asia',          GW: 'sub-saharan-africa',
  GY: 'latam',              HK: 'east-asia',          HN: 'latam',
  HR: 'europe',             HT: 'latam',              HU: 'europe',
  ID: 'east-asia',          IE: 'europe',             IL: 'mena',
  IM: 'europe',             IN: 'south-asia',         IQ: 'mena',
  IR: 'mena',               IS: 'europe',             IT: 'europe',
  JG: 'europe',             JM: 'latam',              JO: 'mena',
  JP: 'east-asia',          KE: 'sub-saharan-africa', KG: 'europe',
  KH: 'east-asia',          KI: 'east-asia',          KM: 'sub-saharan-africa',
  KN: 'latam',              KP: 'east-asia',          KR: 'east-asia',
  KW: 'mena',               KY: 'latam',              KZ: 'europe',
  LA: 'east-asia',          LB: 'mena',               LC: 'latam',
  LI: 'europe',             LK: 'south-asia',         LR: 'sub-saharan-africa',
  LS: 'sub-saharan-africa', LT: 'europe',             LU: 'europe',
  LV: 'europe',             LY: 'mena',               MA: 'mena',
  MC: 'europe',             MD: 'europe',             ME: 'europe',
  MF: 'latam',              MG: 'sub-saharan-africa', MH: 'east-asia',
  MK: 'europe',             ML: 'sub-saharan-africa', MM: 'east-asia',
  MN: 'east-asia',          MO: 'east-asia',          MP: 'east-asia',
  MR: 'sub-saharan-africa', MT: 'mena',               MU: 'sub-saharan-africa',
  MV: 'south-asia',         MW: 'sub-saharan-africa', MX: 'north-america',
  MY: 'east-asia',          MZ: 'sub-saharan-africa', NA: 'sub-saharan-africa',
  NC: 'east-asia',          NE: 'sub-saharan-africa', NG: 'sub-saharan-africa',
  NI: 'latam',              NL: 'europe',             NO: 'europe',
  NP: 'south-asia',         NR: 'east-asia',          NZ: 'east-asia',
  OM: 'mena',               PA: 'latam',              PE: 'latam',
  PF: 'east-asia',          PG: 'east-asia',          PH: 'east-asia',
  PK: 'south-asia',         PL: 'europe',             PR: 'latam',
  PS: 'mena',               PT: 'europe',             PW: 'east-asia',
  PY: 'latam',              QA: 'mena',               RO: 'europe',
  RS: 'europe',             RU: 'europe',             RW: 'sub-saharan-africa',
  SA: 'mena',               SB: 'east-asia',          SC: 'sub-saharan-africa',
  SD: 'sub-saharan-africa', SE: 'europe',             SG: 'east-asia',
  SI: 'europe',             SK: 'europe',             SL: 'sub-saharan-africa',
  SM: 'europe',             SN: 'sub-saharan-africa', SO: 'sub-saharan-africa',
  SR: 'latam',              SS: 'sub-saharan-africa', ST: 'sub-saharan-africa',
  SV: 'latam',              SX: 'latam',              SY: 'mena',
  SZ: 'sub-saharan-africa', TC: 'latam',              TD: 'sub-saharan-africa',
  TG: 'sub-saharan-africa', TH: 'east-asia',          TJ: 'europe',
  TL: 'east-asia',          TM: 'europe',             TN: 'mena',
  TO: 'east-asia',          TR: 'mena',               TT: 'latam',
  TV: 'east-asia',          TW: 'east-asia',          TZ: 'sub-saharan-africa',
  UA: 'europe',             UG: 'sub-saharan-africa', US: 'north-america',
  UY: 'latam',              UZ: 'europe',             VC: 'latam',
  VE: 'latam',              VG: 'latam',              VI: 'latam',
  VN: 'east-asia',          VU: 'east-asia',          WS: 'east-asia',
  XK: 'europe',             YE: 'mena',               ZA: 'sub-saharan-africa',
  ZM: 'sub-saharan-africa', ZW: 'sub-saharan-africa',
});

/** @type {Readonly<Record<string, string>>} */
const COUNTRY_NAME_TO_ISO2 = Object.freeze({
  'afghanistan': 'AF',
  'aland': 'AX',
  'albania': 'AL',
  'algeria': 'DZ',
  'american samoa': 'AS',
  'andorra': 'AD',
  'angola': 'AO',
  'anguilla': 'AI',
  'antarctica': 'AQ',
  'antigua and barbuda': 'AG',
  'argentina': 'AR',
  'armenia': 'AM',
  'aruba': 'AW',
  'australia': 'AU',
  'austria': 'AT',
  'azerbaijan': 'AZ',
  'bahamas': 'BS',
  'bahamas the': 'BS',
  'bahrain': 'BH',
  'bangladesh': 'BD',
  'barbados': 'BB',
  'belarus': 'BY',
  'belgium': 'BE',
  'belize': 'BZ',
  'benin': 'BJ',
  'bermuda': 'BM',
  'bhutan': 'BT',
  'bolivarian republic of venezuela': 'VE',
  'bolivia': 'BO',
  'bosnia and herzegovina': 'BA',
  'botswana': 'BW',
  'brazil': 'BR',
  'british indian ocean territory': 'IO',
  'british virgin islands': 'VG',
  'brunei': 'BN',
  'brunei darussalam': 'BN',
  'bulgaria': 'BG',
  'burkina faso': 'BF',
  'burma': 'MM',
  'burundi': 'BI',
  'cabo verde': 'CV',
  'cambodia': 'KH',
  'cameroon': 'CM',
  'canada': 'CA',
  'cape verde': 'CV',
  'cayman islands': 'KY',
  'central african republic': 'CF',
  'chad': 'TD',
  'chile': 'CL',
  'china': 'CN',
  'colombia': 'CO',
  'comoros': 'KM',
  'congo': 'CG',
  'congo brazzaville': 'CG',
  'congo dem rep': 'CD',
  'congo kinshasa': 'CD',
  'congo rep': 'CG',
  'cook islands': 'CK',
  'costa rica': 'CR',
  'cote d ivoire': 'CI',
  'croatia': 'HR',
  'cuba': 'CU',
  'curacao': 'CW',
  'cyprus': 'CY',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'democratic peoples republic of korea': 'KP',
  'democratic republic of the congo': 'CD',
  'denmark': 'DK',
  'djibouti': 'DJ',
  'dominica': 'DM',
  'dominican republic': 'DO',
  'dr congo': 'CD',
  'drc': 'CD',
  'east timor': 'TL',
  'ecuador': 'EC',
  'egypt': 'EG',
  'egypt arab rep': 'EG',
  'el salvador': 'SV',
  'equatorial guinea': 'GQ',
  'eritrea': 'ER',
  'estonia': 'EE',
  'eswatini': 'SZ',
  'ethiopia': 'ET',
  'falkland islands': 'FK',
  'faroe islands': 'FO',
  'federated states of micronesia': 'FM',
  'fiji': 'FJ',
  'finland': 'FI',
  'france': 'FR',
  'french polynesia': 'PF',
  'french southern and antarctic lands': 'TF',
  'gabon': 'GA',
  'gambia': 'GM',
  'gambia the': 'GM',
  'gaza': 'PS',
  'georgia': 'GE',
  'germany': 'DE',
  'ghana': 'GH',
  'gibraltar': 'GI',
  'greece': 'GR',
  'greenland': 'GL',
  'grenada': 'GD',
  'guam': 'GU',
  'guatemala': 'GT',
  'guernsey': 'GG',
  'guinea': 'GN',
  'guinea bissau': 'GW',
  'guyana': 'GY',
  'haiti': 'HT',
  'heard island and mcdonald islands': 'HM',
  'honduras': 'HN',
  'hong kong': 'HK',
  'hong kong s a r': 'HK',
  'hong kong sar china': 'HK',
  'hungary': 'HU',
  'iceland': 'IS',
  'india': 'IN',
  'indonesia': 'ID',
  'iran': 'IR',
  'iran islamic rep': 'IR',
  'iraq': 'IQ',
  'ireland': 'IE',
  'isle of man': 'IM',
  'israel': 'IL',
  'italy': 'IT',
  'ivory coast': 'CI',
  'jamaica': 'JM',
  'japan': 'JP',
  'jersey': 'JE',
  'jordan': 'JO',
  'kazakhstan': 'KZ',
  'kenya': 'KE',
  'kiribati': 'KI',
  'korea dem peoples rep': 'KP',
  'korea rep': 'KR',
  'kosovo': 'XK',
  'kuwait': 'KW',
  'kyrgyz republic': 'KG',
  'kyrgyzstan': 'KG',
  'lao pdr': 'LA',
  'laos': 'LA',
  'latvia': 'LV',
  'lebanon': 'LB',
  'lesotho': 'LS',
  'liberia': 'LR',
  'libya': 'LY',
  'liechtenstein': 'LI',
  'lithuania': 'LT',
  'luxembourg': 'LU',
  'macao s a r': 'MO',
  'macao sar china': 'MO',
  'madagascar': 'MG',
  'malawi': 'MW',
  'malaysia': 'MY',
  'maldives': 'MV',
  'mali': 'ML',
  'malta': 'MT',
  'marshall islands': 'MH',
  'mauritania': 'MR',
  'mauritius': 'MU',
  'mexico': 'MX',
  'micronesia': 'FM',
  'micronesia fed sts': 'FM',
  'moldova': 'MD',
  'monaco': 'MC',
  'mongolia': 'MN',
  'montenegro': 'ME',
  'montserrat': 'MS',
  'morocco': 'MA',
  'morocco western sahara': 'MA',
  'mozambique': 'MZ',
  'myanmar': 'MM',
  'namibia': 'NA',
  'nauru': 'NR',
  'nepal': 'NP',
  'netherlands': 'NL',
  'new caledonia': 'NC',
  'new zealand': 'NZ',
  'nicaragua': 'NI',
  'niger': 'NE',
  'nigeria': 'NG',
  'niue': 'NU',
  'norfolk island': 'NF',
  'north korea': 'KP',
  'north macedonia': 'MK',
  'northern mariana islands': 'MP',
  'norway': 'NO',
  'occupied palestinian territory': 'PS',
  'oman': 'OM',
  'pakistan': 'PK',
  'palau': 'PW',
  'palestine': 'PS',
  'palestine state of': 'PS',
  'palestinian territories': 'PS',
  'panama': 'PA',
  'papua new guinea': 'PG',
  'paraguay': 'PY',
  'peru': 'PE',
  'philippines': 'PH',
  'pitcairn islands': 'PN',
  'plurinational state of bolivia': 'BO',
  'poland': 'PL',
  'portugal': 'PT',
  'puerto rico': 'PR',
  'qatar': 'QA',
  'republic of korea': 'KR',
  'republic of serbia': 'RS',
  'republic of the congo': 'CG',
  'romania': 'RO',
  'russia': 'RU',
  'russian federation': 'RU',
  'rwanda': 'RW',
  'saint barthelemy': 'BL',
  'saint helena': 'SH',
  'saint kitts and nevis': 'KN',
  'saint lucia': 'LC',
  'saint martin': 'MF',
  'saint pierre and miquelon': 'PM',
  'saint vincent and the grenadines': 'VC',
  'samoa': 'WS',
  'san marino': 'SM',
  'sao tome': 'ST',
  'sao tome and principe': 'ST',
  'saudi arabia': 'SA',
  'senegal': 'SN',
  'serbia': 'RS',
  'seychelles': 'SC',
  'sierra leone': 'SL',
  'singapore': 'SG',
  'sint maarten': 'SX',
  'slovak republic': 'SK',
  'slovakia': 'SK',
  'slovenia': 'SI',
  'solomon islands': 'SB',
  'somalia': 'SO',
  'south africa': 'ZA',
  'south georgia and the islands': 'GS',
  'south korea': 'KR',
  'south sudan': 'SS',
  'spain': 'ES',
  'sri lanka': 'LK',
  'st kitts and nevis': 'KN',
  'st lucia': 'LC',
  'st vincent and the grenadines': 'VC',
  'sudan': 'SD',
  'suriname': 'SR',
  'swaziland': 'SZ',
  'sweden': 'SE',
  'switzerland': 'CH',
  'syria': 'SY',
  'syrian arab republic': 'SY',
  'taiwan': 'TW',
  'tajikistan': 'TJ',
  'tanzania': 'TZ',
  'thailand': 'TH',
  'the bahamas': 'BS',
  'the comoros': 'KM',
  'the gambia': 'GM',
  'the maldives': 'MV',
  'the netherlands': 'NL',
  'the philippines': 'PH',
  'the seychelles': 'SC',
  'timor leste': 'TL',
  'togo': 'TG',
  'tonga': 'TO',
  'trinidad and tobago': 'TT',
  'tunisia': 'TN',
  'turkey': 'TR',
  'turkiye': 'TR',
  'turkmenistan': 'TM',
  'turks and caicos': 'TC',
  'turks and caicos islands': 'TC',
  'tuvalu': 'TV',
  'u s virgin islands': 'VI',
  'uae': 'AE',
  'uganda': 'UG',
  'uk': 'GB',
  'ukraine': 'UA',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united republic of tanzania': 'TZ',
  'united states': 'US',
  'united states minor outlying islands': 'UM',
  'united states of america': 'US',
  'united states virgin islands': 'VI',
  'uruguay': 'UY',
  'usa': 'US',
  'uzbekistan': 'UZ',
  'vanuatu': 'VU',
  'vatican': 'VA',
  'venezuela': 'VE',
  'venezuela rb': 'VE',
  'viet nam': 'VN',
  'vietnam': 'VN',
  'wallis and futuna': 'WF',
  'west bank': 'PS',
  'west bank and gaza': 'PS',
  'western sahara': 'EH',
  'yemen': 'YE',
  'yemen rep': 'YE',
  'zambia': 'ZM',
  'zimbabwe': 'ZW',
});

// Theater / geo-label fallback. These are free-text strings the seed emits
// that do not map to a single country (seas, straits, sub-regions). Keys are
// normalized (lowercase, single-spaced). Add sparingly — anything that can be
// resolved through a country name should go through the ISO2 path.
/** @type {Readonly<Record<string, ForecastMacroRegionId>>} */
const THEATER_TO_REGION = Object.freeze({
  // MENA theaters / corridors
  'middle east': 'mena',
  'persian gulf': 'mena',
  'red sea': 'mena',
  'strait of hormuz': 'mena',
  'bab el mandeb': 'mena',
  'suez': 'mena',
  'eastern mediterranean': 'mena',
  'north africa': 'mena',
  'maghreb': 'mena',
  'levant': 'mena',
  // East Asia theaters / corridors
  'south china sea': 'east-asia',
  'east china sea': 'east-asia',
  'western pacific': 'east-asia',
  'taiwan strait': 'east-asia',
  'korean peninsula': 'east-asia',
  'southeast asia': 'east-asia',
  'indochina': 'east-asia',
  // Europe theaters / corridors
  'baltic sea': 'europe',
  'black sea': 'europe',
  'kerch strait': 'europe',
  'nordic': 'europe',
  'northern europe': 'europe',
  'western europe': 'europe',
  'eastern europe': 'europe',
  'central europe': 'europe',
  'southern europe': 'europe',
  'balkans': 'europe',
  'caucasus': 'europe',
  // Sub-Saharan Africa theaters / corridors
  'sahel': 'sub-saharan-africa',
  'horn of africa': 'sub-saharan-africa',
  'central africa': 'sub-saharan-africa',
  'west africa': 'sub-saharan-africa',
  'southern africa': 'sub-saharan-africa',
  'east africa': 'sub-saharan-africa',
  'gulf of guinea': 'sub-saharan-africa',
  // South Asia theaters
  'indian subcontinent': 'south-asia',
  'south asia': 'south-asia',
  // North America theaters
  'north america': 'north-america',
  'north american': 'north-america',
  // LatAm theaters
  'latin america': 'latam',
  'south america': 'latam',
  'central america': 'latam',
  'caribbean': 'latam',
  'andes': 'latam',
  // Global
  'global': 'global',
  'worldwide': 'global',
  'world': 'global',
  'international': 'global',
});

/**
 * Normalize a region string for dictionary lookup: NFKD, strip diacritics,
 * lowercase, strip punctuation, collapse whitespace. Mirrors
 * scripts/_country-resolver.mjs::normalizeCountryToken so country names that
 * round-trip through that path land at the same key.
 * @param {string} value
 * @returns {string}
 */
function normalizeRegionKey(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a free-text Forecast.region string to its macro region id, or null
 * if the region is unknown (unknown rows only appear under "All Regions").
 *
 * Lookup order:
 *   1. Theater / geo-label map (covers multi-country strings like "Red Sea")
 *   2. Country name -> ISO2 -> region (covers any country the seed emits)
 *   3. null
 *
 * @param {string | null | undefined} region
 * @returns {ForecastMacroRegionId | null}
 */
export function getForecastMacroRegion(region) {
  if (!region) return null;
  const key = normalizeRegionKey(region);
  if (!key) return null;

  const theaterHit = THEATER_TO_REGION[key];
  if (theaterHit) return theaterHit;

  const iso2 = COUNTRY_NAME_TO_ISO2[key];
  if (iso2) {
    const regionId = ISO2_TO_REGION[iso2];
    if (regionId) return regionId;
  }

  return null;
}
