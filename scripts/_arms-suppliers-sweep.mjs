// The SIPRI arms-supplier sweep's entry point, extracted from the seeder so it
// can be executed by a test.
//
// scripts/seed-defense-industrial-suppliers.mjs ends in a top-level
// `await runSeed(...)`, so importing it runs a seed — which is why the wiring
// and read-failure guards there could only ever assert on the seeder's SOURCE
// TEXT. A regex cannot observe whether a read failure actually propagates, and
// one stayed green while it did not (#7524 review). Everything the tests need to
// drive lives here instead, with its dependencies injected.

import {
  buildSipriSupplierSnapshot,
  fetchSipriSupplierDependencies,
  SIPRI_SWEEP_CHUNK,
} from './_defense-industrial-source.mjs';

export const ARMS_SUPPLIERS_KEY = 'military:arms-suppliers:v1';
export const ARMS_SUPPLIERS_COMPLETE_KEY = 'military:arms-suppliers:complete:v1';

export function validateArmsSuppliers(data) {
  return data && Object.keys(data.importers || {}).length > 0;
}

export function supplierContentMeta(data) {
  const endYears = Object.values(data.importers || {})
    .map((entry) => entry?.window?.endYear)
    .filter(Number.isInteger);
  if (endYears.length === 0) return null;
  return {
    newestItemAt: Date.UTC(Math.max(...endYears), 11, 31, 23, 59, 59),
    oldestItemAt: Date.UTC(Math.min(...endYears), 0, 1),
  };
}

/**
 * One sweep tick: read the published snapshot, refresh the oldest slice, and
 * merge. A read failure MUST propagate — a snapshot that reads as absent is
 * indistinguishable from a first run, and a first run republishes one 56-row
 * slice over the ~200-row canonical key.
 *
 * @param {object} deps
 * @param {(key: string) => Promise<any>} deps.readCanonical strict canonical reader
 */
export async function fetchSupplierSnapshot({
  readCanonical,
  buildSnapshot = buildSipriSupplierSnapshot,
  fetchSipri = fetchSipriSupplierDependencies,
  maxSweepImporters = SIPRI_SWEEP_CHUNK,
} = {}) {
  const previousSnapshot = await readCanonical(ARMS_SUPPLIERS_KEY);
  const previous = previousSnapshot || {};
  return buildSnapshot({
    previousSnapshot: previous,
    // One SLICE per tick. The full ~200-importer catalog needs ~800s at the
    // measured 31.8s/request and Railway kills the container at 600s, so a
    // whole-catalog pass cannot be made to fit at any deadline.
    fetchSipri: (options) => fetchSipri({
      ...options,
      previousSnapshot: previous,
      maxSweepImporters,
    }),
  });
}
