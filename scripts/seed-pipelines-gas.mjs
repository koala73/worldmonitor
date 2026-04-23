#!/usr/bin/env node
// @ts-check
//
// Publishes energy:pipelines:gas:v1 from the curated registry in
// scripts/data/pipelines-gas.json. See _pipeline-registry.mjs for the shared
// helpers + validation. See seed-pipelines-oil.mjs for the oil sibling —
// they are separate entry points because runSeed() hard-exits on its
// terminal paths (cannot chain two runSeed calls in one process).

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  GAS_CANONICAL_KEY,
  PIPELINES_TTL_SECONDS,
  MAX_STALE_MIN,
  buildGasPayload,
  validateRegistry,
  recordCount,
  declareRecords,
} from './_pipeline-registry.mjs';

loadEnvFile(import.meta.url);

const isMain = process.argv[1]?.endsWith('seed-pipelines-gas.mjs');

if (isMain) {
  runSeed('energy', 'pipelines-gas', GAS_CANONICAL_KEY, buildGasPayload, {
    validateFn: validateRegistry,
    ttlSeconds: PIPELINES_TTL_SECONDS,
    sourceVersion: 'pipelines-gas-registry-v1',
    recordCount,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    // File-read-and-validate seeder: if the container can't load/validate the
    // registry (stale image, missing data file, shape regression), fail LOUDLY
    // rather than refreshing seed-meta with recordCount=0. Without this, the
    // bundle's interval gate silently locks the seeder out for ~7 days after
    // a single transient validation failure.
    emptyDataIsFailure: true,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
