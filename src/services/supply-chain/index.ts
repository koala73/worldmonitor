import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  SupplyChainServiceClient,
  type GetShippingRatesResponse,
  type GetChokepointStatusResponse,
  type GetCriticalMineralsResponse,
  type GetShippingStressResponse,
  type ShippingIndex,
  type ChokepointInfo,
  type CriticalMineral,
  type MineralProducer,
  type ShippingRatePoint,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

export type {
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
  GetShippingStressResponse,
  ShippingIndex,
  ChokepointInfo,
  CriticalMineral,
  MineralProducer,
  ShippingRatePoint,
};

const client = new SupplyChainServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const shippingBreaker = createCircuitBreaker<GetShippingRatesResponse>({ name: 'Shipping Rates', cacheTtlMs: 60 * 60 * 1000, persistCache: true });
const chokepointBreaker = createCircuitBreaker<GetChokepointStatusResponse>({ name: 'Chokepoint Status', cacheTtlMs: 90 * 60 * 1000, persistCache: true });
const mineralsBreaker = createCircuitBreaker<GetCriticalMineralsResponse>({ name: 'Critical Minerals', cacheTtlMs: 24 * 60 * 60 * 1000, persistCache: true });

const emptyShipping: GetShippingRatesResponse = { indices: [], fetchedAt: '', upstreamUnavailable: false };
const emptyChokepoints: GetChokepointStatusResponse = { chokepoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyMinerals: GetCriticalMineralsResponse = { minerals: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchShippingRates(): Promise<GetShippingRatesResponse> {
  const hydrated = getHydratedData('shippingRates') as GetShippingRatesResponse | undefined;
  if (hydrated?.indices?.length) return hydrated;

  try {
    return await shippingBreaker.execute(async () => {
      return client.getShippingRates({});
    }, emptyShipping);
  } catch {
    return emptyShipping;
  }
}

export async function fetchChokepointStatus(): Promise<GetChokepointStatusResponse> {
  const hydrated = getHydratedData('chokepoints') as GetChokepointStatusResponse | undefined;
  // Transit summaries are already folded into the chokepoint payload server-side.
  getHydratedData('chokepointTransits');
  if (hydrated?.chokepoints?.length) return hydrated;

  try {
    return await chokepointBreaker.execute(async () => {
      return client.getChokepointStatus({});
    }, emptyChokepoints);
  } catch {
    return emptyChokepoints;
  }
}

export async function fetchCriticalMinerals(): Promise<GetCriticalMineralsResponse> {
  const hydrated = getHydratedData('minerals') as GetCriticalMineralsResponse | undefined;
  if (hydrated?.minerals?.length) return hydrated;

  try {
    return await mineralsBreaker.execute(async () => {
      return client.getCriticalMinerals({});
    }, emptyMinerals);
  } catch {
    return emptyMinerals;
  }
}

const emptyShippingStress: GetShippingStressResponse = { carriers: [], stressScore: 0, stressLevel: 'low', fetchedAt: 0, upstreamUnavailable: false };

export async function fetchShippingStress(): Promise<GetShippingStressResponse> {
  const hydrated = getHydratedData('shippingStress') as GetShippingStressResponse | undefined;
  if (hydrated?.carriers?.length) return hydrated;

  try {
    return await client.getShippingStress({});
  } catch {
    return emptyShippingStress;
  }
}
