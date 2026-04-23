#!/usr/bin/env node
// @ts-check
//
// Publishes energy:fuel-shortages:v1 from the curated registry in
// scripts/data/fuel-shortages.json.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  FUEL_SHORTAGES_CANONICAL_KEY,
  FUEL_SHORTAGES_TTL_SECONDS,
  MAX_STALE_MIN,
  buildPayload,
  validateRegistry,
  recordCount,
  declareRecords,
} from './_fuel-shortage-registry.mjs';

loadEnvFile(import.meta.url);

const isMain = process.argv[1]?.endsWith('seed-fuel-shortages.mjs');

if (isMain) {
  runSeed('energy', 'fuel-shortages', FUEL_SHORTAGES_CANONICAL_KEY, buildPayload, {
    validateFn: validateRegistry,
    ttlSeconds: FUEL_SHORTAGES_TTL_SECONDS,
    sourceVersion: 'fuel-shortages-registry-v1',
    recordCount,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
