import { createCircuitBreaker } from '@/utils';
import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import {
  hasHealthyCanadaRoadSource,
  loadCanadaRoadSourcesCore,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

export {
  hasHealthyCanadaRoadSource,
  recordsFromPayload,
  unionCanadaRoadRecords,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceState,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

/**
 * Unions bootstrap `canadaRoads` (infra:ontario-511:v1) and `albertaRoads`
 * (infra:alberta-511:v1) with on-demand `torontoRoads`
 * (infra:toronto-roads:v1).
 */
export const CANADA_ROAD_SOURCES: readonly CanadaRoadSourceDescriptor[] = Object.freeze([
  { key: 'canadaRoads', source: 'ontario-511', jurisdiction: 'ON', onDemand: false },
  { key: 'albertaRoads', source: 'alberta-511', jurisdiction: 'AB', onDemand: false },
  { key: 'torontoRoads', source: 'toronto-roads', jurisdiction: 'Toronto', onDemand: true },
  { key: 'bcOpen511', source: 'bc-open511', jurisdiction: 'BC', onDemand: true },
]);

const unavailableSourceStates = (): CanadaRoadSourceStates => Object.fromEntries(
  CANADA_ROAD_SOURCES.map(({ key }) => [key, 'unavailable' as const]),
);

let lastSourceStates: CanadaRoadSourceStates = unavailableSourceStates();

interface CanadaRoadSnapshot {
  records: CanadaRoadRecord[];
  states: CanadaRoadSourceStates;
}

type CanadaRoadCachedValue = CanadaRoadSnapshot | CanadaRoadRecord[];

const breaker = createCircuitBreaker<CanadaRoadCachedValue>({
  name: 'Canada roads',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const ON_DEMAND_LOADERS: Record<string, () => Promise<unknown | undefined>> = {
  torontoRoads: () => ensureHydrated('torontoRoads'),
  bcOpen511: () => ensureHydrated('bcOpen511'),
};

const HYDRATED_LOADERS: Record<string, () => unknown | undefined> = {
  canadaRoads: () => getHydratedData('canadaRoads'),
  albertaRoads: () => getHydratedData('albertaRoads'),
  torontoRoads: () => getHydratedData('torontoRoads'),
  bcOpen511: () => getHydratedData('bcOpen511'),
};

interface CanadaRoadLoadDependencies {
  getHydrated?: (key: string) => unknown | undefined;
  ensureOnDemand?: (key: string) => Promise<unknown | undefined>;
  fetchFn?: typeof fetch;
}

async function fetchTierKey(key: string, fetchFn: typeof fetch): Promise<unknown | undefined> {
  const resp = await fetchFn(
    toApiUrl(`/api/bootstrap?keys=${encodeURIComponent(key)}`),
    { credentials: 'include', signal: AbortSignal.timeout(8000) },
  );
  if (!resp.ok) throw new Error(`Bootstrap fetch failed for ${key}: ${resp.status}`);
  const json = await resp.json() as { data?: Record<string, unknown> };
  return json.data?.[key];
}

export function loadCanadaRoadSources(
  descriptors: readonly CanadaRoadSourceDescriptor[] = CANADA_ROAD_SOURCES,
  dependencies: CanadaRoadLoadDependencies = {},
): Promise<{ records: CanadaRoadRecord[] | null; states: CanadaRoadSourceStates }> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  return loadCanadaRoadSourcesCore(descriptors, {
    getHydrated: (key) => dependencies.getHydrated
      ? dependencies.getHydrated(key)
      : HYDRATED_LOADERS[key]?.(),
    fetchMissing: (descriptor) => descriptor.onDemand
      ? dependencies.ensureOnDemand
        ? dependencies.ensureOnDemand(descriptor.key)
        : ON_DEMAND_LOADERS[descriptor.key]?.() ?? Promise.resolve(undefined)
      : fetchTierKey(descriptor.key, fetchFn),
  });
}

export async function fetchCanadaRoads(): Promise<CanadaRoadRecord[]> {
  const cachedValue = await breaker.execute(async () => {
    const result = await loadCanadaRoadSources();
    if (result.records != null) return { records: result.records, states: result.states };
    throw new Error('No usable Canada road source in bootstrap');
  }, { records: [], states: unavailableSourceStates() });
  // Persistent caches written by the pre-source-state client contain the
  // record array only. Keep that valid cache usable during the rollout while
  // marking sibling coverage unknown/degraded until the next live refresh.
  const snapshot: CanadaRoadSnapshot = Array.isArray(cachedValue)
    ? {
        records: cachedValue,
        states: {
          ...unavailableSourceStates(),
          canadaRoads: cachedValue.length > 0 ? 'available' : 'empty',
        },
      }
    : cachedValue;
  lastSourceStates = snapshot.states;
  if (!hasHealthyCanadaRoadSource(lastSourceStates)) {
    throw new Error('All Canada road sources are unavailable or malformed');
  }
  return snapshot.records;
}

export function getCanadaRoadSourceStates(): CanadaRoadSourceStates {
  return { ...lastSourceStates };
}

export function getCanadaRoadsStatus(): string {
  return breaker.getStatus();
}
