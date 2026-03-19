/**
 * Trade policy intelligence service.
 * WTO MFN baselines, trade flows/barriers, and US customs/effective tariff context.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  TradeServiceClient,
  type GetTradeRestrictionsResponse,
  type GetTariffTrendsResponse,
  type GetTradeFlowsResponse,
  type GetTradeBarriersResponse,
  type GetCustomsRevenueResponse,
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
export type { TradeRestriction, TariffDataPoint, EffectiveTariffRate, TradeFlowRecord, TradeBarrier, CustomsRevenueMonth };
export type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
  GetCustomsRevenueResponse,
};

const client = new TradeServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const restrictionsBreaker = createCircuitBreaker<GetTradeRestrictionsResponse>({ name: 'WTO Restrictions', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const tariffsBreaker = createCircuitBreaker<GetTariffTrendsResponse>({ name: 'WTO Tariffs', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const flowsBreaker = createCircuitBreaker<GetTradeFlowsResponse>({ name: 'WTO Flows', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const barriersBreaker = createCircuitBreaker<GetTradeBarriersResponse>({ name: 'WTO Barriers', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const revenueBreaker = createCircuitBreaker<GetCustomsRevenueResponse>({ name: 'Treasury Revenue', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs: GetTariffTrendsResponse = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows: GetTradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };
const emptyRevenue: GetCustomsRevenueResponse = { months: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchTradeRestrictions(countries: string[] = [], limit = 50): Promise<GetTradeRestrictionsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyRestrictions;
  try {
    return await restrictionsBreaker.execute(async () => {
      return client.getTradeRestrictions({ countries, limit });
    }, emptyRestrictions, { shouldCache: r => (r.restrictions?.length ?? 0) > 0 });
  } catch {
    return emptyRestrictions;
  }
}

export async function fetchTariffTrends(reportingCountry: string, partnerCountry: string, productSector = '', years = 10): Promise<GetTariffTrendsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyTariffs;
  try {
    return await tariffsBreaker.execute(async () => {
      return client.getTariffTrends({ reportingCountry, partnerCountry, productSector, years });
    }, emptyTariffs, { shouldCache: r => (r.datapoints?.length ?? 0) > 0 });
  } catch {
    return emptyTariffs;
  }
}

export async function fetchTradeFlows(reportingCountry: string, partnerCountry: string, years = 10): Promise<GetTradeFlowsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyFlows;
  try {
    return await flowsBreaker.execute(async () => {
      return client.getTradeFlows({ reportingCountry, partnerCountry, years });
    }, emptyFlows, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyFlows;
  }
}

export async function fetchTradeBarriers(countries: string[] = [], measureType = '', limit = 50): Promise<GetTradeBarriersResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyBarriers;
  try {
    return await barriersBreaker.execute(async () => {
      return client.getTradeBarriers({ countries, measureType, limit });
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
      return client.getCustomsRevenue({});
    }, emptyRevenue, { shouldCache: r => (r.months?.length ?? 0) > 0 });
  } catch {
    return emptyRevenue;
  }
}
