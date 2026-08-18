#!/usr/bin/env node

import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import {
  buildArmsSupplierCompletion,
  buildSipriSupplierSnapshot,
  DEFENSE_INDUSTRIAL_TTL_SECONDS,
  fetchSipriSupplierDependencies,
  selectSweepImporters,
  SIPRI_SWEEP_CHUNK,
} from './_defense-industrial-source.mjs';

loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SIPRI_ARMS_API_BASE_URL'] });

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

async function fetchSupplierSnapshot() {
  const previousSnapshot = await readCanonicalValue(ARMS_SUPPLIERS_KEY).catch(() => null);
  const previous = previousSnapshot || {};
  return buildSipriSupplierSnapshot({
    previousSnapshot: previous,
    // One SLICE per tick. The full ~200-importer catalog needs ~800s at the
    // measured 31.8s/request and Railway kills the container at 600s, so a
    // whole-catalog pass cannot be made to fit at any deadline.
    fetchSipri: (options) => fetchSipriSupplierDependencies({
      ...options,
      selectImporters: (candidates, windowEndYear) => selectSweepImporters(
        candidates,
        previous,
        windowEndYear,
      ).slice(0, SIPRI_SWEEP_CHUNK),
    }),
  });
}

await runSeed('military', 'arms-suppliers', ARMS_SUPPLIERS_KEY, fetchSupplierSnapshot, {
  validateFn: validateArmsSuppliers,
  ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
  lockTtlMs: 7 * 60 * 1000,
  // Sized to one 56-importer chunk, not the catalog: 7 batches at concurrency 8,
  // p90 37.3s = ~261s of POSTs plus ~30s for getMaxYear + the catalog call. The
  // 270s soft budget inside the fetcher stops it taking new work first, so this
  // is the backstop rather than the normal exit.
  fetchPhaseTimeoutMs: 340 * 1000,
  declareRecords: (data) => Object.keys(data.importers || {}).length,
  sourceVersion: 'sipri-arms-transfers-v2',
  schemaVersion: 2,
  maxStaleMin: 28 * 24 * 60,
  maxContentAgeMin: 800 * 24 * 60,
  contentMeta: supplierContentMeta,
  publishTransform: (data) => ({
    importers: data.importers,
    stage: data.stage,
    fetchedAt: data.fetchedAt,
    source: 'SIPRI Arms Transfers Database',
  }),
  extraKeys: [
    {
      key: ARMS_SUPPLIERS_COMPLETE_KEY,
      ttl: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      transform: buildArmsSupplierCompletion,
      declareRecords: (data) => data.completedAt ? 1 : 0,
      skipWhenEmpty: true,
      metaKey: 'seed-meta:military:arms-suppliers-complete',
      metaTtlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS,
      metaExtra: (data) => ({
        newestItemAt: Date.UTC(data.windowEndYear, 11, 31, 23, 59, 59),
        oldestItemAt: Date.UTC(data.windowEndYear - 4, 0, 1),
        maxContentAgeMin: 800 * 24 * 60,
      }),
    },
  ],
  preserveKeyTtls: [
    { key: ARMS_SUPPLIERS_COMPLETE_KEY, ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
    { key: 'seed-meta:military:arms-suppliers-complete', ttlSeconds: DEFENSE_INDUSTRIAL_TTL_SECONDS },
  ],
});
