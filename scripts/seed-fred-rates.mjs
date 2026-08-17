#!/usr/bin/env node

import { loadEnvFile, runSeed, withRetry, writeExtraKeyWithMeta } from './_seed-utils.mjs';
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
const MIN_SERIES_COUNT = Math.ceil(FRED_SEED_SERIES.length * 0.75);
const SIDE_WRITE_RETRIES = 2;
const SIDE_WRITE_RETRY_DELAY_MS = 1_000;

export async function fetchFredBatch({
  fetchFredSeriesImpl = fetchFredSeries,
  fetchGscpiFromRedisImpl = fetchGscpiFromRedis,
  computeStressIndexImpl = computeStressIndex,
} = {}) {
  const seriesById = await fetchFredSeriesImpl();
  const usableSeriesById = Object.fromEntries(
    FRED_SEED_SERIES
      .filter((seriesId) => isUsableFredSeries(seriesById[seriesId]))
      .map((seriesId) => [seriesId, seriesById[seriesId]]),
  );
  const seriesIds = Object.keys(usableSeriesById);
  if (seriesIds.length === 0) throw new Error('FRED returned no usable series');

  const stressInputs = { ...usableSeriesById };
  const gscpi = await fetchGscpiFromRedisImpl();
  if (gscpi) stressInputs.GSCPI = gscpi;
  let stress = null;
  try {
    stress = computeStressIndexImpl(stressInputs);
  } catch (error) {
    console.warn(`  [StressIndex] skipped write — ${error instanceof Error ? error.message : error}`);
  }
  return {
    fetchedAt: new Date().toISOString(),
    seriesCount: seriesIds.length,
    seriesIds,
    missingSeriesIds: FRED_SEED_SERIES.filter((seriesId) => !usableSeriesById[seriesId]),
    seriesById: usableSeriesById,
    stress,
  };
}

export function projectFredBatch(batch) {
  return {
    fetchedAt: batch?.fetchedAt,
    seriesCount: batch?.seriesCount ?? 0,
    seriesIds: Array.isArray(batch?.seriesIds) ? batch.seriesIds : [],
    missingSeriesIds: Array.isArray(batch?.missingSeriesIds) ? batch.missingSeriesIds : [],
  };
}

export function validateFredBatch(batch) {
  return Number.isInteger(batch?.seriesCount) && batch.seriesCount >= MIN_SERIES_COUNT;
}

async function writeSideKeyWithMeta(
  writeFn,
  withRetryImpl,
  errorMessage,
) {
  await withRetryImpl(async () => {
    const wroteMeta = await writeFn();
    if (wroteMeta !== true) throw new Error(errorMessage);
  }, SIDE_WRITE_RETRIES, SIDE_WRITE_RETRY_DELAY_MS);
}

export async function publishFredSideKeys(batch, {
  writeExtraKeyWithMetaImpl = writeExtraKeyWithMeta,
  withRetryImpl = withRetry,
} = {}) {
  for (const seriesId of batch.seriesIds) {
    const series = batch.seriesById[seriesId];
    await writeSideKeyWithMeta(
      () => writeExtraKeyWithMetaImpl(
        `${FRED_KEY_PREFIX}:${seriesId}:0`,
        { series },
        FRED_TTL,
        series.observations.length,
      ),
      withRetryImpl,
      `FRED ${seriesId} seed-meta write failed`,
    );
  }

  if (batch.stress) {
    await writeSideKeyWithMeta(
      () => writeExtraKeyWithMetaImpl(
        STRESS_INDEX_KEY,
        batch.stress,
        STRESS_INDEX_TTL,
        batch.stress.components?.length ?? 0,
      ),
      withRetryImpl,
      'FRED stress-index seed-meta write failed',
    );
  }
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

export async function runFredRatesSeed(deps = {}) {
  const fetchBatch = () => fetchFredBatch({
    fetchFredSeriesImpl: deps.fetchFredSeriesImpl,
    fetchGscpiFromRedisImpl: deps.fetchGscpiFromRedisImpl,
    computeStressIndexImpl: deps.computeStressIndexImpl,
  });
  const seedOptions = {
    ttlSeconds: BATCH_TTL,
    validateFn: validateFredBatch,
    publishTransform: projectFredBatch,
    beforePublish: (batch) => publishFredSideKeys(batch, {
      writeExtraKeyWithMetaImpl: deps.writeExtraKeyWithMetaImpl,
      withRetryImpl: deps.withRetryImpl,
    }),
    sourceVersion: 'fred-v1',
    recordCount: (data) => data?.seriesCount ?? 0,
    declareRecords: (data) => data?.seriesCount ?? 0,
    schemaVersion: 1,
    maxStaleMin: 1500,
    afterPublish: markFredRatesActivated,
  };
  if (deps.markFredRatesActivatedImpl) {
    seedOptions.afterPublish = deps.markFredRatesActivatedImpl;
  }
  if (deps.runSeedImpl) {
    return deps.runSeedImpl('economic', 'fred-rates', CANONICAL_KEY, fetchBatch, seedOptions);
  }
  return runSeed('economic', 'fred-rates', CANONICAL_KEY, fetchBatch, seedOptions);
}

if (process.argv[1]?.endsWith('seed-fred-rates.mjs')) {
  runFredRatesSeed().catch((error) => {
    console.error('FATAL:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
