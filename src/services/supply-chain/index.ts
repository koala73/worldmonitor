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
  type GetSectorDependencyResponse,
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
  GetSectorDependencyResponse,
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

/** Top 10 HS2 sectors seeded for chokepoint exposure. */
export const SEEDED_HS2_CODES = ['27', '84', '85', '87', '30', '72', '39', '29', '10', '62'] as const;

/** Short labels for display. */
export const HS2_SHORT_LABELS: Record<string, string> = {
  '27': 'Energy', '84': 'Machinery', '85': 'Electronics', '87': 'Vehicles',
  '30': 'Pharma', '72': 'Iron & Steel', '39': 'Plastics', '29': 'Chemicals',
  '10': 'Cereals', '62': 'Apparel',
};

export interface SectorExposureSummary {
  hs2: string;
  label: string;
  primaryChokepointId: string;
  primaryChokepointName: string;
  exposureScore: number;
  vulnerabilityIndex: number;
  dependencyFlag: string;
  primaryExporterIso2: string;
  primaryExporterShare: number;
}

/**
 * Fetch chokepoint exposure + dependency flags for all seeded sectors.
 * Exposure fetched first (10 requests), then dependency only for sectors with data (fewer requests).
 */
export async function fetchMultiSectorExposure(iso2: string): Promise<SectorExposureSummary[]> {
  const exposureResults = await Promise.all(
    SEEDED_HS2_CODES.map(hs2 => fetchCountryChokepointIndex(iso2, hs2)),
  );
  const activeCodes = exposureResults.filter(r => r.exposures.length > 0).map(r => r.hs2);
  const depResults = activeCodes.length > 0
    ? await Promise.all(activeCodes.map(hs2 => fetchSectorDependency(iso2, hs2)))
    : [];

  const depMap = new Map(depResults.map(d => [d.hs2, d]));

  return exposureResults
    .filter(r => r.exposures.length > 0)
    .map(r => {
      const dep = depMap.get(r.hs2);
      return {
        hs2: r.hs2,
        label: HS2_SHORT_LABELS[r.hs2] ?? r.hs2,
        primaryChokepointId: r.primaryChokepointId,
        primaryChokepointName: r.exposures[0]?.chokepointName ?? r.primaryChokepointId,
        exposureScore: r.exposures[0]?.exposureScore ?? 0,
        vulnerabilityIndex: r.vulnerabilityIndex,
        dependencyFlag: dep?.flags?.[0] ?? '',
        primaryExporterIso2: dep?.primaryExporterIso2 ?? '',
        primaryExporterShare: dep?.primaryExporterShare ?? 0,
      };
    })
    .sort((a, b) => b.vulnerabilityIndex - a.vulnerabilityIndex);
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

const emptySectorDependency: GetSectorDependencyResponse = {
  iso2: '', hs2: '27', hs2Label: '', flags: [],
  primaryExporterIso2: '', primaryExporterShare: 0,
  primaryChokepointId: '', primaryChokepointExposure: 0,
  hasViableBypass: false, fetchedAt: '',
};

export async function fetchSectorDependency(
  iso2: string,
  hs2 = '27',
): Promise<GetSectorDependencyResponse> {
  try {
    return await client.getSectorDependency({ iso2, hs2 });
  } catch {
    return { ...emptySectorDependency, iso2, hs2 };
  }
}
