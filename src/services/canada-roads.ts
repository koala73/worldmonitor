import { createCircuitBreaker } from '@/utils';
import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import {
  CANADA_ROAD_SOURCES,
  hasHealthyCanadaRoadSource,
  loadCanadaRoadSourcesCore,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

export {
  CANADA_ROAD_SOURCES,
  hasHealthyCanadaRoadSource,
  recordsFromPayload,
  unionCanadaRoadRecords,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceState,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

/**
 * Freshness-panel id per road source. Derived from CANADA_ROAD_SOURCES so a
 * fifth jurisdiction cannot be added without deciding how it reports freshness:
 * the union previously recorded every source as `ontario_511`, which made an
 * Alberta/Toronto/BC outage indistinguishable from an Ontario one.
 */
export const CANADA_ROAD_FRESHNESS_IDS = Object.freeze([
  { key: 'canadaRoads', freshnessId: 'ontario_511' },
  { key: 'albertaRoads', freshnessId: 'alberta_511' },
  { key: 'manitobaRoads', freshnessId: 'manitoba_511' },
  { key: 'torontoRoads', freshnessId: 'toronto_roads' },
  { key: 'bcOpen511', freshnessId: 'bc_open511' },
] as const);

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

// Derived from CANADA_ROAD_SOURCES rather than hand-listed: a fifth
// jurisdiction added to the descriptors would otherwise silently have no loader
// and read as permanently `unavailable`.
const ON_DEMAND_LOADERS: Record<string, () => Promise<unknown | undefined>> = Object.fromEntries(
  CANADA_ROAD_SOURCES.map(({ key }) => [key, () => ensureHydrated(key)]),
);

// The core's first check, before it reaches fetchMissing. Every road key is
// on-demand today so these all miss, but the lookup stays correct if one is
// ever promoted back into a tier.
const HYDRATED_LOADERS: Record<string, () => unknown | undefined> = Object.fromEntries(
  CANADA_ROAD_SOURCES.map(({ key }) => [key, () => getHydratedData(key)]),
);

interface CanadaRoadLoadDependencies {
  getHydrated?: (key: string) => unknown | undefined;
  ensureOnDemand?: (key: string) => Promise<unknown | undefined>;
}

export function loadCanadaRoadSources(
  descriptors: readonly CanadaRoadSourceDescriptor[] = CANADA_ROAD_SOURCES,
  dependencies: CanadaRoadLoadDependencies = {},
): Promise<{ records: CanadaRoadRecord[] | null; states: CanadaRoadSourceStates }> {
  return loadCanadaRoadSourcesCore(descriptors, {
    getHydrated: (key) => dependencies.getHydrated
      ? dependencies.getHydrated(key)
      : HYDRATED_LOADERS[key]?.(),
    // Every source is on-demand now, so this is the only fetch path. The
    // credentialed `?keys=` tier fetch it replaced no longer has a caller: a
    // tiered key arrives through hydration, never through a per-key request.
    fetchMissing: (descriptor) => dependencies.ensureOnDemand
      ? dependencies.ensureOnDemand(descriptor.key)
      : ON_DEMAND_LOADERS[descriptor.key]?.() ?? Promise.resolve(undefined),
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
