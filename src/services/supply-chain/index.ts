import { getRpcBaseUrl } from '@/services/rpc-client';
import type { CargoType } from '@/config/bypass-corridors';
import {
  SupplyChainServiceClient,
  type GetShippingRatesResponse,
  type GetChokepointStatusResponse,
  type GetCriticalMineralsResponse,
  type GetShippingStressResponse,
  type GetCountryChokepointIndexResponse,
  type GetBypassOptionsResponse,
  type GetCountryCostShockResponse,
  type ShippingIndex,
  type ChokepointInfo,
  type CriticalMineral,
  type MineralProducer,
  type ShippingRatePoint,
  type ChokepointExposureEntry,
  type BypassOption,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

export type {
  GetShippingRatesResponse,
  GetChokepointStatusResponse,
  GetCriticalMineralsResponse,
  GetShippingStressResponse,
  GetCountryChokepointIndexResponse,
  GetBypassOptionsResponse,
  GetCountryCostShockResponse,
  ShippingIndex,
  ChokepointInfo,
  CriticalMineral,
  MineralProducer,
  ShippingRatePoint,
  ChokepointExposureEntry,
  BypassOption,
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

const emptyChokepointIndex: GetCountryChokepointIndexResponse = {
  iso2: '',
  hs2: '27',
  exposures: [],
  primaryChokepointId: '',
  vulnerabilityIndex: 0,
  fetchedAt: '',
};

export async function fetchCountryChokepointIndex(
  iso2: string,
  hs2 = '27',
): Promise<GetCountryChokepointIndexResponse> {
  try {
    return await client.getCountryChokepointIndex({ iso2, hs2 });
  } catch {
    return { ...emptyChokepointIndex, iso2, hs2 };
  }
}

export async function fetchBypassOptions(
  chokepointId: string,
  cargoType: CargoType = 'container',
  closurePct = 100,
): Promise<GetBypassOptionsResponse> {
  const empty: GetBypassOptionsResponse = { chokepointId, cargoType, closurePct, options: [], primaryChokepointWarRiskTier: 'WAR_RISK_TIER_UNSPECIFIED', fetchedAt: '' };
  try {
    return await client.getBypassOptions({ chokepointId, cargoType, closurePct });
  } catch {
    return empty;
  }
}

export async function fetchCountryCostShock(
  iso2: string,
  chokepointId: string,
  hs2 = '27',
): Promise<GetCountryCostShockResponse> {
  const empty: GetCountryCostShockResponse = {
    iso2, chokepointId, hs2,
    supplyDeficitPct: 0, coverageDays: 0, warRiskPremiumBps: 0,
    warRiskTier: 'WAR_RISK_TIER_UNSPECIFIED',
    hasEnergyModel: false, unavailableReason: '', fetchedAt: '',
  };
  try {
    return await client.getCountryCostShock({ iso2, chokepointId, hs2 });
  } catch {
    return empty;
  }
}
