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
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0; +https://worldmonitor.app)',
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
    const data = await fetchWorldBankIndicators(req);
    return { data, pagination: undefined };
  } catch {
    return { data: [], pagination: undefined };
  }
}
