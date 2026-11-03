#!/usr/bin/env node

import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import {
  buildArmsSupplierCompletion,
  DEFENSE_INDUSTRIAL_TTL_SECONDS,
} from './_defense-industrial-source.mjs';
import {
  ARMS_SUPPLIERS_COMPLETE_KEY,
  ARMS_SUPPLIERS_KEY,
  fetchSupplierSnapshot,
  supplierContentMeta,
  validateArmsSuppliers,
} from './_arms-suppliers-sweep.mjs';

loadEnvFile(import.meta.url, { only: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SIPRI_ARMS_API_BASE_URL'] });

export { ARMS_SUPPLIERS_COMPLETE_KEY, ARMS_SUPPLIERS_KEY };

// strict: an Upstash HTTP error must NOT read as an absent key here. redisGet
// degrades HTTP failures to null by default, which would make a transient 5xx
// look like a first run and republish one 56-importer slice over the ~200-row
// canonical key.
const readSnapshot = (key) => readCanonicalValue(key, { strict: true });

await runSeed('military', 'arms-suppliers', ARMS_SUPPLIERS_KEY, () => fetchSupplierSnapshot({
  readCanonical: readSnapshot,
}), {
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
      allowMissingOnSkip: true,
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
