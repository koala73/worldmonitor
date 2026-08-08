#!/usr/bin/env node

import { loadEnvFile, runSeed, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import {
  FRED_KEY_PREFIX,
  FRED_SERIES,
  FRED_TTL,
  STRESS_INDEX_KEY,
  STRESS_INDEX_TTL,
  computeStressIndex,
  fetchFredSeries,
  fetchGscpiFromRedis,
} from './seed-economy.mjs';

loadEnvFile(import.meta.url, { only: ['FRED_API_KEY', 'PROXY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });

export const CANONICAL_KEY = 'economic:fred:batch:v1';
export const BATCH_TTL = FRED_TTL;

export async function fetchAndPublishFred() {
  const seriesById = await fetchFredSeries();
  const entries = Object.entries(seriesById);
  if (entries.length === 0) throw new Error('FRED returned no usable series');

  for (const [seriesId, series] of entries) {
    await writeExtraKeyWithMeta(`${FRED_KEY_PREFIX}:${seriesId}:0`, { series }, FRED_TTL, series.observations?.length ?? 0);
  }

  const stressInputs = { ...seriesById };
  const gscpi = await fetchGscpiFromRedis();
  if (gscpi) stressInputs.GSCPI = gscpi;
  try {
    const stress = computeStressIndex(stressInputs);
    if (stress) await writeExtraKeyWithMeta(STRESS_INDEX_KEY, stress, STRESS_INDEX_TTL, stress.components?.length ?? 0);
  } catch (error) {
    console.warn(`  [StressIndex] skipped write — ${error instanceof Error ? error.message : error}`);
  }

  return { fetchedAt: new Date().toISOString(), seriesCount: entries.length, seriesIds: entries.map(([id]) => id) };
}

if (process.argv[1]?.endsWith('seed-fred-rates.mjs')) {
  runSeed('economic', 'fred-rates', CANONICAL_KEY, fetchAndPublishFred, {
    ttlSeconds: BATCH_TTL,
    validateFn: (data) => data?.seriesCount >= Math.ceil(FRED_SERIES.length * 0.75),
    sourceVersion: 'fred-v1',
    recordCount: (data) => data?.seriesCount ?? 0,
    declareRecords: (data) => data?.seriesCount ?? 0,
    schemaVersion: 1,
    maxStaleMin: 1500,
  }).catch((error) => {
    console.error('FATAL:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
