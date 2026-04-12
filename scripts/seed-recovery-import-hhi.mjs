#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
const CACHE_TTL = 35 * 24 * 3600;

async function fetchImportHhi() {
  console.log('[seed] import-hhi: STUB — UN Comtrade HHI computation requires per-country bilateral queries with API key, writing empty payload');
  return { countries: {}, seededAt: new Date().toISOString(), stub: true };
}

function validate() {
  return true;
}

if (process.argv[1]?.endsWith('seed-recovery-import-hhi.mjs')) {
  runSeed('resilience', 'recovery:import-hhi', CANONICAL_KEY, fetchImportHhi, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'stub-v1',
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
