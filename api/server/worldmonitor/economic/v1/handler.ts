/**
 * Economic service handler -- implements the generated EconomicServiceHandler
 * interface with 4 RPCs proxying distinct upstream APIs:
 *   - getFredSeries: Federal Reserve Economic Data (FRED) time series
 *   - listWorldBankIndicators: World Bank development indicator data
 *   - getEnergyPrices: EIA energy commodity price data
 *   - getMacroSignals: 7-signal macro dashboard (Yahoo Finance, Alternative.me, Mempool)
 *
 * Consolidates legacy edge functions:
 *   - api/fred-data.js (FRED proxy)
 *   - api/worldbank.js (World Bank proxy)
 *   - EIA proxy (previously unimplemented)
 *   - api/macro-signals.js (macro signal dashboard)
 *
 * All RPCs have graceful degradation: return empty/fallback on upstream failure.
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
  GetMacroSignalsRequest,
  GetMacroSignalsResponse,
  FearGreedHistoryEntry,
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
// RPC 4: getMacroSignals -- Port from api/macro-signals.js
// 7-signal macro dashboard: 6 upstream APIs, in-memory cache (5min TTL)
// ========================================================================

const MACRO_CACHE_TTL = 300; // 5 minutes in seconds
let macroSignalsCached: GetMacroSignalsResponse | null = null;
let macroSignalsCacheTimestamp = 0;

async function fetchJSON(url: string, timeout = 8000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

function rateOfChange(prices: number[], days: number): number | null {
  if (!prices || prices.length < days + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  if (!past || past === 0) return null;
  return ((recent - past) / past) * 100;
}

function smaCalc(prices: number[], period: number): number | null {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function extractClosePrices(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.close?.filter((p: any) => p != null) || [];
  } catch {
    return [];
  }
}

function extractVolumes(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.volume?.filter((v: any) => v != null) || [];
  } catch {
    return [];
  }
}

function extractAlignedPriceVolume(chart: any): Array<{ price: number; volume: number }> {
  try {
    const result = chart?.chart?.result?.[0];
    const closes: any[] = result?.indicators?.quote?.[0]?.close || [];
    const volumes: any[] = result?.indicators?.quote?.[0]?.volume || [];
    const pairs: Array<{ price: number; volume: number }> = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && volumes[i] != null) {
        pairs.push({ price: closes[i], volume: volumes[i] });
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

function buildFallbackResult(): GetMacroSignalsResponse {
  return {
    timestamp: new Date().toISOString(),
    verdict: 'UNKNOWN',
    bullishCount: 0,
    totalCount: 0,
    signals: {
      liquidity: { status: 'UNKNOWN', sparkline: [] },
      flowStructure: { status: 'UNKNOWN' },
      macroRegime: { status: 'UNKNOWN' },
      technicalTrend: { status: 'UNKNOWN', sparkline: [] },
      hashRate: { status: 'UNKNOWN' },
      miningCost: { status: 'UNKNOWN' },
      fearGreed: { status: 'UNKNOWN', history: [] },
    },
    meta: { qqqSparkline: [] },
    unavailable: true,
  };
}

async function computeMacroSignals(): Promise<GetMacroSignalsResponse> {
  const yahooBase = 'https://query1.finance.yahoo.com/v8/finance/chart';
  const [jpyChart, btcChart, qqqChart, xlpChart, fearGreed, mempoolHash] = await Promise.allSettled([
    fetchJSON(`${yahooBase}/JPY=X?range=1y&interval=1d`),
    fetchJSON(`${yahooBase}/BTC-USD?range=1y&interval=1d`),
    fetchJSON(`${yahooBase}/QQQ?range=1y&interval=1d`),
    fetchJSON(`${yahooBase}/XLP?range=1y&interval=1d`),
    fetchJSON('https://api.alternative.me/fng/?limit=30&format=json'),
    fetchJSON('https://mempool.space/api/v1/mining/hashrate/1m'),
  ]);

  const jpyPrices = jpyChart.status === 'fulfilled' ? extractClosePrices(jpyChart.value) : [];
  const btcPrices = btcChart.status === 'fulfilled' ? extractClosePrices(btcChart.value) : [];
  const btcAligned = btcChart.status === 'fulfilled' ? extractAlignedPriceVolume(btcChart.value) : [];
  const qqqPrices = qqqChart.status === 'fulfilled' ? extractClosePrices(qqqChart.value) : [];
  const xlpPrices = xlpChart.status === 'fulfilled' ? extractClosePrices(xlpChart.value) : [];

  // 1. Liquidity Signal (JPY 30d ROC)
  const jpyRoc30 = rateOfChange(jpyPrices, 30);
  const liquidityStatus = jpyRoc30 !== null
    ? (jpyRoc30 < -2 ? 'SQUEEZE' : 'NORMAL')
    : 'UNKNOWN';

  // 2. Flow Structure (BTC vs QQQ 5d return)
  const btcReturn5 = rateOfChange(btcPrices, 5);
  const qqqReturn5 = rateOfChange(qqqPrices, 5);
  let flowStatus = 'UNKNOWN';
  if (btcReturn5 !== null && qqqReturn5 !== null) {
    const gap = btcReturn5 - qqqReturn5;
    flowStatus = Math.abs(gap) > 5 ? 'PASSIVE GAP' : 'ALIGNED';
  }

  // 3. Macro Regime (QQQ/XLP 20d ROC)
  const qqqRoc20 = rateOfChange(qqqPrices, 20);
  const xlpRoc20 = rateOfChange(xlpPrices, 20);
  let regimeStatus = 'UNKNOWN';
  if (qqqRoc20 !== null && xlpRoc20 !== null) {
    regimeStatus = qqqRoc20 > xlpRoc20 ? 'RISK-ON' : 'DEFENSIVE';
  }

  // 4. Technical Trend (BTC vs SMA50 + VWAP)
  const btcSma50 = smaCalc(btcPrices, 50);
  const btcSma200 = smaCalc(btcPrices, 200);
  const btcCurrent = btcPrices.length > 0 ? btcPrices[btcPrices.length - 1] : null;

  // Compute VWAP from aligned price/volume pairs (30d)
  let btcVwap: number | null = null;
  if (btcAligned.length >= 30) {
    const last30 = btcAligned.slice(-30);
    let sumPV = 0, sumV = 0;
    for (const { price, volume } of last30) {
      sumPV += price * volume;
      sumV += volume;
    }
    if (sumV > 0) btcVwap = +(sumPV / sumV).toFixed(0);
  }

  let trendStatus = 'UNKNOWN';
  let mayerMultiple: number | null = null;
  if (btcCurrent && btcSma50) {
    const aboveSma = btcCurrent > btcSma50 * 1.02;
    const belowSma = btcCurrent < btcSma50 * 0.98;
    const aboveVwap = btcVwap ? btcCurrent > btcVwap : null;
    if (aboveSma && aboveVwap !== false) trendStatus = 'BULLISH';
    else if (belowSma && aboveVwap !== true) trendStatus = 'BEARISH';
    else trendStatus = 'NEUTRAL';
  }
  if (btcCurrent && btcSma200) {
    mayerMultiple = +(btcCurrent / btcSma200).toFixed(2);
  }

  // 5. Hash Rate
  let hashStatus = 'UNKNOWN';
  let hashChange: number | null = null;
  if (mempoolHash.status === 'fulfilled') {
    const hr = mempoolHash.value?.hashrates || mempoolHash.value;
    if (Array.isArray(hr) && hr.length >= 2) {
      const recent = hr[hr.length - 1]?.avgHashrate || hr[hr.length - 1];
      const older = hr[0]?.avgHashrate || hr[0];
      if (recent && older && older > 0) {
        hashChange = +((recent - older) / older * 100).toFixed(1);
        hashStatus = hashChange > 3 ? 'GROWING' : hashChange < -3 ? 'DECLINING' : 'STABLE';
      }
    }
  }

  // 6. Mining Cost (hashrate-based model)
  let miningStatus = 'UNKNOWN';
  if (btcCurrent && hashChange !== null) {
    miningStatus = btcCurrent > 60000 ? 'PROFITABLE' : btcCurrent > 40000 ? 'TIGHT' : 'SQUEEZE';
  }

  // 7. Fear & Greed
  let fgValue: number | undefined;
  let fgLabel = 'UNKNOWN';
  let fgHistory: FearGreedHistoryEntry[] = [];
  if (fearGreed.status === 'fulfilled' && fearGreed.value?.data) {
    const data = fearGreed.value.data;
    const parsed = parseInt(data[0]?.value, 10);
    fgValue = Number.isFinite(parsed) ? parsed : undefined;
    fgLabel = data[0]?.value_classification || 'UNKNOWN';
    fgHistory = data.slice(0, 30).map((d: any) => ({
      value: parseInt(d.value, 10),
      date: new Date(parseInt(d.timestamp, 10) * 1000).toISOString().slice(0, 10),
    })).reverse();
  }

  // Sparkline data
  const btcSparkline = btcPrices.slice(-30);
  const qqqSparkline = qqqPrices.slice(-30);
  const jpySparkline = jpyPrices.slice(-30);

  // Overall Verdict
  let bullishCount = 0;
  let totalCount = 0;
  const signalList = [
    { name: 'Liquidity', status: liquidityStatus, bullish: liquidityStatus === 'NORMAL' },
    { name: 'Flow Structure', status: flowStatus, bullish: flowStatus === 'ALIGNED' },
    { name: 'Macro Regime', status: regimeStatus, bullish: regimeStatus === 'RISK-ON' },
    { name: 'Technical Trend', status: trendStatus, bullish: trendStatus === 'BULLISH' },
    { name: 'Hash Rate', status: hashStatus, bullish: hashStatus === 'GROWING' },
    { name: 'Mining Cost', status: miningStatus, bullish: miningStatus === 'PROFITABLE' },
    { name: 'Fear & Greed', status: fgLabel, bullish: fgValue !== undefined && fgValue > 50 },
  ];

  for (const s of signalList) {
    if (s.status !== 'UNKNOWN') {
      totalCount++;
      if (s.bullish) bullishCount++;
    }
  }

  const verdict = totalCount === 0 ? 'UNKNOWN' : (bullishCount / totalCount >= 0.57 ? 'BUY' : 'CASH');

  return {
    timestamp: new Date().toISOString(),
    verdict,
    bullishCount,
    totalCount,
    signals: {
      liquidity: {
        status: liquidityStatus,
        value: jpyRoc30 !== null ? +jpyRoc30.toFixed(2) : undefined,
        sparkline: jpySparkline,
      },
      flowStructure: {
        status: flowStatus,
        btcReturn5: btcReturn5 !== null ? +btcReturn5.toFixed(2) : undefined,
        qqqReturn5: qqqReturn5 !== null ? +qqqReturn5.toFixed(2) : undefined,
      },
      macroRegime: {
        status: regimeStatus,
        qqqRoc20: qqqRoc20 !== null ? +qqqRoc20.toFixed(2) : undefined,
        xlpRoc20: xlpRoc20 !== null ? +xlpRoc20.toFixed(2) : undefined,
      },
      technicalTrend: {
        status: trendStatus,
        btcPrice: btcCurrent ?? undefined,
        sma50: btcSma50 ? +btcSma50.toFixed(0) : undefined,
        sma200: btcSma200 ? +btcSma200.toFixed(0) : undefined,
        vwap30d: btcVwap ?? undefined,
        mayerMultiple: mayerMultiple ?? undefined,
        sparkline: btcSparkline,
      },
      hashRate: {
        status: hashStatus,
        change30d: hashChange ?? undefined,
      },
      miningCost: { status: miningStatus },
      fearGreed: {
        status: fgLabel,
        value: fgValue,
        history: fgHistory,
      },
    },
    meta: { qqqSparkline },
    unavailable: false,
  };
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

  async getMacroSignals(
    _ctx: ServerContext,
    _req: GetMacroSignalsRequest,
  ): Promise<GetMacroSignalsResponse> {
    const now = Date.now();
    if (macroSignalsCached && now - macroSignalsCacheTimestamp < MACRO_CACHE_TTL * 1000) {
      return macroSignalsCached;
    }

    try {
      const result = await computeMacroSignals();
      macroSignalsCached = result;
      macroSignalsCacheTimestamp = now;
      return result;
    } catch {
      const fallback = macroSignalsCached || buildFallbackResult();
      macroSignalsCached = fallback;
      macroSignalsCacheTimestamp = now;
      return fallback;
    }
  },
};
