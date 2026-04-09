'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const geojsonPath = path.join(root, 'public', 'data', 'countries.geojson');
const existingPath = path.join(root, 'shared', 'country-names.json');

const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
const result = Object.assign({}, existing);
let added = 0;

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function add(key, iso2, source) {
  const k = normalize(key);
  if (!k || !/^[A-Z]{2}$/.test(iso2)) return;
  if (result[k]) return;
  result[k] = iso2;
  added++;
}

// A. Geojson country names
const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
for (const f of geojson.features) {
  const props = f.properties || {};
  const iso2 = String(props['ISO3166-1-Alpha-2'] || '').trim();
  const name = props.name;
  if (!/^[A-Z]{2}$/.test(iso2)) continue;
  if (typeof name === 'string' && name.trim()) {
    add(name, iso2, 'geojson');
  }
}

// B. COUNTRY_ALIAS_MAP from _country-resolver.mjs (37 entries, hardcoded)
const COUNTRY_ALIAS_MAP = {
  'bahamas the': 'BS',
  'cape verde': 'CV',
  'congo brazzaville': 'CG',
  'congo kinshasa': 'CD',
  'congo rep': 'CG',
  'congo dem rep': 'CD',
  'czech republic': 'CZ',
  'egypt arab rep': 'EG',
  'gambia the': 'GM',
  'hong kong sar china': 'HK',
  'iran islamic rep': 'IR',
  'korea dem peoples rep': 'KP',
  'korea rep': 'KR',
  'lao pdr': 'LA',
  'macao sar china': 'MO',
  'micronesia fed sts': 'FM',
  'morocco western sahara': 'MA',
  'north macedonia': 'MK',
  'occupied palestinian territory': 'PS',
  'palestinian territories': 'PS',
  'palestine state of': 'PS',
  'russian federation': 'RU',
  'slovak republic': 'SK',
  'st kitts and nevis': 'KN',
  'st lucia': 'LC',
  'st vincent and the grenadines': 'VC',
  'syrian arab republic': 'SY',
  'the bahamas': 'BS',
  'timor leste': 'TL',
  'turkiye': 'TR',
  'u s': 'US',
  'united states of america': 'US',
  'venezuela rb': 'VE',
  'viet nam': 'VN',
  'west bank and gaza': 'PS',
  'yemen rep': 'YE',
};
for (const [alias, iso2] of Object.entries(COUNTRY_ALIAS_MAP)) {
  add(alias, iso2, 'alias_map');
}

// C. Additional upstream API variants
const upstream = {
  'egypt arab rep': 'EG',
  'korea rep': 'KR',
  'iran islamic rep': 'IR',
  'congo dem rep': 'CD',
  'congo rep': 'CG',
  'venezuela rb': 'VE',
  'yemen rep': 'YE',
  'bahamas the': 'BS',
  'gambia the': 'GM',
  'hong kong sar china': 'HK',
  'macao sar china': 'MO',
  'micronesia fed sts': 'FM',
  'lao pdr': 'LA',
  'slovak republic': 'SK',
  'syrian arab republic': 'SY',
  'viet nam': 'VN',
  'turkiye': 'TR',
  'timor leste': 'TL',
  'occupied palestinian territory': 'PS',
  'palestine state of': 'PS',
  'west bank and gaza': 'PS',
  'bolivarian republic of venezuela': 'VE',
  'plurinational state of bolivia': 'BO',
  'united republic of tanzania': 'TZ',
  'democratic peoples republic of korea': 'KP',
  'republic of korea': 'KR',
  'ivory coast': 'CI',
  'swaziland': 'SZ',
  'north macedonia': 'MK',
};
for (const [name, iso2] of Object.entries(upstream)) {
  add(name, iso2, 'upstream');
}

// D. Correlation extras from seed-correlation.mjs (hardcoded)
const COUNTRY_NAME_TO_ISO2 = {
  'afghanistan': 'AF', 'albania': 'AL', 'algeria': 'DZ', 'angola': 'AO',
  'argentina': 'AR', 'armenia': 'AM', 'australia': 'AU', 'austria': 'AT',
  'azerbaijan': 'AZ', 'bahrain': 'BH', 'bangladesh': 'BD', 'belarus': 'BY',
  'belgium': 'BE', 'bolivia': 'BO', 'bosnia and herzegovina': 'BA',
  'brazil': 'BR', 'bulgaria': 'BG', 'burkina faso': 'BF', 'burma': 'MM',
  'cambodia': 'KH', 'cameroon': 'CM', 'canada': 'CA', 'chad': 'TD',
  'chile': 'CL', 'china': 'CN', 'colombia': 'CO', 'congo': 'CG',
  'costa rica': 'CR', 'croatia': 'HR', 'cuba': 'CU', 'cyprus': 'CY',
  'czech republic': 'CZ', 'czechia': 'CZ',
  'democratic republic of the congo': 'CD', 'dr congo': 'CD', 'drc': 'CD',
  'denmark': 'DK', 'djibouti': 'DJ', 'dominican republic': 'DO',
  'ecuador': 'EC', 'egypt': 'EG', 'el salvador': 'SV', 'eritrea': 'ER',
  'estonia': 'EE', 'ethiopia': 'ET', 'finland': 'FI', 'france': 'FR',
  'gabon': 'GA', 'georgia': 'GE', 'germany': 'DE', 'ghana': 'GH',
  'greece': 'GR', 'guatemala': 'GT', 'guinea': 'GN', 'haiti': 'HT',
  'honduras': 'HN', 'hungary': 'HU', 'iceland': 'IS', 'india': 'IN',
  'indonesia': 'ID', 'iran': 'IR', 'iraq': 'IQ', 'ireland': 'IE',
  'israel': 'IL', 'italy': 'IT', 'ivory coast': 'CI', "cote d'ivoire": 'CI',
  'jamaica': 'JM', 'japan': 'JP', 'jordan': 'JO', 'kazakhstan': 'KZ',
  'kenya': 'KE', 'kosovo': 'XK', 'kuwait': 'KW', 'kyrgyzstan': 'KG',
  'laos': 'LA', 'latvia': 'LV', 'lebanon': 'LB', 'libya': 'LY',
  'lithuania': 'LT', 'madagascar': 'MG', 'malawi': 'MW', 'malaysia': 'MY',
  'mali': 'ML', 'mauritania': 'MR', 'mexico': 'MX', 'moldova': 'MD',
  'mongolia': 'MN', 'montenegro': 'ME', 'morocco': 'MA', 'mozambique': 'MZ',
  'myanmar': 'MM', 'namibia': 'NA', 'nepal': 'NP', 'netherlands': 'NL',
  'new zealand': 'NZ', 'nicaragua': 'NI', 'niger': 'NE', 'nigeria': 'NG',
  'north korea': 'KP', 'north macedonia': 'MK', 'norway': 'NO',
  'oman': 'OM', 'pakistan': 'PK', 'palestine': 'PS', 'panama': 'PA',
  'papua new guinea': 'PG', 'paraguay': 'PY', 'peru': 'PE',
  'philippines': 'PH', 'poland': 'PL', 'portugal': 'PT', 'qatar': 'QA',
  'romania': 'RO', 'russia': 'RU', 'rwanda': 'RW', 'saudi arabia': 'SA',
  'senegal': 'SN', 'serbia': 'RS', 'sierra leone': 'SL', 'singapore': 'SG',
  'slovakia': 'SK', 'slovenia': 'SI', 'somalia': 'SO', 'south africa': 'ZA',
  'south korea': 'KR', 'south sudan': 'SS', 'spain': 'ES',
  'sri lanka': 'LK', 'sudan': 'SD', 'sweden': 'SE', 'switzerland': 'CH',
  'syria': 'SY', 'taiwan': 'TW', 'tajikistan': 'TJ', 'tanzania': 'TZ',
  'thailand': 'TH', 'togo': 'TG', 'trinidad and tobago': 'TT',
  'tunisia': 'TN', 'turkey': 'TR', 'turkmenistan': 'TM', 'uganda': 'UG',
  'ukraine': 'UA', 'united arab emirates': 'AE', 'uae': 'AE',
  'united kingdom': 'GB', 'uk': 'GB', 'united states': 'US', 'usa': 'US',
  'uruguay': 'UY', 'uzbekistan': 'UZ', 'venezuela': 'VE', 'vietnam': 'VN',
  'yemen': 'YE', 'zambia': 'ZM', 'zimbabwe': 'ZW',
  'east timor': 'TL', 'cape verde': 'CV', 'swaziland': 'SZ',
  'republic of the congo': 'CG',
};
for (const [name, iso2] of Object.entries(COUNTRY_NAME_TO_ISO2)) {
  add(name, iso2, 'correlation');
}

// Sort keys alphabetically
const sorted = Object.fromEntries(
  Object.entries(result).sort(([a], [b]) => a.localeCompare(b))
);

fs.writeFileSync(existingPath, JSON.stringify(sorted, null, 2) + '\n');
console.log(`Existing: ${Object.keys(existing).length}, Added: ${added}, Total: ${Object.keys(sorted).length}`);

// Validate all values are ISO2
for (const [k, v] of Object.entries(sorted)) {
  if (!/^[A-Z]{2}$/.test(v)) console.error(`INVALID VALUE: ${k} → ${v}`);
  if (k !== k.toLowerCase()) console.error(`NON-LOWERCASE KEY: ${k}`);
}
