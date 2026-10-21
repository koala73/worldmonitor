#!/usr/bin/env node
// @ts-check
//
// Publishes energy:pipelines:oil:v1 from the curated registry in
// scripts/data/pipelines-oil.json. See _pipeline-registry.mjs for the shared
// helpers + validation. See seed-pipelines-gas.mjs for the gas sibling —
// separate entry points because runSeed() hard-exits its terminal paths.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  OIL_CANONICAL_KEY,
  PIPELINES_TTL_SECONDS,
  MAX_STALE_MIN,
  buildOilPayload,
  validateRegistry,
  recordCount,
  declareRecords,
} from './_pipeline-registry.mjs';

loadEnvFile(import.meta.url);

const isMain = process.argv[1]?.endsWith('seed-pipelines-oil.mjs');

if (isMain) {
  runSeed('energy', 'pipelines-oil', OIL_CANONICAL_KEY, buildOilPayload, {
    validateFn: validateRegistry,
    ttlSeconds: PIPELINES_TTL_SECONDS,
    sourceVersion: 'pipelines-oil-registry-v1',
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
