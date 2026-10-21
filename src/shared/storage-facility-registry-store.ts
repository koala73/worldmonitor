// Shared memo for the strategic storage registry hydrated by bootstrap.
//
// Why this exists: src/services/bootstrap.ts getHydratedData() is
// single-use — it deletes the value on first read. The Energy Atlas has
// TWO consumers that both need the raw registry on first paint:
// (1) DeckGLMap's createEnergyStorageLayer(), (2) StorageFacilityMapPanel's
// bootstrap projection. Whichever read first would drain the cache and
// the other would fall back to RPC (map would have no first-paint dots).
// This module reads once and memoizes so both consumers get identical
// data from the same source of truth.
//
// Ownership (#7046): `storageFacilities` is on-demand. Rolling-deploy
// clients still drain a leftover slow-tier payload via getHydratedData();
// new clients fetch through ensureHydrated() with one in-flight promise
// and one bounded resolved value.
//
// Mirror of src/shared/pipeline-registry-store.ts — same rationale, same
// test hooks. Kept as a separate module because the two registries use
// different bootstrap keys and have no shared projection logic.

import { ensureHydrated, getHydratedData } from '@/services/bootstrap';

export interface RawStorageFacilityRegistry {
  facilities?: Record<string, unknown>;
  classifierVersion?: string;
  updatedAt?: string;
}

interface CachedRegistry {
  registry: RawStorageFacilityRegistry | undefined;
  /** Source: 'bootstrap' on first drain, 'rpc' after panel refresh. */
  source: 'bootstrap' | 'rpc' | 'none';
}

let cache: CachedRegistry = { registry: undefined, source: 'none' };
let drained = false;
let inflight: Promise<CachedRegistry> | null = null;

// Indirection so tests can inject a fake reader. The literal
// getHydratedData('storageFacilities') call below satisfies
// tests/bootstrap.test.mjs's consumer-coverage grep.
type BootstrapReader = (key: string) => unknown;
function defaultBootstrapReader(key: string): unknown {
  if (key === 'storageFacilities') return getHydratedData('storageFacilities');
  return getHydratedData(key);
}
let reader: BootstrapReader = defaultBootstrapReader;

type OnDemandLoader = (key: string) => Promise<unknown | undefined>;
function defaultOnDemandLoader(key: string): Promise<unknown | undefined> {
  if (key === 'storageFacilities') return ensureHydrated('storageFacilities');
  return ensureHydrated(key);
}
let onDemandLoader: OnDemandLoader = defaultOnDemandLoader;

/**
 * Returns the cached storage registry. On first call, drains the
 * bootstrap hydration slot and stores the result. Subsequent calls return
 * the same cached value regardless of how many consumers read.
 */
export function getCachedStorageFacilityRegistry(): CachedRegistry {
  if (!drained) {
    drained = true;
    const registry = reader('storageFacilities') as RawStorageFacilityRegistry | undefined;
    if (registry) {
      cache = { registry, source: 'bootstrap' };
    }
  }
  return cache;
}

/**
 * Rolling-deploy hydration first, then one coalesced on-demand fetch.
 * Pass `{ refresh: true }` for later freshness ticks so the in-memory
 * resolved value does not suppress a new CDN-shielded read.
 */
export function ensureStorageFacilityRegistryHydrated(
  options: { refresh?: boolean } = {},
): Promise<CachedRegistry> {
  const existing = getCachedStorageFacilityRegistry();
  if (!options.refresh && existing.registry) return Promise.resolve(existing);
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const registry = await onDemandLoader('storageFacilities') as RawStorageFacilityRegistry | undefined;
      if (registry) {
        cache = { registry, source: 'bootstrap' };
        drained = true;
      }
      return cache;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Updates the cache from a fresh RPC response (the panel calls this after
 * its background listStorageFacilities() settles so the map picks up the
 * newer classifierVersion / fetchedAt on its next render).
 */
export function setCachedStorageFacilityRegistry(registry: RawStorageFacilityRegistry): void {
  drained = true;
  cache = { registry, source: 'rpc' };
}

/** Test-only: reset cache state so suites can exercise the drain-once behavior. */
export function __resetStorageFacilityRegistryStoreForTests(): void {
  cache = { registry: undefined, source: 'none' };
  drained = false;
  inflight = null;
  reader = defaultBootstrapReader;
  onDemandLoader = defaultOnDemandLoader;
}

/** Test-only: inject a fake bootstrap reader. */
export function __setBootstrapReaderForTests(fn: (key: string) => unknown): void {
  reader = fn;
}

/** Test-only: inject the on-demand fetch used after a rolling-deploy miss. */
export function __setOnDemandLoaderForTests(fn: OnDemandLoader): void {
  onDemandLoader = fn;
}
