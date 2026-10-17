/**
 * RPC: listWorldBankIndicators -- World Bank development indicator data
 * Port from api/worldbank.js
 *
 * Live-fetch api.worldbank.org on a cache miss so unknown indicators can still
 * fill in. Vercel Edge cannot reliably reach that host (production has returned
 * 503 for every request for days), the same way api.bls.gov is blocked from
 * some of our IPs. On live failure, serve the Railway `all` snapshot
 * seed-wb-indicators.mjs writes to the same v2 keys, filtered to the request.
 */

import type {
  ServerContext,
  ListWorldBankIndicatorsRequest,
  ListWorldBankIndicatorsResponse,
  WorldBankCountryData,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
import { cachedFetchJsonWithMeta, readCachedJson } from '../../../_shared/redis';
import { SeedUnavailableError } from '../../../_shared/required-seed';
import ISO3_TO_ISO2 from '../../../../shared/iso3-to-iso2.json';
import {
  WORLD_BANK_DEFAULT_CACHE_COUNTRY,
  WORLD_BANK_LOOKBACKS,
  WORLD_BANK_RPC_CACHE_PREFIX,
  WORLD_BANK_RPC_USER_AGENT,
  WORLD_BANK_TECH_COUNTRIES,
  filterWorldBankRecords,
  worldBankRpcCacheKey,
} from '../../../../shared/world-bank-rpc-cache.js';

const REDIS_CACHE_KEY = WORLD_BANK_RPC_CACHE_PREFIX;
const REDIS_CACHE_TTL = 86400; // 24 hr — annual data
const COUNTRY_CODES = new Map(Object.entries(ISO3_TO_ISO2).flatMap(([iso3, iso2]) => [
  [iso3, iso3] as const, [iso2, iso3] as const,
]));

/**
 * Two-letter World Bank ids that are not assigned ISO 3166-1 codes: income,
 * lending and regional aggregates plus the Channel Islands (JG). Taken from
 * https://api.worldbank.org/v2/country?format=json&per_page=500 on 2026-10-17,
 * keeping the letter-only `iso2Code` values; ids with a digit (1W, 8S, ...)
 * never passed this handler's two-letter shape.
 */
const WORLD_BANK_NON_ISO_IDS: ReadonlySet<string> = new Set([
  'EU', 'JG', 'OE', 'XC', 'XD', 'XE', 'XF', 'XG', 'XH', 'XI', 'XJ', 'XL', 'XM', 'XN',
  'XO', 'XP', 'XQ', 'XT', 'XU', 'XY', 'ZB', 'ZF', 'ZG', 'ZH', 'ZI', 'ZJ', 'ZQ', 'ZT',
]);

function invalidCountries(description: string): never {
  throw new ValidationError([{ field: 'country_code', description }]);
}

/**
 * Canonical `;`-joined country list, '' for the default list or 'all'. Throws
 * a country_code ValidationError for anything the World Bank would not serve,
 * so an unknown code is a 400 and not a provider call and cache read.
 */
function normalizeCountries(raw: string): string {
  const value = raw.trim().toUpperCase();
  const parts = value.split(';');
  if (raw.length > 1000 || parts.length > 250) {
    invalidCountries('country_code must list at most 250 codes in at most 1000 characters.');
  }
  if (!value) return '';
  if (value === 'ALL') return 'all';
  const countries = parts.map(part => {
    const code = part.trim();
    // The shared alias map is not an exhaustive ISO table. Preserve the
    // documented two-letter filter for assigned territories absent from it
    // and for World Bank aggregate ids.
    const country = COUNTRY_CODES.get(code)
      ?? (isAssignedCountryCode(code) || WORLD_BANK_NON_ISO_IDS.has(code) ? code : undefined);
    if (!country) {
      invalidCountries(`country_code ${JSON.stringify(code.slice(0, 16))} is not an ISO 3166-1 alpha-2 or alpha-3 country code or a World Bank aggregate id; separate codes with ";" or pass "all".`);
    }
    return country;
  });
  return [...new Set(countries)].sort().join(';');
}

function rpcResponse(records: WorldBankCountryData[]): ListWorldBankIndicatorsResponse {
  return {
    data: records.map(({ countryCode, countryName, indicatorCode, indicatorName, year, value }) => ({
      countryCode, countryName, indicatorCode, indicatorName, year, value,
    })),
    pagination: undefined,
  };
}

function seededResponse(
  records: unknown,
  country: string,
  years: number,
  currentYear: number,
): ListWorldBankIndicatorsResponse | null {
  if (!Array.isArray(records)) return null;
  return rpcResponse(filterWorldBankRecords(records, country || WORLD_BANK_DEFAULT_CACHE_COUNTRY, years, currentYear));
}

async function readSeededWorldBankResponse(
  indicator: string,
  country: string,
  years: number,
  currentYear: number,
): Promise<ListWorldBankIndicatorsResponse | null> {
  const lookbacks = [years, ...WORLD_BANK_LOOKBACKS.filter(lookback => lookback > years)];
  let emptySeed: ListWorldBankIndicatorsResponse | null = null;
  for (const snapshotYear of [currentYear, currentYear - 1]) {
    for (const lookback of lookbacks) {
      const seeded = await readCachedJson(worldBankRpcCacheKey(indicator, 'all', lookback, snapshotYear));
      if (seeded.status === 'error') {
        logCacheReadErrorForSeed(seeded.error);
        continue;
      }
      if (seeded.status !== 'hit' || !seeded.value || typeof seeded.value !== 'object') continue;
      const payload = seeded.value as { data?: unknown };
      const response = seededResponse(payload.data, country, years, currentYear);
      if (!response) continue;
      if (response.data.length > 0) return response;
      emptySeed = response;
    }
  }
  return emptySeed;
}

function logCacheReadErrorForSeed(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn('[world-bank] seeded snapshot read failed:', message);
}

async function fetchWorldBankIndicators(
  indicator: string,
  countryList: string,
  years: number,
  currentYear: number,
): Promise<WorldBankCountryData[]> {
  try {
    const startYear = currentYear - years;

    const wbUrl = `https://api.worldbank.org/v2/country/${encodeURIComponent(countryList)}/indicator/${encodeURIComponent(indicator)}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

    const response = await fetch(wbUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': WORLD_BANK_RPC_USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new SeedUnavailableError(REDIS_CACHE_KEY);

    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) throw new SeedUnavailableError(REDIS_CACHE_KEY);
    if (data[1] === null && (data[0]?.total === 0 || data[0]?.total === '0')) return [];
    if (!Array.isArray(data[1])) throw new SeedUnavailableError(REDIS_CACHE_KEY);

    const records: Array<{
      countryiso3code?: string;
      country?: { id?: string; value?: string };
      indicator?: { value?: string };
      date?: string;
      value?: number | null;
    }> = data[1];
    const indicatorName = records[0]?.indicator?.value || indicator;

    return records
      .filter((record) => record.countryiso3code && record.value !== null)
      .map((record): WorldBankCountryData => ({
        countryCode: record.countryiso3code || record.country?.id || '',
        countryName: record.country?.value || '',
        indicatorCode: indicator,
        indicatorName,
        year: parseInt(record.date ?? '', 10) || 0,
        value: record.value as number,
      }));
  } catch {
    throw new SeedUnavailableError(REDIS_CACHE_KEY);
  }
}

export async function listWorldBankIndicators(
  _ctx: ServerContext,
  req: ListWorldBankIndicatorsRequest,
): Promise<ListWorldBankIndicatorsResponse> {
  // Outside the try: its catch turns every error into SeedUnavailableError.
  const country = normalizeCountries(req.countryCode ?? '');
  try {
    // The exported client accepts generic indicator codes, not just the tech
    // display catalogue. Bound their grammar without restricting that contract.
    if (req.indicatorCode.length > 64 || !/^[A-Z0-9_]+(?:\.[A-Z0-9_]+)+$/.test(req.indicatorCode)) {
      return { data: [], pagination: undefined };
    }
    if (!Number.isInteger(req.year)) return { data: [], pagination: undefined };
    // Match the existing World Bank relay's maximum lookback.
    const years = req.year > 0 ? Math.min(req.year, 30) : 5;
    const currentYear = new Date().getFullYear();
    const cacheKey = worldBankRpcCacheKey(
      req.indicatorCode,
      country || WORLD_BANK_DEFAULT_CACHE_COUNTRY,
      years,
      currentYear,
    );
    try {
      const result = await cachedFetchJsonWithMeta<ListWorldBankIndicatorsResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
        const data = await fetchWorldBankIndicators(
          req.indicatorCode,
          country || WORLD_BANK_TECH_COUNTRIES.join(';'),
          years,
          currentYear,
        );
        return { data, pagination: undefined };
      }, 120, { cacheFailures: false });
      if (!result.data || !Array.isArray(result.data.data)) throw new SeedUnavailableError(cacheKey);
      return rpcResponse(result.data.data);
    } catch {
      const seeded = await readSeededWorldBankResponse(req.indicatorCode, country, years, currentYear);
      if (seeded) return seeded;
      throw new SeedUnavailableError(REDIS_CACHE_KEY);
    }
  } catch {
    throw new SeedUnavailableError(REDIS_CACHE_KEY);
  }
}
