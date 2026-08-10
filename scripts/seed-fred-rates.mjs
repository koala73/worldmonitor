#!/usr/bin/env node

import { loadEnvFile, runSeed, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  FRED_KEY_PREFIX,
  FRED_SEED_SERIES,
  FRED_TTL,
  STRESS_INDEX_KEY,
  STRESS_INDEX_TTL,
  computeStressIndex,
  fetchFredSeries,
  fetchGscpiFromRedis,
  isUsableFredSeries,
} from './_fred-seeder.mjs';

loadEnvFile(import.meta.url, { only: ['FRED_API_KEY', 'PROXY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] });

export const CANONICAL_KEY = 'economic:fred:batch:v1';
export const BATCH_TTL = FRED_TTL;
// Versioned and durable (no TTL). /api/health uses this one-way marker to end
// the bounded deploy-before-provisioning grace as soon as the first complete
// FRED batch has published successfully.
export const FRED_RATES_ACTIVATION_KEY = 'seed-activated:economic:fred-rates:v1';

export async function fetchAndPublishFred({
  fetchFredSeriesImpl = fetchFredSeries,
  writeExtraKeyWithMetaImpl = writeExtraKeyWithMeta,
  fetchGscpiFromRedisImpl = fetchGscpiFromRedis,
  computeStressIndexImpl = computeStressIndex,
} = {}) {
  const seriesById = await fetchFredSeriesImpl();
  const entries = Object.entries(seriesById).filter(([, series]) => isUsableFredSeries(series));
  if (entries.length === 0) throw new Error('FRED returned no usable series');

  for (const [seriesId, series] of entries) {
    const wroteMeta = await writeExtraKeyWithMetaImpl(
      `${FRED_KEY_PREFIX}:${seriesId}:0`,
      { series },
      FRED_TTL,
      series.observations.length,
    );
    if (wroteMeta !== true) throw new Error(`FRED ${seriesId} seed-meta write failed`);
  }

  const stressInputs = { ...seriesById };
  const gscpi = await fetchGscpiFromRedisImpl();
  if (gscpi) stressInputs.GSCPI = gscpi;
  let stress = null;
  try {
    stress = computeStressIndexImpl(stressInputs);
  } catch (error) {
    console.warn(`  [StressIndex] skipped write — ${error instanceof Error ? error.message : error}`);
  }
  if (stress) {
    const wroteMeta = await writeExtraKeyWithMetaImpl(
      STRESS_INDEX_KEY,
      stress,
      STRESS_INDEX_TTL,
      stress.components?.length ?? 0,
    );
    if (wroteMeta !== true) throw new Error('FRED stress-index seed-meta write failed');
  }

  return { fetchedAt: new Date().toISOString(), seriesCount: entries.length, seriesIds: entries.map(([id]) => id) };
}

async function markFredRatesActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', FRED_RATES_ACTIVATION_KEY, '1', 'NX']);
  } catch (error) {
    // The canonical batch is already published when afterPublish runs. Keep
    // serving it and retry the marker next hour; the compiled rollout deadline
    // still guarantees health cannot remain softened indefinitely.
    console.warn(`  WARN: FRED activation marker write failed: ${error instanceof Error ? error.message : error}`);
  }
}

if (process.argv[1]?.endsWith('seed-fred-rates.mjs')) {
  runSeed('economic', 'fred-rates', CANONICAL_KEY, fetchAndPublishFred, {
    ttlSeconds: BATCH_TTL,
    validateFn: (data) => data?.seriesCount >= Math.ceil(FRED_SEED_SERIES.length * 0.75),
    sourceVersion: 'fred-v1',
    recordCount: (data) => data?.seriesCount ?? 0,
    declareRecords: (data) => data?.seriesCount ?? 0,
    schemaVersion: 1,
    maxStaleMin: 1500,
    afterPublish: markFredRatesActivated,
  }).catch((error) => {
    console.error('FATAL:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
