/**
 * Trade policy intelligence service.
 * WTO MFN baselines, trade flows/barriers, and US customs/effective tariff context.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import {
  TradeServiceClient,
  type GetTradeRestrictionsResponse,
  type GetTariffTrendsResponse,
  type GetTradeFlowsResponse,
  type GetTradeBarriersResponse,
  type GetCustomsRevenueResponse,
  type ListComtradeFlowsResponse,
  type ComtradeFlowRecord,
  type TradeRestriction,
  type TariffDataPoint,
  type EffectiveTariffRate,
  type TradeFlowRecord,
  type TradeBarrier,
  type CustomsRevenueMonth,
} from '@/generated/client/worldmonitor/trade/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';
import { getHydratedData } from '@/services/bootstrap';

// Re-export types for consumers
export type { TradeRestriction, TariffDataPoint, EffectiveTariffRate, TradeFlowRecord, TradeBarrier, CustomsRevenueMonth, ComtradeFlowRecord };
export type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
  GetCustomsRevenueResponse,
  ListComtradeFlowsResponse,
};

// Two clients to prevent cross-entitlement cache leakage.
//
// The breakers below use `persistCache: true` and auth-invariant cache
// keys — once a response lands in the cache it's served to any future
// session on the same browser without re-authenticating. Routing
// premium-backed calls through the same client as non-premium calls
// would let a pro user's tariff/comtrade response populate the cache
// and leak to the next free / signed-out session. Keep them split:
//
//   - publicClient  (globalThis.fetch)  — feeds restrictionsBreaker,
//     flowsBreaker, barriersBreaker, revenueBreaker. Unauthenticated,
//     shareable response bodies, safe to cache across auth states.
//
//   - premiumClient (premiumFetch)      — ONLY used for get-tariff-trends
//     and list-comtrade-flows. Injects the caller's Clerk bearer /
//     tester-key / WORLDMONITOR_API_KEY, so pro users get real data
//     instead of 401.
const publicClient = new TradeServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const premiumClient = new TradeServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

const restrictionsBreaker = createCircuitBreaker<GetTradeRestrictionsResponse>({ name: 'WTO Restrictions', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
// Premium endpoints: persistCache:false so a pro user's response is NOT
// written to localStorage/IndexedDB where a later free / signed-out session
// on the same browser would read it back without re-authenticating.
const tariffsBreaker = createCircuitBreaker<GetTariffTrendsResponse>({ name: 'WTO Tariffs', cacheTtlMs: 30 * 60 * 1000, persistCache: false });
const flowsBreaker = createCircuitBreaker<GetTradeFlowsResponse>({ name: 'WTO Flows', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const barriersBreaker = createCircuitBreaker<GetTradeBarriersResponse>({ name: 'WTO Barriers', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const revenueBreaker = createCircuitBreaker<GetCustomsRevenueResponse>({ name: 'Treasury Revenue', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const comtradeBreaker = createCircuitBreaker<ListComtradeFlowsResponse>({ name: 'Comtrade Flows', cacheTtlMs: 6 * 60 * 60 * 1000, persistCache: false });

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs: GetTariffTrendsResponse = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows: GetTradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };
const emptyRevenue: GetCustomsRevenueResponse = { months: [], fetchedAt: '', upstreamUnavailable: false };
const emptyComtrade: ListComtradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchTradeRestrictions(countries: string[] = [], limit = 50): Promise<GetTradeRestrictionsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyRestrictions;
  try {
    return await restrictionsBreaker.execute(async () => {
      return publicClient.getTradeRestrictions({ countries, limit });
    }, emptyRestrictions, { shouldCache: r => (r.restrictions?.length ?? 0) > 0 });
  } catch {
    return emptyRestrictions;
  }
}

export async function fetchTariffTrends(reportingCountry: string, partnerCountry: string, productSector = '', years = 10): Promise<GetTariffTrendsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyTariffs;
  try {
    return await tariffsBreaker.execute(async () => {
      return premiumClient.getTariffTrends({ reportingCountry, partnerCountry, productSector, years });
    }, emptyTariffs, { shouldCache: r => (r.datapoints?.length ?? 0) > 0 });
  } catch {
    return emptyTariffs;
  }
}

export async function fetchTradeFlows(reportingCountry: string, partnerCountry: string, years = 10): Promise<GetTradeFlowsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyFlows;
  try {
    return await flowsBreaker.execute(async () => {
      return publicClient.getTradeFlows({ reportingCountry, partnerCountry, years });
    }, emptyFlows, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyFlows;
  }
}

export async function fetchTradeBarriers(countries: string[] = [], measureType = '', limit = 50): Promise<GetTradeBarriersResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyBarriers;
  try {
    return await barriersBreaker.execute(async () => {
      return publicClient.getTradeBarriers({ countries, measureType, limit });
    }, emptyBarriers, { shouldCache: r => (r.barriers?.length ?? 0) > 0 });
  } catch {
    return emptyBarriers;
  }
}

export async function fetchCustomsRevenue(): Promise<GetCustomsRevenueResponse> {
  const hydrated = getHydratedData('customsRevenue') as GetCustomsRevenueResponse | undefined;
  if (hydrated?.months?.length) return hydrated;
  try {
    return await revenueBreaker.execute(async () => {
      return publicClient.getCustomsRevenue({});
    }, emptyRevenue, { shouldCache: r => (r.months?.length ?? 0) > 0 });
  } catch {
    return emptyRevenue;
  }
}

export async function fetchComtradeFlows(): Promise<ListComtradeFlowsResponse> {
  try {
    return await comtradeBreaker.execute(async () => {
      return premiumClient.listComtradeFlows({ reporterCode: '', cmdCode: '', anomaliesOnly: false });
    }, emptyComtrade, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyComtrade;
  }
}
