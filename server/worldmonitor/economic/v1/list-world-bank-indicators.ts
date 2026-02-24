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
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'economic:worldbank:v1';
const REDIS_CACHE_TTL = 86400; // 24 hr — annual data

const TECH_COUNTRIES = [
  'USA', 'CHN', 'JPN', 'DEU', 'KOR', 'GBR', 'IND', 'ISR', 'SGP', 'TWN',
  'FRA', 'CAN', 'SWE', 'NLD', 'CHE', 'FIN', 'IRL', 'AUS', 'BRA', 'IDN',
  'ARE', 'SAU', 'QAT', 'BHR', 'EGY', 'TUR',
  'MYS', 'THA', 'VNM', 'PHL',
  'ESP', 'ITA', 'POL', 'CZE', 'DNK', 'NOR', 'AUT', 'BEL', 'PRT', 'EST',
  'MEX', 'ARG', 'CHL', 'COL',
  'ZAF', 'NGA', 'KEN',
];

async function fetchWorldBankIndicators(
  req: ListWorldBankIndicatorsRequest,
): Promise<WorldBankCountryData[]> {
  try {
    const indicator = req.indicatorCode;
    if (!indicator) return [];

    const countryList = req.countryCode || TECH_COUNTRIES.join(';');
    const currentYear = new Date().getFullYear();
    const years = req.year > 0 ? req.year : 5;
    const startYear = currentYear - years;

    const wbUrl = `https://api.worldbank.org/v2/country/${countryList}/indicator/${indicator}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

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
    const cacheKey = `${REDIS_CACHE_KEY}:${req.indicatorCode}:${req.countryCode || 'all'}:${req.year || 0}`;
    const cached = (await getCachedJson(cacheKey)) as ListWorldBankIndicatorsResponse | null;
    if (cached?.data?.length) return cached;

    const data = await fetchWorldBankIndicators(req);
    const result: ListWorldBankIndicatorsResponse = { data, pagination: undefined };
    if (data.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { data: [], pagination: undefined };
  }
}
