/**
 * Economic service handler -- implements the generated EconomicServiceHandler
 * interface with 3 RPCs proxying three distinct upstream APIs:
 *   - getFredSeries: Federal Reserve Economic Data (FRED) time series
 *   - listWorldBankIndicators: World Bank development indicator data
 *   - getEnergyPrices: EIA energy commodity price data
 *
 * Consolidates legacy edge functions:
 *   - api/fred-data.js (FRED proxy)
 *   - api/worldbank.js (World Bank proxy)
 *   - EIA proxy (previously unimplemented)
 *
 * All RPCs have graceful degradation: return empty on upstream failure.
 * No error logging on upstream failures (following established 2F-01 pattern).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  EconomicServiceHandler,
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
  FredSeries,
  FredObservation,
  ListWorldBankIndicatorsRequest,
  ListWorldBankIndicatorsResponse,
  WorldBankCountryData,
  GetEnergyPricesRequest,
  GetEnergyPricesResponse,
  EnergyPrice,
} from '../../../../../src/generated/server/worldmonitor/economic/v1/service_server';

// ========================================================================
// RPC 1: getFredSeries -- Port from api/fred-data.js
// ========================================================================

const FRED_API_BASE = 'https://api.stlouisfed.org/fred';

async function fetchFredSeries(req: GetFredSeriesRequest): Promise<FredSeries | undefined> {
  try {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) return undefined;

    const limit = req.limit > 0 ? Math.min(req.limit, 1000) : 120;

    // Fetch observations and series metadata in parallel
    const obsParams = new URLSearchParams({
      series_id: req.seriesId,
      api_key: apiKey,
      file_type: 'json',
      sort_order: 'desc',
      limit: String(limit),
    });

    const metaParams = new URLSearchParams({
      series_id: req.seriesId,
      api_key: apiKey,
      file_type: 'json',
    });

    const [obsResponse, metaResponse] = await Promise.all([
      fetch(`${FRED_API_BASE}/series/observations?${obsParams}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(`${FRED_API_BASE}/series?${metaParams}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    if (!obsResponse.ok) return undefined;

    const obsData = await obsResponse.json() as { observations?: Array<{ date: string; value: string }> };

    const observations: FredObservation[] = (obsData.observations || [])
      .map((obs) => {
        const value = parseFloat(obs.value);
        if (isNaN(value) || obs.value === '.') return null;
        return { date: obs.date, value };
      })
      .filter((o): o is FredObservation => o !== null)
      .reverse(); // oldest first

    let title = req.seriesId;
    let units = '';
    let frequency = '';

    if (metaResponse.ok) {
      const metaData = await metaResponse.json() as { seriess?: Array<{ title?: string; units?: string; frequency?: string }> };
      const meta = metaData.seriess?.[0];
      if (meta) {
        title = meta.title || req.seriesId;
        units = meta.units || '';
        frequency = meta.frequency || '';
      }
    }

    return {
      seriesId: req.seriesId,
      title,
      units,
      frequency,
      observations,
    };
  } catch {
    return undefined;
  }
}

// ========================================================================
// RPC 2: listWorldBankIndicators -- Port from api/worldbank.js
// ========================================================================

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

// ========================================================================
// RPC 3: getEnergyPrices -- EIA Open Data API v2
// ========================================================================

interface EiaSeriesConfig {
  commodity: string;
  name: string;
  unit: string;
  apiPath: string;
  seriesFacet: string;
}

const EIA_SERIES: EiaSeriesConfig[] = [
  {
    commodity: 'wti',
    name: 'WTI Crude Oil',
    unit: '$/barrel',
    apiPath: '/v2/petroleum/pri/spt/data/',
    seriesFacet: 'RWTC',
  },
  {
    commodity: 'brent',
    name: 'Brent Crude Oil',
    unit: '$/barrel',
    apiPath: '/v2/petroleum/pri/spt/data/',
    seriesFacet: 'RBRTE',
  },
];

async function fetchEiaSeries(
  config: EiaSeriesConfig,
  apiKey: string,
): Promise<EnergyPrice | null> {
  try {
    const params = new URLSearchParams({
      api_key: apiKey,
      'data[]': 'value',
      frequency: 'weekly',
      'facets[series][]': config.seriesFacet,
      'sort[0][column]': 'period',
      'sort[0][direction]': 'desc',
      length: '2',
    });

    const response = await fetch(`https://api.eia.gov${config.apiPath}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      response?: { data?: Array<{ period?: string; value?: number }> };
    };

    const rows = data.response?.data;
    if (!rows || rows.length === 0) return null;

    const current = rows[0]!;
    const previous = rows[1];

    const price = current.value ?? 0;
    const prevPrice = previous?.value ?? price;
    const change = prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
    const priceAt = current.period ? new Date(current.period).getTime() : Date.now();

    return {
      commodity: config.commodity,
      name: config.name,
      price,
      unit: config.unit,
      change: Math.round(change * 10) / 10,
      priceAt: Number.isFinite(priceAt) ? priceAt : Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchEnergyPrices(commodities: string[]): Promise<EnergyPrice[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return [];

  const series = commodities.length > 0
    ? EIA_SERIES.filter((s) => commodities.includes(s.commodity))
    : EIA_SERIES;

  const results = await Promise.all(series.map((s) => fetchEiaSeries(s, apiKey)));
  return results.filter((p): p is EnergyPrice => p !== null);
}

// ========================================================================
// Handler export
// ========================================================================

export const economicHandler: EconomicServiceHandler = {
  async getFredSeries(
    _ctx: ServerContext,
    req: GetFredSeriesRequest,
  ): Promise<GetFredSeriesResponse> {
    try {
      const series = await fetchFredSeries(req);
      return { series };
    } catch {
      return { series: undefined };
    }
  },

  async listWorldBankIndicators(
    _ctx: ServerContext,
    req: ListWorldBankIndicatorsRequest,
  ): Promise<ListWorldBankIndicatorsResponse> {
    try {
      const data = await fetchWorldBankIndicators(req);
      return { data, pagination: undefined };
    } catch {
      return { data: [], pagination: undefined };
    }
  },

  async getEnergyPrices(
    _ctx: ServerContext,
    req: GetEnergyPricesRequest,
  ): Promise<GetEnergyPricesResponse> {
    try {
      const prices = await fetchEnergyPrices(req.commodities);
      return { prices };
    } catch {
      return { prices: [] };
    }
  },
};
