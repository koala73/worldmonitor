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

// ---- Public API ----

/**
 * Fetch REIT quotes with regime signal, AI briefing, and sector rotation.
 * Tries bootstrap hydration first, falls back to RPC.
 */
export async function fetchReitQuotes(): Promise<ListReitQuotesResponse> {
  // Try bootstrap hydration first
  const hydrated = getHydratedData('reitQuotes') as ListReitQuotesResponse | undefined;
  if (hydrated?.quotes?.length) {
    return hydrated;
  }

  return quotesBreaker.execute(
    () => client.listReitQuotes({ sector: '', symbols: [], market: '' }),
    emptyQuotesFallback,
  );
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

  return correlationBreaker.execute(
    () => client.getReitCorrelation({}),
    emptyCorrelationFallback,
  );
}

/**
 * Fetch curated property locations with disaster exposure scores.
 */
export async function fetchReitProperties(): Promise<ListReitPropertiesResponse> {
  const hydrated = getHydratedData('reitProperties') as ListReitPropertiesResponse | undefined;
  if (hydrated?.properties?.length) {
    return hydrated;
  }

  return propertiesBreaker.execute(
    () => client.listReitProperties({ sector: '', reitSymbol: '' }),
    emptyPropertiesFallback,
  );
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

  return socialBreaker.execute(
    () => client.getReitSocialSentiment({ reitSymbol: '' }),
    emptySocialFallback,
  );
}

/** Check if the REIT Quotes circuit breaker is on cooldown. */
export function getReitQuotesCooldownInfo() {
  return getCircuitBreakerCooldownInfo('REIT Quotes');
}

/** Check if the REIT Correlation circuit breaker is on cooldown. */
export function getReitCorrelationCooldownInfo() {
  return getCircuitBreakerCooldownInfo('REIT Correlation');
}
