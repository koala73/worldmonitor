/**
 * Unified economic service module -- replaces three legacy services:
 *   - src/services/fred.ts (FRED economic data)
 *   - src/services/oil-analytics.ts (EIA energy data)
 *   - src/services/worldbank.ts (World Bank indicators)
 *
 * All data now flows through the EconomicServiceClient RPC.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  EconomicServiceClient,
  ApiError,
  type GetFredSeriesResponse,
  type GetFredSeriesBatchResponse,
  type ListWorldBankIndicatorsResponse,
  type WorldBankCountryData as ProtoWorldBankCountryData,
  type GetEnergyPricesResponse,
  type EnergyPrice as ProtoEnergyPrice,
  type GetEnergyCapacityResponse,
  type GetBisPolicyRatesResponse,
  type GetBisExchangeRatesResponse,
  type GetBisCreditResponse,
  type BisPolicyRate,
  type BisExchangeRate,
  type BisCreditToGdp,
  type GetNationalDebtResponse,
  type NationalDebtEntry,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getCSSColor } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';
import { dataFreshness } from '../data-freshness';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

// ---- Client + Circuit Breakers ----

const client = new EconomicServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const WB_BREAKERS_WARN_THRESHOLD = 50;
const wbBreakers = new Map<string, ReturnType<typeof createCircuitBreaker<ListWorldBankIndicatorsResponse>>>();

function getWbBreaker(indicatorCode: string) {
  if (!wbBreakers.has(indicatorCode)) {
    if (wbBreakers.size >= WB_BREAKERS_WARN_THRESHOLD) {
      console.warn(`[wb] breaker pool at ${wbBreakers.size} — unexpected growth, investigate getWbBreaker callers`);
    }
    wbBreakers.set(indicatorCode, createCircuitBreaker<ListWorldBankIndicatorsResponse>({
      name: `WB:${indicatorCode}`,
      cacheTtlMs: 30 * 60 * 1000,
      persistCache: true,
    }));
  }
  return wbBreakers.get(indicatorCode)!;
}
const eiaBreaker = createCircuitBreaker<GetEnergyPricesResponse>({ name: 'EIA Energy', cacheTtlMs: 15 * 60 * 1000, persistCache: true });
const capacityBreaker = createCircuitBreaker<GetEnergyCapacityResponse>({ name: 'EIA Capacity', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const bisPolicyBreaker = createCircuitBreaker<GetBisPolicyRatesResponse>({ name: 'BIS Policy', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const bisEerBreaker = createCircuitBreaker<GetBisExchangeRatesResponse>({ name: 'BIS EER', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const bisCreditBreaker = createCircuitBreaker<GetBisCreditResponse>({ name: 'BIS Credit', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyFredBatchFallback: GetFredSeriesBatchResponse = { results: {}, fetched: 0, requested: 0 };
const fredBatchBreaker = createCircuitBreaker<GetFredSeriesBatchResponse>({ name: 'FRED Batch', cacheTtlMs: 15 * 60 * 1000, persistCache: true });
const emptyWbFallback: ListWorldBankIndicatorsResponse = { data: [], pagination: undefined };
const emptyEiaFallback: GetEnergyPricesResponse = { prices: [] };
const emptyCapacityFallback: GetEnergyCapacityResponse = { series: [] };
const emptyBisPolicyFallback: GetBisPolicyRatesResponse = { rates: [] };
const emptyBisEerFallback: GetBisExchangeRatesResponse = { rates: [] };
const emptyBisCreditFallback: GetBisCreditResponse = { entries: [] };

// ========================================================================
// FRED -- replaces src/services/fred.ts
// ========================================================================

export interface FredSeries {
  id: string;
  name: string;
  value: number | null;
  previousValue: number | null;
  change: number | null;
  changePercent: number | null;
  date: string;
  unit: string;
  observations: Array<{ date: string; value: number }>;
}

interface FredConfig {
  id: string;
  name: string;
  unit: string;
  precision: number;
  scaleDivisor?: number;
}

const FRED_SERIES: FredConfig[] = [
  { id: 'VIXCLS', name: 'VIX', unit: '', precision: 2 },
  { id: 'BAMLH0A0HYM2', name: 'HY Spread', unit: '%', precision: 2 },
  { id: 'ICSA', name: 'Jobless Claims', unit: '', precision: 0 },
  { id: 'MORTGAGE30US', name: '30Y Mortgage', unit: '%', precision: 2 },
  { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', precision: 2 },
  { id: 'T10Y2Y', name: '10Y-2Y Spread', unit: '%', precision: 2 },
  { id: 'M2SL', name: 'M2 Supply', unit: '$T', precision: 1, scaleDivisor: 1000 },
  { id: 'UNRATE', name: 'Unemployment', unit: '%', precision: 1 },
  { id: 'CPIAUCSL', name: 'CPI Index', unit: '', precision: 1 },
  { id: 'DGS10', name: '10Y Treasury', unit: '%', precision: 2 },
  { id: 'WALCL', name: 'Fed Total Assets', unit: '$T', precision: 1, scaleDivisor: 1000 },
];

function toDisplayValue(value: number, config: FredConfig): number {
  return value / (config.scaleDivisor ?? 1);
}

function roundValue(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

export async function fetchFredData(): Promise<FredSeries[]> {
  if (!isFeatureAvailable('economicFred')) return [];

  const resp = await fredBatchBreaker.execute(async () => {
    try {
      return await client.getFredSeriesBatch(
        { seriesIds: FRED_SERIES.map((c) => c.id), limit: 120 },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (err: unknown) {
      // 404 deploy-skew fallback: batch endpoint not yet deployed, use per-item calls
      if (err instanceof ApiError && err.statusCode === 404) {
        const items = await Promise.all(FRED_SERIES.map((c) =>
          client.getFredSeries({ seriesId: c.id, limit: 120 }, { signal: AbortSignal.timeout(20_000) })
            .catch(() => ({ series: undefined }) as GetFredSeriesResponse),
        ));
        const fallbackResults: Record<string, NonNullable<GetFredSeriesResponse['series']>> = {};
        for (const item of items) {
          if (item.series) fallbackResults[item.series.seriesId] = item.series;
        }
        return { results: fallbackResults, fetched: Object.keys(fallbackResults).length, requested: FRED_SERIES.length };
      }
      throw err;
    }
  }, emptyFredBatchFallback);

  const out: FredSeries[] = [];
  for (const config of FRED_SERIES) {
    const series = resp.results[config.id];
    if (!series) continue;
    const obs = series.observations;
    if (!obs || obs.length === 0) continue;

    if (obs.length >= 2) {
      const latest = obs[obs.length - 1]!;
      const previous = obs[obs.length - 2]!;
      const latestDisplayValue = toDisplayValue(latest.value, config);
      const previousDisplayValue = toDisplayValue(previous.value, config);
      const change = latestDisplayValue - previousDisplayValue;
      const changePercent = previous.value !== 0
        ? ((latest.value - previous.value) / previous.value) * 100
        : null;

      out.push({
        id: config.id, name: config.name,
        value: roundValue(latestDisplayValue, config.precision),
        previousValue: roundValue(previousDisplayValue, config.precision),
        change: roundValue(change, config.precision),
        changePercent: changePercent !== null ? Number(changePercent.toFixed(2)) : null,
        date: latest.date, unit: config.unit,
        observations: obs.slice(-30).map(o => ({ date: o.date, value: toDisplayValue(o.value, config) })),
      });
    } else {
      const latest = obs[0]!;
      const displayValue = toDisplayValue(latest.value, config);
      out.push({
        id: config.id, name: config.name,
        value: roundValue(displayValue, config.precision),
        previousValue: null, change: null, changePercent: null,
        date: latest.date, unit: config.unit,
        observations: obs.map(o => ({ date: o.date, value: toDisplayValue(o.value, config) })),
      });
    }
  }
  return out;
}

export function getFredStatus(): string {
  return fredBatchBreaker.getStatus();
}

export function getChangeClass(change: number | null): string {
  if (change === null) return '';
  if (change > 0) return 'positive';
  if (change < 0) return 'negative';
  return '';
}

function getFractionDigits(value: number): number {
  const text = String(value);
  const decimal = text.split('.')[1];
  return decimal ? decimal.length : 0;
}

function formatValueWithUnit(value: number, unit: string): string {
  const digits = getFractionDigits(value);
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (!unit) return formatted;
  if (unit.startsWith('$')) return `$${formatted}${unit.slice(1)}`;
  return `${formatted}${unit}`;
}

export function formatFredValue(value: number | null, unit: string): string {
  if (value === null) return 'N/A';
  return formatValueWithUnit(value, unit);
}

export function formatChange(change: number | null, unit: string): string {
  if (change === null) return 'N/A';
  const sign = change > 0 ? '+' : change < 0 ? '-' : '';
  return `${sign}${formatValueWithUnit(Math.abs(change), unit)}`;
}

// ========================================================================
// Oil/Energy -- replaces src/services/oil-analytics.ts
// ========================================================================

export interface OilDataPoint {
  date: string;
  value: number;
  unit: string;
}

export interface OilMetric {
  id: string;
  name: string;
  description: string;
  current: number;
  previous: number;
  changePct: number;
  unit: string;
  trend: 'up' | 'down' | 'stable';
  lastUpdated: string;
}

export interface OilAnalytics {
  wtiPrice: OilMetric | null;
  brentPrice: OilMetric | null;
  usProduction: OilMetric | null;
  usInventory: OilMetric | null;
  fetchedAt: Date;
}

function protoEnergyToOilMetric(proto: ProtoEnergyPrice): OilMetric {
  const change = proto.change;
  return {
    id: proto.commodity,
    name: proto.name,
    description: `${proto.name} price/volume`,
    current: proto.price,
    previous: change !== 0 ? proto.price / (1 + change / 100) : proto.price,
    changePct: Math.round(change * 10) / 10,
    unit: proto.unit,
    trend: change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'stable',
    lastUpdated: proto.priceAt ? new Date(proto.priceAt).toISOString() : new Date().toISOString(),
  };
}

export async function checkEiaStatus(): Promise<boolean> {
  if (!isFeatureAvailable('energyEia')) return false;
  try {
    const resp = await eiaBreaker.execute(async () => {
      return client.getEnergyPrices({ commodities: ['wti'] }, { signal: AbortSignal.timeout(20_000) });
    }, emptyEiaFallback);
    return resp.prices.length > 0;
  } catch {
    return false;
  }
}

export async function fetchOilAnalytics(): Promise<OilAnalytics> {
  const empty: OilAnalytics = {
    wtiPrice: null, brentPrice: null, usProduction: null, usInventory: null, fetchedAt: new Date(),
  };

  if (!isFeatureAvailable('energyEia')) return empty;

  try {
    const resp = await eiaBreaker.execute(async () => {
      return client.getEnergyPrices({ commodities: [] }, { signal: AbortSignal.timeout(20_000) }); // all commodities
    }, emptyEiaFallback);

    const byId = new Map<string, ProtoEnergyPrice>();
    for (const p of resp.prices) byId.set(p.commodity, p);

    const result: OilAnalytics = {
      wtiPrice: byId.has('wti') ? protoEnergyToOilMetric(byId.get('wti')!) : null,
      brentPrice: byId.has('brent') ? protoEnergyToOilMetric(byId.get('brent')!) : null,
      usProduction: byId.has('production') ? protoEnergyToOilMetric(byId.get('production')!) : null,
      usInventory: byId.has('inventory') ? protoEnergyToOilMetric(byId.get('inventory')!) : null,
      fetchedAt: new Date(),
    };

    const metricCount = [result.wtiPrice, result.brentPrice, result.usProduction, result.usInventory]
      .filter(Boolean).length;
    if (metricCount > 0) {
      dataFreshness.recordUpdate('oil', metricCount);
    }

    return result;
  } catch {
    dataFreshness.recordError('oil', 'Fetch failed');
    return empty;
  }
}

export function formatOilValue(value: number, unit: string): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  if (unit.includes('$')) return `$${v.toFixed(2)}`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(1);
}

export function getTrendIndicator(trend: OilMetric['trend']): string {
  switch (trend) {
    case 'up': return '\u25B2';
    case 'down': return '\u25BC';
    default: return '\u25CF';
  }
}

export function getTrendColor(trend: OilMetric['trend'], inverse = false): string {
  const upColor = inverse ? getCSSColor('--semantic-normal') : getCSSColor('--semantic-critical');
  const downColor = inverse ? getCSSColor('--semantic-critical') : getCSSColor('--semantic-normal');
  switch (trend) {
    case 'up': return upColor;
    case 'down': return downColor;
    default: return getCSSColor('--text-dim');
  }
}

// ========================================================================
// EIA Capacity -- installed generation capacity (solar, wind, coal)
// ========================================================================

export async function fetchEnergyCapacityRpc(
  energySources?: string[],
  years?: number,
): Promise<GetEnergyCapacityResponse> {
  if (!isFeatureAvailable('energyEia')) return emptyCapacityFallback;
  try {
    return await capacityBreaker.execute(async () => {
      return client.getEnergyCapacity({
        energySources: energySources ?? [],
        years: years ?? 0,
      }, { signal: AbortSignal.timeout(20_000) });
    }, emptyCapacityFallback);
  } catch {
    return emptyCapacityFallback;
  }
}

// ========================================================================
// World Bank -- replaces src/services/worldbank.ts
// ========================================================================

interface WbCountryDataPoint {
  year: string;
  value: number;
}

interface WbCountryData {
  code: string;
  name: string;
  values: WbCountryDataPoint[];
}

interface WbLatestValue {
  code: string;
  name: string;
  year: string;
  value: number;
}

export interface WorldBankResponse {
  indicator: string;
  indicatorName: string;
  metadata: { page: number; pages: number; total: number };
  byCountry: Record<string, WbCountryData>;
  latestByCountry: Record<string, WbLatestValue>;
  timeSeries: Array<{
    countryCode: string;
    countryName: string;
    year: string;
    value: number;
  }>;
}

const TECH_INDICATORS: Record<string, string> = {
  'IT.NET.USER.ZS': 'Internet Users (% of population)',
  'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
  'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
  'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
  'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
  'IP.PAT.RESD': 'Patent Applications (residents)',
  'IP.PAT.NRES': 'Patent Applications (non-residents)',
  'IP.TMK.TOTL': 'Trademark Applications',
  'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
  'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
  'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
  'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
  'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
  'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
  'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
  'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
};

const TECH_COUNTRIES = [
  'USA', 'CHN', 'JPN', 'DEU', 'KOR', 'GBR', 'IND', 'ISR', 'SGP', 'TWN',
  'FRA', 'CAN', 'SWE', 'NLD', 'CHE', 'FIN', 'IRL', 'AUS', 'BRA', 'IDN',
  'ARE', 'SAU', 'QAT', 'BHR', 'EGY', 'TUR',
  'MYS', 'THA', 'VNM', 'PHL',
  'ESP', 'ITA', 'POL', 'CZE', 'DNK', 'NOR', 'AUT', 'BEL', 'PRT', 'EST',
  'MEX', 'ARG', 'CHL', 'COL',
  'ZAF', 'NGA', 'KEN',
];

export async function getAvailableIndicators(): Promise<{ indicators: Record<string, string>; defaultCountries: string[] }> {
  return { indicators: TECH_INDICATORS, defaultCountries: TECH_COUNTRIES };
}

function buildWorldBankResponse(
  indicator: string,
  records: ProtoWorldBankCountryData[],
): WorldBankResponse {
  const byCountry: Record<string, WbCountryData> = {};
  const latestByCountry: Record<string, WbLatestValue> = {};
  const timeSeries: WorldBankResponse['timeSeries'] = [];

  const indicatorName = records[0]?.indicatorName || TECH_INDICATORS[indicator] || indicator;

  for (const r of records) {
    const cc = r.countryCode;
    if (!cc) continue;

    const yearStr = String(r.year);

    if (!byCountry[cc]) {
      byCountry[cc] = { code: cc, name: r.countryName, values: [] };
    }
    byCountry[cc].values.push({ year: yearStr, value: r.value });

    if (!latestByCountry[cc] || yearStr > latestByCountry[cc].year) {
      latestByCountry[cc] = { code: cc, name: r.countryName, year: yearStr, value: r.value };
    }

    timeSeries.push({
      countryCode: cc,
      countryName: r.countryName,
      year: yearStr,
      value: r.value,
    });
  }

  // Sort values oldest first
  for (const c of Object.values(byCountry)) {
    c.values.sort((a, b) => a.year.localeCompare(b.year));
  }

  timeSeries.sort((a, b) => b.year.localeCompare(a.year) || a.countryCode.localeCompare(b.countryCode));

  return {
    indicator,
    indicatorName,
    metadata: { page: 1, pages: 1, total: records.length },
    byCountry,
    latestByCountry,
    timeSeries,
  };
}

export async function getIndicatorData(
  indicator: string,
  options: { countries?: string[]; years?: number } = {},
): Promise<WorldBankResponse> {
  const { countries, years = 5 } = options;

  const resp = await getWbBreaker(indicator).execute(async () => {
    return client.listWorldBankIndicators({
      indicatorCode: indicator,
      countryCode: countries?.join(';') || '',
      year: years,
      pageSize: 0,
      cursor: '',
    }, { signal: AbortSignal.timeout(20_000) });
  }, emptyWbFallback);

  return buildWorldBankResponse(indicator, resp.data);
}

export const INDICATOR_PRESETS = {
  digitalInfrastructure: [
    'IT.NET.USER.ZS',
    'IT.CEL.SETS.P2',
    'IT.NET.BBND.P2',
    'IT.NET.SECR.P6',
  ],
  innovation: [
    'GB.XPD.RSDV.GD.ZS',
    'IP.PAT.RESD',
    'IP.PAT.NRES',
  ],
  techTrade: [
    'TX.VAL.TECH.MF.ZS',
    'BX.GSR.CCIS.ZS',
  ],
  education: [
    'SE.TER.ENRR',
    'SE.XPD.TOTL.GD.ZS',
  ],
} as const;

export interface TechReadinessScore {
  country: string;
  countryName: string;
  score: number;
  rank: number;
  components: {
    internet: number | null;
    mobile: number | null;
    broadband: number | null;
    rdSpend: number | null;
  };
}

export async function getTechReadinessRankings(
  countries?: string[],
): Promise<TechReadinessScore[]> {
  // Fast path: bootstrap-hydrated data available on first page load
  const hydrated = getHydratedData('techReadiness') as TechReadinessScore[] | undefined;
  if (hydrated?.length && !countries) return hydrated;

  // Fallback: fetch the pre-computed seed key directly from bootstrap endpoint.
  // Data is seeded by seed-wb-indicators.mjs — never call WB API from frontend.
  try {
    const resp = await fetch(toApiUrl('/api/bootstrap?keys=techReadiness'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const { data } = (await resp.json()) as { data: { techReadiness?: TechReadinessScore[] } };
      if (data.techReadiness?.length) {
        const scores = countries
          ? data.techReadiness.filter(s => countries.includes(s.country))
          : data.techReadiness;
        return scores;
      }
    }
  } catch { /* fall through */ }

  return [];
}

export async function getCountryComparison(
  indicator: string,
  _countryCodes: string[],
): Promise<WorldBankResponse> {
  // All WB data is now pre-seeded by seed-wb-indicators.mjs.
  // This function is unused but kept for API compat.
  return {
    indicator,
    indicatorName: TECH_INDICATORS[indicator] || indicator,
    metadata: { page: 0, pages: 0, total: 0 },
    byCountry: {},
    latestByCountry: {},
    timeSeries: [],
  };
}

// ========================================================================
// BIS -- Central bank policy data
// ========================================================================

export type { BisPolicyRate, BisExchangeRate, BisCreditToGdp };
export type { NationalDebtEntry };

// ========================================================================
// National Debt Clock
// ========================================================================

// No persistCache: IndexedDB hydration on first call can deadlock in some browsers,
// causing the panel to hang indefinitely on "Loading debt data from IMF..."
const nationalDebtBreaker = createCircuitBreaker<GetNationalDebtResponse>({ name: 'National Debt', cacheTtlMs: 6 * 60 * 60 * 1000 });
const emptyNationalDebtFallback: GetNationalDebtResponse = { entries: [], seededAt: '', unavailable: true };

export async function getNationalDebtData(): Promise<GetNationalDebtResponse> {
  const hydrated = getHydratedData('nationalDebt') as GetNationalDebtResponse | undefined;
  if (hydrated?.entries?.length) return hydrated;

  // Race all fetch paths against a hard 20s deadline so the panel never hangs.
  return Promise.race([
    _fetchNationalDebt(),
    new Promise<GetNationalDebtResponse>(resolve =>
      setTimeout(() => resolve(emptyNationalDebtFallback), 20_000),
    ),
  ]);
}

async function _fetchNationalDebt(): Promise<GetNationalDebtResponse> {
  try {
    const resp = await fetch(toApiUrl('/api/bootstrap?keys=nationalDebt'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const { data } = (await resp.json()) as { data: { nationalDebt?: GetNationalDebtResponse } };
      if (data.nationalDebt?.entries?.length) return data.nationalDebt;
    }
  } catch { /* fall through to RPC */ }

  try {
    return await nationalDebtBreaker.execute(async () => {
      return client.getNationalDebt({}, { signal: AbortSignal.timeout(12_000) });
    }, emptyNationalDebtFallback);
  } catch {
    return emptyNationalDebtFallback;
  }
}

export interface BisData {
  policyRates: BisPolicyRate[];
  exchangeRates: BisExchangeRate[];
  creditToGdp: BisCreditToGdp[];
  fetchedAt: Date;
}

export async function fetchBisData(): Promise<BisData> {
  const empty: BisData = { policyRates: [], exchangeRates: [], creditToGdp: [], fetchedAt: new Date() };

  const hPolicy = getHydratedData('bisPolicy') as GetBisPolicyRatesResponse | undefined;
  const hEer = getHydratedData('bisExchange') as GetBisExchangeRatesResponse | undefined;
  const hCredit = getHydratedData('bisCredit') as GetBisCreditResponse | undefined;

  try {
    const [policy, eer, credit] = await Promise.all([
      hPolicy?.rates?.length ? Promise.resolve(hPolicy) : bisPolicyBreaker.execute(() => client.getBisPolicyRates({}, { signal: AbortSignal.timeout(20_000) }), emptyBisPolicyFallback),
      hEer?.rates?.length ? Promise.resolve(hEer) : bisEerBreaker.execute(() => client.getBisExchangeRates({}, { signal: AbortSignal.timeout(20_000) }), emptyBisEerFallback),
      hCredit?.entries?.length ? Promise.resolve(hCredit) : bisCreditBreaker.execute(() => client.getBisCredit({}, { signal: AbortSignal.timeout(20_000) }), emptyBisCreditFallback),
    ]);
    return {
      policyRates: policy.rates ?? [],
      exchangeRates: eer.rates ?? [],
      creditToGdp: credit.entries ?? [],
      fetchedAt: new Date(),
    };
  } catch {
    return empty;
  }
}
