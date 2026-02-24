/**
 * Unified economic service module -- replaces three legacy services:
 *   - src/services/fred.ts (FRED economic data)
 *   - src/services/oil-analytics.ts (EIA energy data)
 *   - src/services/worldbank.ts (World Bank indicators)
 *
 * All data now flows through the EconomicServiceClient RPC.
 */

import {
  EconomicServiceClient,
  type GetFredSeriesResponse,
  type ListWorldBankIndicatorsResponse,
  type WorldBankCountryData as ProtoWorldBankCountryData,
  type GetEnergyPricesResponse,
  type EnergyPrice as ProtoEnergyPrice,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getCSSColor } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';
import { dataFreshness } from '../data-freshness';

// ---- Client + Circuit Breakers ----

const client = new EconomicServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const fredBreaker = createCircuitBreaker<GetFredSeriesResponse>({ name: 'FRED Economic' });
const wbBreaker = createCircuitBreaker<ListWorldBankIndicatorsResponse>({ name: 'World Bank' });
const eiaBreaker = createCircuitBreaker<GetEnergyPricesResponse>({ name: 'EIA Energy' });

const emptyFredFallback: GetFredSeriesResponse = { series: undefined };
const emptyWbFallback: ListWorldBankIndicatorsResponse = { data: [], pagination: undefined };
const emptyEiaFallback: GetEnergyPricesResponse = { prices: [] };

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
}

interface FredConfig {
  id: string;
  name: string;
  unit: string;
  precision: number;
}

const FRED_SERIES: FredConfig[] = [
  { id: 'WALCL', name: 'Fed Total Assets', unit: '$B', precision: 0 },
  { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', precision: 2 },
  { id: 'T10Y2Y', name: '10Y-2Y Spread', unit: '%', precision: 2 },
  { id: 'UNRATE', name: 'Unemployment', unit: '%', precision: 1 },
  { id: 'CPIAUCSL', name: 'CPI Index', unit: '', precision: 1 },
  { id: 'DGS10', name: '10Y Treasury', unit: '%', precision: 2 },
  { id: 'VIXCLS', name: 'VIX', unit: '', precision: 2 },
];

async function fetchSingleFredSeries(config: FredConfig): Promise<FredSeries | null> {
  const resp = await fredBreaker.execute(async () => {
    return client.getFredSeries({ seriesId: config.id, limit: 120 });
  }, emptyFredFallback);

  const obs = resp.series?.observations;
  if (!obs || obs.length === 0) return null;

  if (obs.length >= 2) {
    const latest = obs[obs.length - 1]!;
    const previous = obs[obs.length - 2]!;
    const change = latest.value - previous.value;
    const changePercent = (change / previous.value) * 100;

    let displayValue = latest.value;
    if (config.id === 'WALCL') displayValue = latest.value / 1000;

    return {
      id: config.id,
      name: config.name,
      value: Number(displayValue.toFixed(config.precision)),
      previousValue: Number(previous.value.toFixed(config.precision)),
      change: Number(change.toFixed(config.precision)),
      changePercent: Number(changePercent.toFixed(2)),
      date: latest.date,
      unit: config.unit,
    };
  }

  const latest = obs[0]!;
  let displayValue = latest.value;
  if (config.id === 'WALCL') displayValue = latest.value / 1000;

  return {
    id: config.id,
    name: config.name,
    value: Number(displayValue.toFixed(config.precision)),
    previousValue: null,
    change: null,
    changePercent: null,
    date: latest.date,
    unit: config.unit,
  };
}

export async function fetchFredData(): Promise<FredSeries[]> {
  if (!isFeatureAvailable('economicFred')) return [];

  const results = await Promise.all(FRED_SERIES.map(fetchSingleFredSeries));
  return results.filter((r): r is FredSeries => r !== null);
}

export function getFredStatus(): string {
  return fredBreaker.getStatus();
}

export function getChangeClass(change: number | null): string {
  if (change === null) return '';
  if (change > 0) return 'positive';
  if (change < 0) return 'negative';
  return '';
}

export function formatChange(change: number | null, unit: string): string {
  if (change === null) return 'N/A';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change}${unit}`;
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
      return client.getEnergyPrices({ commodities: ['wti'] });
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
      return client.getEnergyPrices({ commodities: [] }); // all commodities
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

  const resp = await wbBreaker.execute(async () => {
    return client.listWorldBankIndicators({
      indicatorCode: indicator,
      countryCode: countries?.join(';') || '',
      year: years,
      pagination: undefined,
    });
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
  const [internet, mobile, broadband, rdSpend] = await Promise.all([
    getIndicatorData('IT.NET.USER.ZS', { countries, years: 5 }),
    getIndicatorData('IT.CEL.SETS.P2', { countries, years: 5 }),
    getIndicatorData('IT.NET.BBND.P2', { countries, years: 5 }),
    getIndicatorData('GB.XPD.RSDV.GD.ZS', { countries, years: 7 }),
  ]);

  const allCountries = new Set<string>();
  [internet, mobile, broadband, rdSpend].forEach((data) => {
    Object.keys(data.latestByCountry).forEach((c) => allCountries.add(c));
  });

  const normalize = (val: number | undefined, max: number): number | null => {
    if (val === undefined || val === null) return null;
    return Math.min(100, (val / max) * 100);
  };

  const scores: TechReadinessScore[] = [];

  for (const countryCode of allCountries) {
    const components = {
      internet: normalize(internet.latestByCountry[countryCode]?.value, 100),
      mobile: normalize(mobile.latestByCountry[countryCode]?.value, 150),
      broadband: normalize(broadband.latestByCountry[countryCode]?.value, 50),
      rdSpend: normalize(rdSpend.latestByCountry[countryCode]?.value, 5),
    };

    const weights = { internet: 30, mobile: 15, broadband: 20, rdSpend: 35 };
    let totalWeight = 0;
    let weightedSum = 0;

    for (const [key, weight] of Object.entries(weights)) {
      const val = components[key as keyof typeof components];
      if (val !== null) {
        weightedSum += val * weight;
        totalWeight += weight;
      }
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const countryName =
      internet.latestByCountry[countryCode]?.name ||
      mobile.latestByCountry[countryCode]?.name ||
      countryCode;

    scores.push({
      country: countryCode,
      countryName,
      score: Math.round(score * 10) / 10,
      rank: 0,
      components,
    });
  }

  scores.sort((a, b) => b.score - a.score);
  scores.forEach((s, i) => { s.rank = i + 1; });

  return scores;
}

export async function getCountryComparison(
  indicator: string,
  countryCodes: string[],
): Promise<WorldBankResponse> {
  return getIndicatorData(indicator, { countries: countryCodes, years: 10 });
}
