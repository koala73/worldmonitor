/**
 * World Bank indicator RPC cache identity.
 *
 * The Edge handler used to live-fetch api.worldbank.org on every cache miss.
 * Vercel Edge cannot reliably reach that host (production has returned 503
 * for every request for days) while the Railway seeder can. Keep the on-demand
 * cache key stable so seed-wb-indicators.mjs can populate the same keys the
 * RPC reads, and so a seeded `all` snapshot can filter custom country lists
 * when the live provider fails.
 *
 * Mirrored at scripts/shared/world-bank-rpc-cache.js for Railway
 * (rootDirectory=scripts). Keep the copies byte-identical.
 */

export const WORLD_BANK_RPC_CACHE_PREFIX = 'economic:worldbank:v2';
export const WORLD_BANK_DEFAULT_CACHE_COUNTRY = '__default__';
export const WORLD_BANK_LOOKBACKS = Object.freeze([5, 30]);
export const WORLD_BANK_RPC_USER_AGENT =
  'WorldMonitor/1.0 (+https://worldmonitor.app; list-world-bank-indicators)';

// Curated default country set for an omitted country_code. ISO-3 codes, same
// order as the previous handler-local TECH_COUNTRIES list.
export const WORLD_BANK_TECH_COUNTRIES = Object.freeze([
  'USA', 'CHN', 'JPN', 'DEU', 'KOR', 'GBR', 'IND', 'ISR', 'SGP', 'TWN',
  'FRA', 'CAN', 'SWE', 'NLD', 'CHE', 'FIN', 'IRL', 'AUS', 'BRA', 'IDN',
  'ARE', 'SAU', 'QAT', 'BHR', 'EGY', 'TUR',
  'MYS', 'THA', 'VNM', 'PHL',
  'ESP', 'ITA', 'POL', 'CZE', 'DNK', 'NOR', 'AUT', 'BEL', 'PRT', 'EST',
  'MEX', 'ARG', 'CHL', 'COL',
  'ZAF', 'NGA', 'KEN',
]);

// Documented public catalogue plus the tech-readiness seed indicators.
export const WORLD_BANK_CATALOGUE_INDICATORS = Object.freeze([
  'IT.NET.USER.ZS',
  'IT.CEL.SETS.P2',
  'IT.NET.BBND.P2',
  'IT.NET.SECR.P6',
  'GB.XPD.RSDV.GD.ZS',
  'IP.PAT.RESD',
  'IP.PAT.NRES',
  'IP.TMK.TOTL',
  'TX.VAL.TECH.MF.ZS',
  'BX.GSR.CCIS.ZS',
  'TM.VAL.ICTG.ZS.UN',
  'SE.TER.ENRR',
  'SE.XPD.TOTL.GD.ZS',
  'NY.GDP.MKTP.KD.ZG',
  'NY.GDP.PCAP.CD',
  'NE.EXP.GNFS.ZS',
  'NY.GDP.MKTP.CD',
]);

export function worldBankRpcCacheKey(indicatorCode, country, years, currentYear) {
  return `${WORLD_BANK_RPC_CACHE_PREFIX}:${indicatorCode}:${country}:${years}:${currentYear}`;
}

export function isWorldBankCountryRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const record = value;
  return typeof record.countryCode === 'string'
    && (record.countryIso2 === undefined || typeof record.countryIso2 === 'string')
    && typeof record.countryName === 'string'
    && typeof record.indicatorCode === 'string'
    && typeof record.indicatorName === 'string'
    && typeof record.year === 'number'
    && typeof record.value === 'number';
}

function countryAllowlist(country) {
  if (country === 'all') return null;
  if (!country || country === WORLD_BANK_DEFAULT_CACHE_COUNTRY) {
    return new Set(WORLD_BANK_TECH_COUNTRIES);
  }
  return new Set(country.split(';').filter(Boolean));
}

export function filterWorldBankRecords(records, country, years, currentYear) {
  if (!Array.isArray(records)) return [];
  const minYear = currentYear - years;
  const allowed = countryAllowlist(country);
  return records.filter((record) => {
    if (!isWorldBankCountryRecord(record)) return false;
    if (record.year < minYear || record.year > currentYear) return false;
    if (allowed && !allowed.has(record.countryCode) && !allowed.has(record.countryIso2)) return false;
    return true;
  });
}

export function worldBankRpcPayload(records, country, years, currentYear) {
  return {
    data: filterWorldBankRecords(records, country, years, currentYear),
    pagination: undefined,
  };
}

export function worldBankRpcCacheCommands(prefix, indicatorId, records, currentYear, ttlSeconds) {
  const commands = [];
  const ttl = String(ttlSeconds);
  for (const years of WORLD_BANK_LOOKBACKS) {
    const allPayload = worldBankRpcPayload(records, 'all', years, currentYear);
    if (allPayload.data.length === 0) continue;
    const defaultPayload = worldBankRpcPayload(
      records,
      WORLD_BANK_DEFAULT_CACHE_COUNTRY,
      years,
      currentYear,
    );
    commands.push([
      'SET',
      `${prefix}${worldBankRpcCacheKey(indicatorId, 'all', years, currentYear)}`,
      JSON.stringify(allPayload),
      'EX',
      ttl,
    ]);
    commands.push([
      'SET',
      `${prefix}${worldBankRpcCacheKey(indicatorId, WORLD_BANK_DEFAULT_CACHE_COUNTRY, years, currentYear)}`,
      JSON.stringify(defaultPayload),
      'EX',
      ttl,
    ]);
  }
  return commands;
}
