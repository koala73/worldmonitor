// Shared memo for the oil & gas pipeline registries hydrated by bootstrap.
//
// Why this exists: src/services/bootstrap.ts getHydratedData() is
// single-use — it deletes the value on first read. The Energy Atlas has
// TWO consumers that both need the raw registries on first paint:
// (1) DeckGLMap's createEnergyPipelinesLayer(), (2) PipelineStatusPanel's
// bootstrap projection. Whichever read first would drain the cache and
// the other would fall back to RPC (or to the static PIPELINES layer on
// the map). This module reads once and memoizes so both consumers get
// identical data from the same source of truth.
//
// Update path: when the panel's background RPC fetch completes, it calls
// setCachedPipelineRegistries() to refresh the memo from the fresh data.
// The map picks up the new data on its next re-render cycle (triggered
// by state change from any other source), keeping map ↔ panel aligned.
//
// This is a read-through cache specific to the pipeline registries. It
// does NOT change bootstrap semantics for any other key.

import { getHydratedData } from '@/services/bootstrap';

export interface RawPipelineRegistry {
  pipelines?: Record<string, unknown>;
  classifierVersion?: string;
  updatedAt?: string;
}

interface CachedRegistries {
  gas: RawPipelineRegistry | undefined;
  oil: RawPipelineRegistry | undefined;
  /** Source: 'bootstrap' on first drain, 'rpc' after panel refresh. */
  source: 'bootstrap' | 'rpc' | 'none';
}

let cache: CachedRegistries = { gas: undefined, oil: undefined, source: 'none' };
let drained = false;

// Indirection so tests can inject a fake reader. Defaults to the real
// bootstrap getter; overridable via __setBootstrapReaderForTests.
// The literal getHydratedData('pipelinesGas') / ('pipelinesOil') calls
// below satisfy tests/bootstrap.test.mjs's consumer-coverage grep (which
// scans src/ for the literal string match). We can't call them at module
// top-level — that would drain bootstrap on import. So the default reader
// still reads lazily on demand; the literals live in the branch below.
type BootstrapReader = (key: string) => unknown;
function defaultBootstrapReader(key: string): unknown {
  if (key === 'pipelinesGas') return getHydratedData('pipelinesGas');
  if (key === 'pipelinesOil') return getHydratedData('pipelinesOil');
  return getHydratedData(key);
}
let reader: BootstrapReader = defaultBootstrapReader;

/**
 * Returns the cached oil & gas pipeline registries. On first call, drains
 * both bootstrap hydration slots and stores the result. Subsequent calls
 * return the same cached values regardless of how many consumers read.
 *
 * Returns the same object reference across calls until the cache is
 * updated via setCachedPipelineRegistries — callers that want to react
 * to updates should be re-invoked by whatever triggers their re-render
 * (RPC callback, panel re-render, etc.), not by polling this function.
 */
export function getCachedPipelineRegistries(): CachedRegistries {
  if (!drained) {
    drained = true;
    const gas = reader('pipelinesGas') as RawPipelineRegistry | undefined;
    const oil = reader('pipelinesOil') as RawPipelineRegistry | undefined;
    if (gas || oil) {
      cache = { gas, oil, source: 'bootstrap' };
    }
  }
  return cache;
}

/**
 * Updates the cache from a fresh RPC response (the panel calls this after
 * its background listPipelines() settles so the map picks up the newer
 * classifierVersion on its next render).
 *
 * Accepts per-registry updates or both at once. Skip a commodity by
 * passing undefined; existing cached value stays.
 */
export function setCachedPipelineRegistries(update: {
  gas?: RawPipelineRegistry;
  oil?: RawPipelineRegistry;
}): void {
  drained = true;
  cache = {
    gas: update.gas ?? cache.gas,
    oil: update.oil ?? cache.oil,
    source: 'rpc',
  };
}

/** Test-only: reset cache state so suites can exercise the drain-once behavior. */
export function __resetPipelineRegistryStoreForTests(): void {
  cache = { gas: undefined, oil: undefined, source: 'none' };
  drained = false;
  reader = defaultBootstrapReader;
}

/** Test-only: inject a fake bootstrap reader so suites can verify drain-once without
 *  a real bootstrap payload. */
export function __setBootstrapReaderForTests(fn: (key: string) => unknown): void {
  reader = fn;
}
