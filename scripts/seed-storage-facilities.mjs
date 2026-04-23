#!/usr/bin/env node
// @ts-check
//
// Publishes energy:storage-facilities:v1 from the curated registry in
// scripts/data/storage-facilities.json. See _storage-facility-registry.mjs
// for the shared helpers + validation.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  STORAGE_FACILITIES_CANONICAL_KEY,
  STORAGE_FACILITIES_TTL_SECONDS,
  MAX_STALE_MIN,
  buildPayload,
  validateRegistry,
  recordCount,
  declareRecords,
} from './_storage-facility-registry.mjs';

loadEnvFile(import.meta.url);

const isMain = process.argv[1]?.endsWith('seed-storage-facilities.mjs');

if (isMain) {
  runSeed('energy', 'storage-facilities', STORAGE_FACILITIES_CANONICAL_KEY, buildPayload, {
    validateFn: validateRegistry,
    ttlSeconds: STORAGE_FACILITIES_TTL_SECONDS,
    sourceVersion: 'storage-facilities-registry-v1',
    recordCount,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    // File-read-and-validate seeder: if the container can't load/validate the
    // registry (stale image, missing data file, shape regression), fail LOUDLY
    // rather than refreshing seed-meta with recordCount=0. Without this, the
    // bundle gate silently locks the seeder out for ~5.5 days after a single
    // validation hiccup. See seed-pipelines-gas.mjs for the canonical incident.
    emptyDataIsFailure: true,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
