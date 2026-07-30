// Shared memo for the fuel-shortage registry hydrated by bootstrap.
//
// Same rationale as src/shared/pipeline-registry-store and
// storage-facility-registry-store: getHydratedData() is single-use and
// this registry will be consumed by both FuelShortagePanel and the
// DeckGL shortage-pins layer, so both must read through a drained-once
// memo to avoid racing on the bootstrap cache.

import { getHydratedData } from '@/services/bootstrap';

export interface RawFuelShortageRegistry {
  shortages?: Record<string, unknown>;
  classifierVersion?: string;
  updatedAt?: string;
}

interface CachedRegistry {
  registry: RawFuelShortageRegistry | undefined;
  source: 'bootstrap' | 'rpc' | 'none';
}

let cache: CachedRegistry = { registry: undefined, source: 'none' };
let drained = false;

type BootstrapReader = (key: string) => unknown;
function defaultBootstrapReader(key: string): unknown {
  if (key === 'fuelShortages') return getHydratedData('fuelShortages');
  return getHydratedData(key);
}
let reader: BootstrapReader = defaultBootstrapReader;

export function getCachedFuelShortageRegistry(): CachedRegistry {
  if (!drained) {
    drained = true;
    const registry = reader('fuelShortages') as RawFuelShortageRegistry | undefined;
    if (registry) {
      cache = { registry, source: 'bootstrap' };
    }
  }
  return cache;
}

export function setCachedFuelShortageRegistry(registry: RawFuelShortageRegistry): void {
  drained = true;
  cache = { registry, source: 'rpc' };
}

export function __resetFuelShortageRegistryStoreForTests(): void {
  cache = { registry: undefined, source: 'none' };
  drained = false;
  reader = defaultBootstrapReader;
}

export function __setBootstrapReaderForTests(fn: (key: string) => unknown): void {
  reader = fn;
}
