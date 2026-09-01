#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  EIA_OIL_TRANSIT_CHOKEPOINTS,
  EIA_OIL_TRANSIT_REFERENCE_YEAR,
  EIA_OIL_TRANSIT_SOURCE,
} from './chokepoint-eia-baselines.mjs';

export {
  buildEiaOilTransitBaselines,
  EIA_OIL_TRANSIT_REFERENCE_YEAR,
  EIA_OIL_TRANSIT_SOURCE,
} from './chokepoint-eia-baselines.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:chokepoint-baselines:v1';
export const CHOKEPOINT_TTL_SECONDS = 34_560_000;
export const CHOKEPOINTS = EIA_OIL_TRANSIT_CHOKEPOINTS;

export function buildPayload() {
  return {
    source: EIA_OIL_TRANSIT_SOURCE,
    referenceYear: EIA_OIL_TRANSIT_REFERENCE_YEAR,
    updatedAt: new Date().toISOString(),
    chokepoints: CHOKEPOINTS,
  };
}

export function validateFn(data) {
  return Array.isArray(data?.chokepoints) && data.chokepoints.length === 7;
}

const isMain = process.argv[1]?.endsWith('seed-chokepoint-baselines.mjs');
export function declareRecords(data) {
  return Array.isArray(data?.chokepoints) ? data.chokepoints.length : 0;
}

if (isMain) {
  runSeed('energy', 'chokepoint-baselines', CANONICAL_KEY, buildPayload, {
    validateFn,
    ttlSeconds: CHOKEPOINT_TTL_SECONDS,
    sourceVersion: 'eia-chokepoint-baselines-v1',
    recordCount: (data) => data?.chokepoints?.length || 0,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 576000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
