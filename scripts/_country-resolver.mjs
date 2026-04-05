import { loadSharedConfig } from './_seed-utils.mjs';

const DEFAULT_COUNTRY_NAMES = loadSharedConfig('country-names.json');
const DEFAULT_ISO3_MAP = loadSharedConfig('iso3-to-iso2.json');

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

export function createCountryResolvers(countryNames = DEFAULT_COUNTRY_NAMES, iso3Map = DEFAULT_ISO3_MAP) {
  const nameToIso2 = new Map();
  const iso3ToIso2 = new Map();

  for (const [name, iso2] of Object.entries(countryNames)) {
    if (isIso2(iso2)) nameToIso2.set(normalizeCountryToken(name), iso2.toUpperCase());
  }

  for (const [iso3, iso2] of Object.entries(iso3Map)) {
    if (isIso3(iso3) && isIso2(iso2)) iso3ToIso2.set(iso3, iso2.toUpperCase());
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
