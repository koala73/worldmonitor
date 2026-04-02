/**
 * REIT intelligence service module.
 *
 * Wraps ReitsServiceClient RPCs with circuit breakers and bootstrap hydration.
 * Re-exports generated types for panel consumption.
 *
 * Data flow:
 *   Bootstrap hydration (instant) → RPC fallback (on stale/miss) → circuit breaker cache
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  ReitsServiceClient,
  type ListReitQuotesResponse,
  type GetReitCorrelationResponse,
  type ListReitPropertiesResponse,
  type GetReitSocialSentimentResponse,
  type ReitQuote,
  type ReitProperty,
  type ReitSocial,
  type ReitExposureSummary,
  type SectorRotationSignal,
  type FredIndicatorSnapshot,
  type CorrelationCoefficient,
  type ReitRegime,
} from '@/generated/client/worldmonitor/reits/v1/service_client';
import { createCircuitBreaker, getCircuitBreakerCooldownInfo } from '@/utils/circuit-breaker';
import { getHydratedData } from '@/services/bootstrap';

// Re-export types for panel consumption
export type {
  ListReitQuotesResponse,
  GetReitCorrelationResponse,
  ListReitPropertiesResponse,
  GetReitSocialSentimentResponse,
  ReitQuote,
  ReitProperty,
  ReitSocial,
  ReitExposureSummary,
  SectorRotationSignal,
  FredIndicatorSnapshot,
  CorrelationCoefficient,
  ReitRegime,
};

// ---- Client + Circuit Breakers ----

const client = new ReitsServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

const quotesBreaker = createCircuitBreaker<ListReitQuotesResponse>({
  name: 'REIT Quotes',
  cacheTtlMs: 5 * 60 * 1000,
  persistCache: true,
});

const correlationBreaker = createCircuitBreaker<GetReitCorrelationResponse>({
  name: 'REIT Correlation',
  cacheTtlMs: 15 * 60 * 1000,
  persistCache: true,
});

const propertiesBreaker = createCircuitBreaker<ListReitPropertiesResponse>({
  name: 'REIT Properties',
  cacheTtlMs: 60 * 60 * 1000, // 1hr — static data
  persistCache: true,
});

const socialBreaker = createCircuitBreaker<GetReitSocialSentimentResponse>({
  name: 'REIT Social',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

// ---- Fallbacks ----

const emptyQuotesFallback: ListReitQuotesResponse = {
  quotes: [],
  regime: 'REIT_REGIME_NEUTRAL',
  aiBriefing: '',
  sectorRotation: [],
  stale: true,
  lastUpdated: '',
};

const emptyCorrelationFallback: GetReitCorrelationResponse = {
  indicators: [],
  correlations: [],
  regime: 'REIT_REGIME_NEUTRAL',
  sectorRotation: [],
  yieldSpread: 0,
  lastUpdated: '',
};

const emptyPropertiesFallback: ListReitPropertiesResponse = {
  properties: [],
  exposureSummaries: [],
  lastUpdated: '',
};

const emptySocialFallback: GetReitSocialSentimentResponse = {
  sentiments: [],
  stale: true,
  lastUpdated: '',
  unavailableReason: '',
};

// ---- Mock data for local dev (no Vercel API available) ----

const IS_LOCALHOST = typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

function getMockQuotes(): ListReitQuotesResponse {
  const mockData: ReitQuote[] = [
    { symbol: 'O', name: 'Realty Income', sector: 'retail', price: 57.82, change: 1.23, dividendYield: 5.41, sparkline: [55.2, 56.1, 56.8, 57.3, 57.5, 57.82], disasterExposureScore: 34, market: 'us' },
    { symbol: 'SPG', name: 'Simon Property Group', sector: 'retail', price: 148.90, change: 0.89, dividendYield: 5.09, sparkline: [145, 146.5, 147.2, 148, 148.5, 148.9], disasterExposureScore: 28, market: 'us' },
    { symbol: 'PLD', name: 'Prologis', sector: 'industrial', price: 121.45, change: -0.67, dividendYield: 3.12, sparkline: [123, 122.5, 122, 121.8, 121.5, 121.45], disasterExposureScore: 22, market: 'us' },
    { symbol: 'REXR', name: 'Rexford Industrial', sector: 'industrial', price: 48.32, change: 1.05, dividendYield: 3.85, sparkline: [46.8, 47.2, 47.5, 47.9, 48.1, 48.32], disasterExposureScore: 45, market: 'us' },
    { symbol: 'EQR', name: 'Equity Residential', sector: 'residential', price: 68.12, change: -0.34, dividendYield: 3.85, sparkline: [69, 68.8, 68.5, 68.3, 68.2, 68.12], disasterExposureScore: 18, market: 'us' },
    { symbol: 'AVB', name: 'AvalonBay Communities', sector: 'residential', price: 215.60, change: 0.45, dividendYield: 3.22, sparkline: [213, 214, 214.5, 215, 215.3, 215.6], disasterExposureScore: 20, market: 'us' },
    { symbol: 'VNO', name: 'Vornado Realty Trust', sector: 'office', price: 27.45, change: -1.89, dividendYield: 7.22, sparkline: [29, 28.5, 28, 27.8, 27.6, 27.45], disasterExposureScore: 15, market: 'us' },
    { symbol: 'BXP', name: 'BXP Inc', sector: 'office', price: 72.30, change: -0.95, dividendYield: 5.18, sparkline: [74, 73.5, 73, 72.8, 72.5, 72.3], disasterExposureScore: 12, market: 'us' },
    { symbol: 'WELL', name: 'Welltower', sector: 'healthcare', price: 96.33, change: 2.15, dividendYield: 2.67, sparkline: [93, 94, 94.8, 95.5, 96, 96.33], disasterExposureScore: 25, market: 'us' },
    { symbol: 'DLR', name: 'Digital Realty', sector: 'datacenter', price: 142.78, change: 1.56, dividendYield: 3.44, sparkline: [139, 140, 141, 141.5, 142, 142.78], disasterExposureScore: 30, market: 'us' },
    { symbol: 'EQIX', name: 'Equinix', sector: 'datacenter', price: 812.50, change: 0.82, dividendYield: 2.05, sparkline: [805, 807, 809, 810, 811, 812.5], disasterExposureScore: 22, market: 'us' },
    { symbol: 'AMT', name: 'American Tower', sector: 'specialty', price: 198.45, change: -0.42, dividendYield: 3.35, sparkline: [200, 199.5, 199, 198.8, 198.5, 198.45], disasterExposureScore: 35, market: 'us' },
    { symbol: 'VICI', name: 'VICI Properties', sector: 'specialty', price: 31.20, change: 0.65, dividendYield: 5.26, sparkline: [30.2, 30.5, 30.8, 31, 31.1, 31.2], disasterExposureScore: 40, market: 'us' },
    { symbol: 'NLY', name: 'Annaly Capital', sector: 'mortgage', price: 19.50, change: 0.15, dividendYield: 12.80, sparkline: [19, 19.1, 19.2, 19.3, 19.4, 19.5], disasterExposureScore: 0, market: 'us' },
    { symbol: 'AGNC', name: 'AGNC Investment', sector: 'mortgage', price: 9.82, change: -0.21, dividendYield: 14.50, sparkline: [10.1, 10, 9.95, 9.9, 9.85, 9.82], disasterExposureScore: 0, market: 'us' },
    // China C-REITs (consumer + rental)
    { symbol: '180607.SZ', name: 'Huaxia COLI Commercial REIT', sector: 'retail', price: 5.83, change: 0.52, dividendYield: 4.00, sparkline: [5.6, 5.65, 5.7, 5.75, 5.8, 5.83], disasterExposureScore: 15, market: 'china' },
    { symbol: '180801.SZ', name: 'Huaxia CR Land Commercial REIT', sector: 'retail', price: 12.03, change: -0.33, dividendYield: 3.80, sparkline: [12.3, 12.2, 12.15, 12.1, 12.05, 12.03], disasterExposureScore: 18, market: 'china' },
    { symbol: '508016.SS', name: 'Harvest Wumei Consumer REIT', sector: 'retail', price: 4.25, change: 0.71, dividendYield: 4.50, sparkline: [4.1, 4.15, 4.18, 4.2, 4.22, 4.25], disasterExposureScore: 10, market: 'china' },
    { symbol: '180601.SZ', name: 'Huaxia Capital Land Outlets REIT', sector: 'retail', price: 10.00, change: 0.30, dividendYield: 4.20, sparkline: [9.7, 9.8, 9.85, 9.9, 9.95, 10.0], disasterExposureScore: 12, market: 'china' },
    { symbol: '508027.SS', name: 'Huaxia CR Land You Nest REIT', sector: 'residential', price: 2.78, change: -0.18, dividendYield: 4.80, sparkline: [2.85, 2.83, 2.81, 2.8, 2.79, 2.78], disasterExposureScore: 8, market: 'china' },
    { symbol: '508058.SS', name: 'CICC Chengtou Kuanting REIT', sector: 'residential', price: 4.17, change: 0.24, dividendYield: 4.50, sparkline: [4.05, 4.08, 4.1, 4.12, 4.15, 4.17], disasterExposureScore: 10, market: 'china' },
    { symbol: '508068.SS', name: 'Huaxia Beijing Affordable Housing REIT', sector: 'residential', price: 4.00, change: -0.50, dividendYield: 4.10, sparkline: [4.1, 4.08, 4.05, 4.03, 4.01, 4.0], disasterExposureScore: 5, market: 'china' },
    { symbol: '180401.SZ', name: 'Penghua Xiamen Affordable Housing REIT', sector: 'residential', price: 5.45, change: 0.37, dividendYield: 4.30, sparkline: [5.3, 5.33, 5.36, 5.4, 5.42, 5.45], disasterExposureScore: 20, market: 'china' },
    { symbol: '180501.SZ', name: 'Red Earth Shenzhen Affordable Housing REIT', sector: 'residential', price: 3.38, change: -0.59, dividendYield: 4.60, sparkline: [3.5, 3.45, 3.42, 3.4, 3.39, 3.38], disasterExposureScore: 12, market: 'china' },
  ];

  return {
    quotes: mockData,
    regime: 'REIT_REGIME_CAUTIOUS',
    aiBriefing: 'Fed Funds Rate rose 25bps to 5.33%, pushing 10Y Treasury to 4.28%. Rate-sensitive REITs (Office, Residential) underperformed. Industrial and Data Center sectors showed resilience due to inflation-hedged rent structures.\n\nSector rotation favors Industrial and Data Center REITs. Office sector faces headwinds from rising rates and remote work trends. Retail REITs show mixed signals — consumer spending stable but foot traffic declining in Class B malls.\n\nKey risk: $18.7B in Office REIT debt matures Q2 2026. Refinancing at current 10Y rates (+150bps vs original coupon) threatens dividend coverage for overleveraged names. Watch VNO and SLG closely.',
    sectorRotation: [
      { sector: 'industrial', signal: 'overweight', reason: 'Inflation hedge (CPI corr +0.50)' },
      { sector: 'datacenter', signal: 'overweight', reason: 'AI demand + low rate sensitivity' },
      { sector: 'office', signal: 'underweight', reason: 'High rate sensitivity (corr -0.72)' },
      { sector: 'residential', signal: 'underweight', reason: 'Rate sensitive (corr -0.65)' },
      { sector: 'retail', signal: 'neutral', reason: 'Mixed signals' },
      { sector: 'healthcare', signal: 'neutral', reason: 'Defensive characteristics' },
      { sector: 'specialty', signal: 'neutral', reason: 'Sector-specific drivers' },
    ],
    stale: false,
    lastUpdated: new Date().toISOString(),
  };
}

function getMockCorrelation(): GetReitCorrelationResponse {
  return {
    indicators: [
      { seriesId: 'FEDFUNDS', name: 'Fed Funds Rate', value: 5.33, changeDescription: '▲ +25bps', direction: 'rising' },
      { seriesId: 'DGS10', name: '10-Year Treasury', value: 4.28, changeDescription: '▲ +12bps', direction: 'rising' },
      { seriesId: 'CPIAUCSL', name: 'CPI (YoY)', value: 3.2, changeDescription: '▼ -0.3%', direction: 'falling' },
      { seriesId: 'UNRATE', name: 'Unemployment Rate', value: 3.7, changeDescription: '— flat', direction: 'flat' },
    ],
    correlations: [
      { sector: 'retail', indicatorId: 'FEDFUNDS', indicatorName: 'Fed Funds Rate', coefficient: -0.55, interpretation: 'moderate inverse' },
      { sector: 'retail', indicatorId: 'DGS10', indicatorName: '10Y Treasury', coefficient: -0.48, interpretation: 'moderate inverse' },
      { sector: 'retail', indicatorId: 'CPIAUCSL', indicatorName: 'CPI', coefficient: 0.35, interpretation: 'weak positive' },
      { sector: 'retail', indicatorId: 'UNRATE', indicatorName: 'Unemployment', coefficient: -0.30, interpretation: 'weak inverse' },
      { sector: 'industrial', indicatorId: 'FEDFUNDS', indicatorName: 'Fed Funds Rate', coefficient: -0.35, interpretation: 'weak inverse' },
      { sector: 'industrial', indicatorId: 'CPIAUCSL', indicatorName: 'CPI', coefficient: 0.50, interpretation: 'moderate positive' },
      { sector: 'office', indicatorId: 'FEDFUNDS', indicatorName: 'Fed Funds Rate', coefficient: -0.72, interpretation: 'strong inverse' },
      { sector: 'office', indicatorId: 'DGS10', indicatorName: '10Y Treasury', coefficient: -0.62, interpretation: 'moderate inverse' },
      { sector: 'residential', indicatorId: 'FEDFUNDS', indicatorName: 'Fed Funds Rate', coefficient: -0.65, interpretation: 'moderate inverse' },
      { sector: 'datacenter', indicatorId: 'CPIAUCSL', indicatorName: 'CPI', coefficient: 0.45, interpretation: 'moderate positive' },
    ],
    regime: 'REIT_REGIME_CAUTIOUS',
    sectorRotation: [
      { sector: 'industrial', signal: 'overweight', reason: 'Inflation hedge (CPI corr +0.50)' },
      { sector: 'datacenter', signal: 'overweight', reason: 'AI demand + low rate sensitivity' },
      { sector: 'office', signal: 'underweight', reason: 'High rate sensitivity (corr -0.72)' },
      { sector: 'residential', signal: 'underweight', reason: 'Rate sensitive (corr -0.65)' },
    ],
    yieldSpread: 1.13,
    lastUpdated: new Date().toISOString(),
  };
}

function getMockSocial(): GetReitSocialSentimentResponse {
  return {
    sentiments: [
      { reitSymbol: 'SPG', socialHealthScore: 7.2, avgRating: 4.1, reviewVelocity: 12, positiveKeywords: ['great mall', 'clean', 'good stores'], negativeKeywords: ['parking', 'crowded'], tenantRiskSignals: [], sector: 'retail' },
      { reitSymbol: 'O', socialHealthScore: 6.8, avgRating: 3.9, reviewVelocity: 0, positiveKeywords: ['convenient', 'well-maintained'], negativeKeywords: [], tenantRiskSignals: [], sector: 'retail' },
      { reitSymbol: 'EQR', socialHealthScore: 7.5, avgRating: 4.2, reviewVelocity: 8, positiveKeywords: ['luxury', 'great amenities'], negativeKeywords: ['expensive', 'noise'], tenantRiskSignals: [], sector: 'residential' },
      { reitSymbol: 'VNO', socialHealthScore: 3.8, avgRating: 2.9, reviewVelocity: -18, positiveKeywords: ['location'], negativeKeywords: ['empty floors', 'outdated'], tenantRiskSignals: [], sector: 'office' },
      { reitSymbol: 'WELL', socialHealthScore: 8.1, avgRating: 4.3, reviewVelocity: 5, positiveKeywords: ['caring staff', 'clean'], negativeKeywords: [], tenantRiskSignals: [], sector: 'healthcare' },
      { reitSymbol: 'DLR', socialHealthScore: 7.8, avgRating: 4.0, reviewVelocity: 15, positiveKeywords: ['reliable', 'modern'], negativeKeywords: [], tenantRiskSignals: [], sector: 'datacenter' },
      { reitSymbol: '180607.SZ', socialHealthScore: 7.0, avgRating: 4.0, reviewVelocity: 10, positiveKeywords: ['环宇城不错', '品牌齐全'], negativeKeywords: ['停车难'], tenantRiskSignals: [], sector: 'retail' },
      { reitSymbol: '180801.SZ', socialHealthScore: 8.5, avgRating: 4.5, reviewVelocity: 20, positiveKeywords: ['万象城很棒', '高端'], negativeKeywords: ['价格贵'], tenantRiskSignals: [], sector: 'retail' },
    ],
    stale: false,
    lastUpdated: new Date().toISOString(),
    unavailableReason: '',
  };
}

// ---- Public API ----

/**
 * Fetch REIT quotes with regime signal, AI briefing, and sector rotation.
 * Tries bootstrap hydration first, falls back to RPC, then mock data on localhost.
 */
export async function fetchReitQuotes(): Promise<ListReitQuotesResponse> {
  // Try bootstrap hydration first
  const hydrated = getHydratedData('reitQuotes') as ListReitQuotesResponse | undefined;
  if (hydrated?.quotes?.length) {
    return hydrated;
  }

  try {
    const result = await quotesBreaker.execute(
      () => client.listReitQuotes({ sector: '', symbols: [], market: '' }),
      emptyQuotesFallback,
    );
    if (result.quotes.length > 0) return result;
  } catch { /* fall through to mock */ }

  // Localhost fallback: return mock data so panels render during development
  if (IS_LOCALHOST) {
    console.log('[REIT] Using mock data (localhost dev mode)');
    return getMockQuotes();
  }
  return emptyQuotesFallback;
}

/**
 * Fetch macro correlation data: FRED indicators, Pearson coefficients,
 * regime classification, sector rotation, and bond yield spread.
 */
export async function fetchReitCorrelation(): Promise<GetReitCorrelationResponse> {
  const hydrated = getHydratedData('reitCorrelation') as GetReitCorrelationResponse | undefined;
  if (hydrated?.indicators?.length) {
    return hydrated;
  }

  try {
    const result = await correlationBreaker.execute(
      () => client.getReitCorrelation({}),
      emptyCorrelationFallback,
    );
    if (result.indicators.length > 0) return result;
  } catch { /* fall through */ }

  if (IS_LOCALHOST) return getMockCorrelation();
  return emptyCorrelationFallback;
}

/**
 * Fetch curated property locations with disaster exposure scores.
 */
export async function fetchReitProperties(): Promise<ListReitPropertiesResponse> {
  const hydrated = getHydratedData('reitProperties') as ListReitPropertiesResponse | undefined;
  if (hydrated?.properties?.length) {
    return hydrated;
  }

  try {
    const result = await propertiesBreaker.execute(
      () => client.listReitProperties({ sector: '', reitSymbol: '' }),
      emptyPropertiesFallback,
    );
    if (result.properties.length > 0) return result;
  } catch { /* fall through */ }

  // Properties come from the static JSON import in DeckGLMap — no mock needed here
  return emptyPropertiesFallback;
}

/**
 * Fetch social sentiment data per REIT.
 * Returns graceful degradation message when Google Places API is unavailable.
 */
export async function fetchReitSocial(): Promise<GetReitSocialSentimentResponse> {
  const hydrated = getHydratedData('reitSocial') as GetReitSocialSentimentResponse | undefined;
  if (hydrated?.sentiments?.length) {
    return hydrated;
  }

  try {
    const result = await socialBreaker.execute(
      () => client.getReitSocialSentiment({ reitSymbol: '' }),
      emptySocialFallback,
    );
    if (result.sentiments.length > 0) return result;
  } catch { /* fall through */ }

  if (IS_LOCALHOST) return getMockSocial();
  return emptySocialFallback;
}

// ---- Disclosure (C-REIT NAV + dividends from akshare) ----

export interface ReitDividend {
  year: string;
  recordDate: string;
  exDate: string;
  amount: number;
  description: string;
  payDate: string;
}

export interface ReitDisclosure {
  code: string;
  symbol: string;
  name: string;
  nav?: number;
  navDate?: string;
  cumulativeNav?: number;
  premiumDiscount?: number;
  totalDistributed?: number;
  distributionYield?: number;
  dividends?: ReitDividend[];
  price?: number;
  change?: number;
  volume?: number;
  turnover?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  error?: string;
}

export interface GetReitDisclosureResponse {
  disclosures: ReitDisclosure[];
  source: string;
  lastUpdated: string;
}

const disclosureBreaker = createCircuitBreaker<GetReitDisclosureResponse>({
  name: 'REIT Disclosure',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const emptyDisclosureFallback: GetReitDisclosureResponse = {
  disclosures: [],
  source: '',
  lastUpdated: '',
};

function getMockDisclosure(): GetReitDisclosureResponse {
  return {
    disclosures: [
      { code: '180607', symbol: '180607.SZ', name: '华夏中海商业REIT', nav: 5.281, navDate: '2025-10-20', cumulativeNav: 5.281, premiumDiscount: 8.88, totalDistributed: 0.0433, distributionYield: 0.75, dividends: [{ year: '2026年', recordDate: '2026-03-03', exDate: '2026-03-03', amount: 0.0433, description: '每份派现金0.0433元', payDate: '2026-03-05' }], price: 5.75, change: -0.73, volume: 2317, turnover: 1338682 },
      { code: '180801', symbol: '180801.SZ', name: '华夏华润商业REIT', nav: 9.319, navDate: '2024-12-31', cumulativeNav: 9.319, premiumDiscount: 29.09, totalDistributed: 4.1582, distributionYield: 3.45, dividends: [{ year: '2022年', recordDate: '2022-04-07', exDate: '2022-04-07', amount: 1.1604, description: '每份派现金1.1604元', payDate: '2022-04-11' }], price: 12.03, change: -0.33, volume: 1500, turnover: 800000 },
      { code: '508016', symbol: '508016.SS', name: '嘉实物美消费REIT', nav: 3.789, navDate: '2025-07-14', cumulativeNav: 3.789, premiumDiscount: 12.17, dividends: [], price: 4.25, change: 0.71, volume: 800, turnover: 340000 },
      { code: '180601', symbol: '180601.SZ', name: '华夏首创奥莱REIT', nav: 3.5, navDate: '2025-06-30', premiumDiscount: 185.71, totalDistributed: 0.5684, distributionYield: 1.73, dividends: [{ year: '2024年', recordDate: '2024-08-05', exDate: '2024-08-05', amount: 0.0867, description: '每份派现金0.0867元', payDate: '2024-08-07' }], price: 10.00, change: 0.30, volume: 900, turnover: 450000 },
      { code: '508027', symbol: '508027.SS', name: '华夏华润有巢REIT', nav: 3.3848, navDate: '2025-06-30', cumulativeNav: 3.3848, premiumDiscount: -17.87, totalDistributed: 0.2804, distributionYield: 6.40, dividends: [{ year: '2023年', recordDate: '2023-04-17', exDate: '2023-04-17', amount: 0.1775, description: '每份派现金0.1775元', payDate: '2023-04-19' }], price: 2.78, change: -0.18, volume: 500, turnover: 139000 },
      { code: '508058', symbol: '508058.SS', name: '中金城投宽庭REIT', nav: 2.4891, navDate: '2025-06-30', cumulativeNav: 2.4891, premiumDiscount: 67.53, totalDistributed: 0.3113, distributionYield: 2.25, dividends: [{ year: '2023年', recordDate: '2023-09-04', exDate: '2023-09-04', amount: 0.052, description: '每份派现金0.0520元', payDate: '2023-09-06' }], price: 4.17, change: 0.24, volume: 600, turnover: 250000 },
      { code: '180401', symbol: '180401.SZ', name: '鹏华厦门安居REIT', nav: 5.0233, navDate: '2025-12-31', cumulativeNav: 5.0233, premiumDiscount: 8.50, totalDistributed: 2.254, distributionYield: 19.59, dividends: [{ year: '2023年', recordDate: '2023-12-11', exDate: '2023-12-11', amount: 0.34, description: '每份派现金0.3400元', payDate: '2023-12-13' }], price: 5.45, change: 0.37, volume: 400, turnover: 218000 },
      { code: '508068', symbol: '508068.SS', name: '华夏北京保障房REIT', nav: 2.51, navDate: '2022-08-22', cumulativeNav: 2.51, premiumDiscount: 59.36, totalDistributed: 0.2246, distributionYield: 2.33, dividends: [{ year: '2023年', recordDate: '2023-10-13', exDate: '2023-10-13', amount: 0.055, description: '每份派现金0.0550元', payDate: '2023-10-17' }], price: 4.00, change: -0.50, volume: 300, turnover: 120000 },
      { code: '180501', symbol: '180501.SZ', name: '红土深圳安居REIT', nav: 2.3433, navDate: '2025-12-31', cumulativeNav: 2.3433, premiumDiscount: 44.26, totalDistributed: 0.2378, distributionYield: 2.72, dividends: [{ year: '2023年', recordDate: '2023-09-21', exDate: '2023-09-21', amount: 0.0539, description: '每份派现金0.0539元', payDate: '2023-09-25' }], price: 3.38, change: -0.59, volume: 350, turnover: 118300 },
    ],
    source: 'akshare/eastmoney (mock)',
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Fetch C-REIT disclosure data: NAV, dividends, premium/discount, trading.
 * Only available for Chinese REITs (9 C-REITs from akshare/EastMoney).
 */
export async function fetchReitDisclosure(reitSymbol?: string): Promise<GetReitDisclosureResponse> {
  try {
    const result = await disclosureBreaker.execute(
      () => client.getReitDisclosure({ reitSymbol: reitSymbol || '' }),
      emptyDisclosureFallback,
    );
    if (result.disclosures.length > 0) return result;
  } catch { /* fall through */ }

  if (IS_LOCALHOST) return getMockDisclosure();
  return emptyDisclosureFallback;
}

/** Check if the REIT Quotes circuit breaker is on cooldown. */
export function getReitQuotesCooldownInfo() {
  return getCircuitBreakerCooldownInfo('REIT Quotes');
}

/** Check if the REIT Correlation circuit breaker is on cooldown. */
export function getReitCorrelationCooldownInfo() {
  return getCircuitBreakerCooldownInfo('REIT Correlation');
}
