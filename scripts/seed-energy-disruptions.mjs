#!/usr/bin/env node
// @ts-check

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  ENERGY_DISRUPTIONS_CANONICAL_KEY,
  ENERGY_DISRUPTIONS_TTL_SECONDS,
  MAX_STALE_MIN,
  buildPayload,
  validateRegistry,
  recordCount,
  declareRecords,
} from './_energy-disruption-registry.mjs';

loadEnvFile(import.meta.url);

const isMain = process.argv[1]?.endsWith('seed-energy-disruptions.mjs');

if (isMain) {
  runSeed('energy', 'disruptions', ENERGY_DISRUPTIONS_CANONICAL_KEY, buildPayload, {
    validateFn: validateRegistry,
    ttlSeconds: ENERGY_DISRUPTIONS_TTL_SECONDS,
    sourceVersion: 'disruptions-registry-v1',
    recordCount,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    // See seed-pipelines-gas.mjs for rationale — strict validation failure
    // must leave seed-meta stale so the bundle retries every tick.
    emptyDataIsFailure: true,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
