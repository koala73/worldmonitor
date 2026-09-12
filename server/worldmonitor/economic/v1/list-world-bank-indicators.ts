/**
 * RPC: listWorldBankIndicators -- World Bank development indicator data
 * Port from api/worldbank.js
 */

import type {
  ServerContext,
  ListWorldBankIndicatorsRequest,
  ListWorldBankIndicatorsResponse,
  WorldBankCountryData,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import ISO3_TO_ISO2 from '../../../../shared/iso3-to-iso2.json';

// Do not reuse v1 entries where explicit "all" and curated defaults collided.
const REDIS_CACHE_KEY = 'economic:worldbank:v2';
const REDIS_CACHE_TTL = 86400; // 24 hr — annual data
const COUNTRY_CODES = new Map(Object.entries(ISO3_TO_ISO2).flatMap(([iso3, iso2]) => [
  [iso3, iso3] as const, [iso2, iso3] as const,
]));

const TECH_COUNTRIES = [
  'USA', 'CHN', 'JPN', 'DEU', 'KOR', 'GBR', 'IND', 'ISR', 'SGP', 'TWN',
  'FRA', 'CAN', 'SWE', 'NLD', 'CHE', 'FIN', 'IRL', 'AUS', 'BRA', 'IDN',
  'ARE', 'SAU', 'QAT', 'BHR', 'EGY', 'TUR',
  'MYS', 'THA', 'VNM', 'PHL',
  'ESP', 'ITA', 'POL', 'CZE', 'DNK', 'NOR', 'AUT', 'BEL', 'PRT', 'EST',
  'MEX', 'ARG', 'CHL', 'COL',
  'ZAF', 'NGA', 'KEN',
];

function normalizeCountries(raw: string): string | null {
  if (raw.length > 1000) return null;
  const value = raw.trim().toUpperCase();
  if (!value) return '';
  if (value === 'ALL') return 'all';
  const parts = value.split(';');
  if (parts.length > 250) return null;
  const countries = parts.map(part => {
    const code = part.trim();
    // The shared alias map is not an exhaustive ISO table. Preserve the
    // documented two-letter filter for territories absent from that map.
    return COUNTRY_CODES.get(code) ?? (/^[A-Z]{2}$/.test(code) ? code : undefined);
  });
  if (countries.some(country => !country)) return null;
  return [...new Set(countries)].sort().join(';');
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
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!data || !Array.isArray(data) || data.length < 2 || !data[1]) return [];

    const records: any[] = data[1];
    const indicatorName = records[0]?.indicator?.value || indicator;

    return records
      .filter((r: any) => r.countryiso3code && r.value !== null)
      .map((r: any): WorldBankCountryData => ({
        countryCode: r.countryiso3code || r.country?.id || '',
        countryName: r.country?.value || '',
        indicatorCode: indicator,
        indicatorName,
        year: parseInt(r.date, 10) || 0,
        value: r.value,
      }));
  } catch {
    return [];
  }
}

export async function listWorldBankIndicators(
  _ctx: ServerContext,
  req: ListWorldBankIndicatorsRequest,
): Promise<ListWorldBankIndicatorsResponse> {
  try {
    // The exported client accepts generic indicator codes, not just the tech
    // display catalogue. Bound their grammar without restricting that contract.
    if (req.indicatorCode.length > 64 || !/^[A-Z0-9_]+(?:\.[A-Z0-9_]+)+$/.test(req.indicatorCode)) {
      return { data: [], pagination: undefined };
    }
    const country = normalizeCountries(req.countryCode);
    if (country === null || !Number.isInteger(req.year)) return { data: [], pagination: undefined };
    // Match the existing World Bank relay's maximum lookback.
    const years = req.year > 0 ? Math.min(req.year, 30) : 5;
    const currentYear = new Date().getFullYear();
    const cacheKey = `${REDIS_CACHE_KEY}:${req.indicatorCode}:${country || '__default__'}:${years}:${currentYear}`;
    const result = await cachedFetchJson<ListWorldBankIndicatorsResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      const data = await fetchWorldBankIndicators(req.indicatorCode, country || TECH_COUNTRIES.join(';'), years, currentYear);
      return data.length > 0 ? { data, pagination: undefined } : null;
    });
    return result || { data: [], pagination: undefined };
  } catch {
    return { data: [], pagination: undefined };
  }
}
