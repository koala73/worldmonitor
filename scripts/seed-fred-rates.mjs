#!/usr/bin/env node

import {
  CHROME_UA,
  getRedisCredentials,
  loadEnvFile,
  resolveSeedMetaTtl,
  runSeed,
} from './_seed-utils.mjs';
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

function seedMetaKeyFor(dataKey) {
  return `seed-meta:${dataKey.replace(/:v\d+$/, '')}`;
}

function fredPreserveKeyTtls() {
  return [
    {
      key: 'seed-meta:economic:fred-rates',
      ttlSeconds: resolveSeedMetaTtl(undefined, BATCH_TTL),
    },
    ...FRED_SEED_SERIES.flatMap((seriesId) => {
      const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
      return [
        { key, ttlSeconds: FRED_TTL },
        { key: seedMetaKeyFor(key), ttlSeconds: resolveSeedMetaTtl(undefined, FRED_TTL) },
      ];
    }),
    { key: STRESS_INDEX_KEY, ttlSeconds: STRESS_INDEX_TTL },
    {
      key: seedMetaKeyFor(STRESS_INDEX_KEY),
      ttlSeconds: resolveSeedMetaTtl(undefined, STRESS_INDEX_TTL),
    },
  ];
}

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

export async function publishFredCohortAtomically(batch, {
  canonicalKey = CANONICAL_KEY,
  payload,
  payloadValue,
  ttlSeconds = BATCH_TTL,
  fetchImpl = globalThis.fetch,
  credentials = getRedisCredentials(),
  fetchedAt = Date.now(),
} = {}) {
  if (typeof payload !== 'string') throw new Error('FRED atomic publish requires a serialized canonical payload');

  const seed = payloadValue?._seed;
  const cohortFetchedAt = Number.isFinite(seed?.fetchedAt) ? seed.fetchedAt : fetchedAt;
  const values = [];
  const expirations = [];
  const addValue = (key, value, keyTtlSeconds) => {
    values.push(key, typeof value === 'string' ? value : JSON.stringify(value));
    expirations.push(['EXPIRE', key, keyTtlSeconds]);
  };
  for (const seriesId of batch.seriesIds) {
    const key = `${FRED_KEY_PREFIX}:${seriesId}:0`;
    const series = batch.seriesById[seriesId];
    addValue(key, { series }, FRED_TTL);
    addValue(seedMetaKeyFor(key), {
      fetchedAt: cohortFetchedAt,
      recordCount: series.observations.length,
    }, resolveSeedMetaTtl(undefined, FRED_TTL));
  }

  if (batch.stress) {
    addValue(STRESS_INDEX_KEY, batch.stress, STRESS_INDEX_TTL);
    addValue(seedMetaKeyFor(STRESS_INDEX_KEY), {
      fetchedAt: cohortFetchedAt,
      recordCount: batch.stress.components?.length ?? 0,
    }, resolveSeedMetaTtl(undefined, STRESS_INDEX_TTL));
  }

  addValue('seed-meta:economic:fred-rates', {
    fetchedAt: cohortFetchedAt,
    recordCount: Number.isInteger(seed?.recordCount) ? seed.recordCount : batch.seriesCount,
    sourceVersion: typeof seed?.sourceVersion === 'string' ? seed.sourceVersion : 'fred-v1',
  }, resolveSeedMetaTtl(undefined, ttlSeconds));
  addValue(canonicalKey, payload, ttlSeconds);
  const commands = [['MSET', ...values], ...expirations];
  const response = await fetchImpl(`${credentials.url}/multi-exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`FRED atomic publication failed: HTTP ${response.status}`);
  const results = await response.json();
  if (
    !Array.isArray(results)
    || results.length !== commands.length
    || results[0]?.result !== 'OK'
    || results.slice(1).some((result) => result?.result !== 1)
  ) {
    throw new Error('FRED atomic publication returned an invalid command result');
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
    preserveKeyTtls: fredPreserveKeyTtls(),
    emptyDataIsFailure: true,
    publishAtomically: (batch, context) => (
      deps.publishFredCohortImpl ?? publishFredCohortAtomically
    )(batch, context),
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
