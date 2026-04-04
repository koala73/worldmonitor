import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharedConfig } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_COUNTRY_NAMES = loadSharedConfig('country-names.json');
const DEFAULT_COUNTRIES_GEOJSON = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'data', 'countries.geojson'), 'utf8'),
);

export const COUNTRY_ALIAS_MAP = {
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

export function normalizeCountryToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isIso2(value) {
  return /^[A-Z]{2}$/.test(String(value || '').trim());
}

export function isIso3(value) {
  return /^[A-Z]{3}$/.test(String(value || '').trim());
}

export function createCountryResolvers(countryNames = DEFAULT_COUNTRY_NAMES, geojson = DEFAULT_COUNTRIES_GEOJSON) {
  const nameToIso2 = new Map();
  const iso3ToIso2 = new Map();

  for (const [name, iso2] of Object.entries(countryNames)) {
    if (isIso2(iso2)) nameToIso2.set(normalizeCountryToken(name), iso2.toUpperCase());
  }

  for (const [alias, iso2] of Object.entries(COUNTRY_ALIAS_MAP)) {
    if (isIso2(iso2)) nameToIso2.set(normalizeCountryToken(alias), iso2.toUpperCase());
  }

  for (const feature of geojson?.features || []) {
    const properties = feature?.properties || {};
    const iso2 = String(properties['ISO3166-1-Alpha-2'] || '').toUpperCase();
    const iso3 = String(properties['ISO3166-1-Alpha-3'] || '').toUpperCase();
    const name = properties.name;
    if (isIso2(iso2)) {
      if (typeof name === 'string' && name.trim()) {
        nameToIso2.set(normalizeCountryToken(name), iso2);
      }
      if (isIso3(iso3)) iso3ToIso2.set(iso3, iso2);
    }
  }

  return { nameToIso2, iso3ToIso2 };
}

const DEFAULT_RESOLVERS = createCountryResolvers();

export function resolveIso2({ iso2, iso3, name }, resolvers = DEFAULT_RESOLVERS) {
  const upperIso2 = String(iso2 || '').trim().toUpperCase();
  if (isIso2(upperIso2)) return upperIso2;

  const upperIso3 = String(iso3 || '').trim().toUpperCase();
  if (isIso3(upperIso3)) {
    const mapped = resolvers.iso3ToIso2.get(upperIso3);
    if (mapped) return mapped;
  }

  const normalizedName = normalizeCountryToken(name);
  return resolvers.nameToIso2.get(normalizedName) || null;
}
