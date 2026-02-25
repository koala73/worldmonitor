/**
 * Trade policy intelligence service -- WTO data sources.
 * Trade restrictions, tariff trends, trade flows, and SPS/TBT barriers.
 */

import {
  TradeServiceClient,
  type GetTradeRestrictionsResponse,
  type GetTariffTrendsResponse,
  type GetTradeFlowsResponse,
  type GetTradeBarriersResponse,
  type TradeRestriction,
  type TariffDataPoint,
  type TradeFlowRecord,
  type TradeBarrier,
} from '@/generated/client/worldmonitor/trade/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { isFeatureAvailable } from '../runtime-config';

// Re-export types for consumers
export type { TradeRestriction, TariffDataPoint, TradeFlowRecord, TradeBarrier };
export type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
};

const client = new TradeServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

const restrictionsBreaker = createCircuitBreaker<GetTradeRestrictionsResponse>({ name: 'WTO Restrictions', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const tariffsBreaker = createCircuitBreaker<GetTariffTrendsResponse>({ name: 'WTO Tariffs', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const flowsBreaker = createCircuitBreaker<GetTradeFlowsResponse>({ name: 'WTO Flows', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const barriersBreaker = createCircuitBreaker<GetTradeBarriersResponse>({ name: 'WTO Barriers', cacheTtlMs: 30 * 60 * 1000, persistCache: true });

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
const emptyTariffs: GetTariffTrendsResponse = { datapoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyFlows: GetTradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchTradeRestrictions(countries: string[] = [], limit = 50): Promise<GetTradeRestrictionsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyRestrictions;
  try {
    return await restrictionsBreaker.execute(async () => {
      return client.getTradeRestrictions({ countries, limit });
    }, emptyRestrictions);
  } catch {
    return emptyRestrictions;
  }
}

export async function fetchTariffTrends(reportingCountry: string, partnerCountry: string, productSector = '', years = 10): Promise<GetTariffTrendsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyTariffs;
  try {
    return await tariffsBreaker.execute(async () => {
      return client.getTariffTrends({ reportingCountry, partnerCountry, productSector, years });
    }, emptyTariffs);
  } catch {
    return emptyTariffs;
  }
}

export async function fetchTradeFlows(reportingCountry: string, partnerCountry: string, years = 10): Promise<GetTradeFlowsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyFlows;
  try {
    return await flowsBreaker.execute(async () => {
      return client.getTradeFlows({ reportingCountry, partnerCountry, years });
    }, emptyFlows);
  } catch {
    return emptyFlows;
  }
}

export async function fetchTradeBarriers(countries: string[] = [], measureType = '', limit = 50): Promise<GetTradeBarriersResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyBarriers;
  try {
    return await barriersBreaker.execute(async () => {
      return client.getTradeBarriers({ countries, measureType, limit });
    }, emptyBarriers);
  } catch {
    return emptyBarriers;
  }
}
