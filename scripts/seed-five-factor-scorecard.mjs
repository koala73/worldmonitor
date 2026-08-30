#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { getRedisCredentials, loadEnvFile, loadSharedConfig, runSeed, withRetry } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { listRankableCountries } from './shared/rankable-universe.mjs';
register();

// The Railway closure audit intentionally models a plain Node process for
// scripts-root Nixpacks services. This seeder self-registers tsx before its
// dynamic import, so declare the TypeScript module closure that _snapshot.ts
// imports. Each annotation is an exact deploy dependency, not a broad watch.
// @railway-runtime-dependency ./scorecard/v1/_input-registry.mts
// @railway-runtime-dependency ./scorecard/v1/_methodology.mts
// @railway-runtime-dependency ./scorecard/v1/_score-country.mts
// @railway-runtime-dependency ./scorecard/v1/_source-adapters.mts
// @railway-runtime-dependency ./scorecard/v1/_source-registry.mts
// @railway-runtime-dependency ./scorecard/v1/_types.mts

const {
  buildFiveFactorSnapshot,
  FIVE_FACTOR_SCORECARD_KEY,
  FIVE_FACTOR_SCORECARD_READ_MODEL_KEY,
  FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD,
  FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD,
  SCORECARD_SOURCE_KEYS,
  buildFiveFactorReadModel,
  scorecardCoverage,
  scorecardSnapshotBytes,
  validateFiveFactorSnapshot,
} = await import('./scorecard/v1/_snapshot.mts');

export const SCORECARD_TTL_SECONDS = 3 * 24 * 3600;
export const SCORECARD_MAX_STALE_MIN = 36 * 60;
export const SCORECARD_ACTIVATION_KEY = 'seed-activated:scorecard:five-factor';
/** sha256 of the last published canonical payload, used for retry idempotency. */
export const SCORECARD_FINGERPRINT_KEY = 'scorecard:five-factor:v1:fingerprint';

const FIXED_SOURCE_ENTRIES = Object.entries(SCORECARD_SOURCE_KEYS)
  .filter(([field]) => field !== 'staticByCountry');

function parseStored(value, nowMs = Date.now()) {
  if (value == null) return { data: null, freshness: { status: 'unknown' } };
  try {
    const { data, _seed } = unwrapEnvelope(JSON.parse(value));
    if (!_seed) return { data, freshness: { status: 'unknown' } };
    const maxContentAgeMin = Number(_seed.maxContentAgeMin);
    const newestItemAt = Number(_seed.newestItemAt);
    if (
      Number.isFinite(maxContentAgeMin)
      && maxContentAgeMin > 0
      && (!Number.isFinite(newestItemAt) || nowMs - newestItemAt > maxContentAgeMin * 60_000)
    ) {
      return {
        data,
        freshness: {
          status: 'stale',
          detail: Number.isFinite(newestItemAt)
            ? `Source content age exceeded ${maxContentAgeMin} minutes.`
            : 'Source content freshness metadata has no usable newestItemAt.',
        },
      };
    }
    return { data, freshness: { status: 'fresh' } };
  } catch {
    return { data: null, freshness: { status: 'unknown' } };
  }
}

export async function redisPipeline(commands, fetchImpl = globalThis.fetch) {
  const { url, token } = getRedisCredentials();
  const response = await fetchImpl(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor-Seed/1.0 (https://worldmonitor.app)',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`scorecard source pipeline HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || results.length !== commands.length || results.some((entry) => entry?.error)) {
    throw new Error('scorecard Redis pipeline returned an invalid command result');
  }
  return results;
}

export async function stageScorecardReadModel(snapshot, {
  runId,
  pipeline = redisPipeline,
  batchSize = 24,
} = {}) {
  const safeRunId = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeRunId) throw new Error('scorecard read model requires a runId');
  const stagingKey = `${FIVE_FACTOR_SCORECARD_READ_MODEL_KEY}:staging:${safeRunId}`;
  const readModel = buildFiveFactorReadModel(snapshot);
  const fields = [
    [FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD, readModel.metadata],
    [FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD, readModel.list],
    ...Object.entries(readModel.countries).map(([countryCode, record]) => [`country:${countryCode}`, record]),
  ];
  const batches = [];
  for (let offset = 0; offset < fields.length; offset += batchSize) {
    const command = ['HSET', stagingKey];
    for (const [field, value] of fields.slice(offset, offset + batchSize)) {
      command.push(field, JSON.stringify(value));
    }
    batches.push([command]);
  }
  const [firstBatch, ...remainingBatches] = batches;
  if (!firstBatch) throw new Error('scorecard read model has no fields');
  // atomicPublish calls beforePublish OUTSIDE its own retry loop, on the stated
  // assumption that "the callback's own writes own their retry policy". These
  // nine staging requests are that callback, and redisPipeline is a bare fetch
  // with no retry, so a single transient Upstash 5xx used to abort the whole
  // daily publication until the next six-hour tick. Match atomicPublish's policy.
  const stage = (commands) => withRetry(() => pipeline(commands), 2, 1000);
  try {
    await stage([...firstBatch, ['EXPIRE', stagingKey, '3600']]);
    const results = await Promise.allSettled(remainingBatches.map((commands) => stage(commands)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } catch (error) {
    await pipeline([['DEL', stagingKey]]).catch(() => {});
    throw error;
  }
  return stagingKey;
}

export function scorecardPayloadFingerprint(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

export async function publishScorecardCohortAtomically(stagingKey, {
  canonicalKey = FIVE_FACTOR_SCORECARD_KEY,
  payload,
  pipeline = redisPipeline,
  ttlSeconds = SCORECARD_TTL_SECONDS,
} = {}) {
  if (!stagingKey || typeof payload !== 'string') throw new Error('scorecard atomic publish requires stagingKey and payload');
  // The retry-idempotency branch answers "did MY payload already land?". It used
  // to answer that with GET KEYS[1] == ARGV[1], copying and comparing the whole
  // multi-MB canonical value inside a single-threaded, atomically-executing
  // script on a Redis instance shared with every other WorldMonitor service --
  // on exactly the ambiguous-retry path the retry logic exists for. Compare a
  // sha256 of the payload written alongside the canonical SET instead. The
  // fingerprint carries the canonical TTL so it can never outlive what it
  // describes, and the canonical/read-model EXISTS checks still gate the answer.
  const fingerprint = scorecardPayloadFingerprint(payload);
  await pipeline([
    [
      'EVAL',
      "if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('RENAME', KEYS[2], KEYS[3]); redis.call('EXPIRE', KEYS[3], ARGV[2]); redis.call('SET', KEYS[5], ARGV[3], 'EX', ARGV[2]); redis.call('SET', KEYS[4], '1'); return 1 end; if redis.call('GET', KEYS[5]) == ARGV[3] and redis.call('EXISTS', KEYS[1]) == 1 and redis.call('EXISTS', KEYS[3]) == 1 then redis.call('SET', KEYS[4], '1'); return 1 end; return redis.error_reply('scorecard staging cohort missing')",
      '5',
      canonicalKey,
      stagingKey,
      FIVE_FACTOR_SCORECARD_READ_MODEL_KEY,
      SCORECARD_ACTIVATION_KEY,
      SCORECARD_FINGERPRINT_KEY,
      payload,
      String(ttlSeconds),
      fingerprint,
    ],
  ]);
}

function techByIso2(rankings) {
  const iso3ToIso2 = loadSharedConfig('iso3-to-iso2.json');
  return Object.fromEntries((Array.isArray(rankings) ? rankings : [])
    .map((entry) => [iso3ToIso2[String(entry?.country || '').toUpperCase()], entry])
    .filter(([iso2]) => /^[A-Z]{2}$/.test(iso2 || '')));
}

export async function readScorecardSources(
  countryCodes = listRankableCountries(),
  { pipeline = redisPipeline, nowMs = Date.now() } = {},
) {
  const fixedEntries = FIXED_SOURCE_ENTRIES;
  const keys = [
    ...fixedEntries.map(([, key]) => key),
    ...countryCodes.map((countryCode) => `resilience:static:${countryCode}`),
  ];
  const response = await pipeline(keys.map((key) => ['GET', key]));
  if (!Array.isArray(response) || response.length !== keys.length) {
    throw new Error(`scorecard source pipeline returned ${response?.length ?? 0}/${keys.length} rows`);
  }
  const values = response.map((entry) => parseStored(entry?.result, nowMs));
  const fixedValues = Object.fromEntries(fixedEntries.map(([name], index) => [name, values[index]?.data]));
  const sourceFreshness = Object.fromEntries(fixedEntries.map(([name], index) => [name, values[index]?.freshness]));
  const staticOffset = fixedEntries.length;
  const staticByCountry = Object.fromEntries(countryCodes
    .map((countryCode, index) => [countryCode, values[staticOffset + index]?.data])
    .filter(([, value]) => value != null));
  const staticFreshnessByCountry = Object.fromEntries(countryCodes.map((countryCode, index) => [
    countryCode,
    values[staticOffset + index]?.freshness ?? { status: 'unknown' },
  ]));
  const staticFreshness = Object.values(staticFreshnessByCountry);
  sourceFreshness.staticByCountry = staticFreshness.some((entry) => entry.status === 'stale')
    ? { status: 'stale', detail: 'One or more country static snapshots exceeded their source freshness contract.', byCountry: staticFreshnessByCountry }
    : staticFreshness.some((entry) => entry.status === 'fresh')
      ? { status: 'fresh', byCountry: staticFreshnessByCountry }
      : { status: 'unknown', byCountry: staticFreshnessByCountry };
  return {
    population: fixedValues.population,
    foodStocks: fixedValues.foodStocks,
    demographics: fixedValues.demographics,
    defense: fixedValues.defense,
    energyMix: fixedValues.energyMix,
    staticByCountry: Object.keys(staticByCountry).length > 0 ? staticByCountry : null,
    lowCarbon: fixedValues.lowCarbon,
    powerLosses: fixedValues.powerLosses,
    importHhi: fixedValues.importHhi,
    techByIso2: fixedValues.techByIso2 ? techByIso2(fixedValues.techByIso2) : null,
    sourceFreshness,
  };
}

export async function buildScorecardSeedSnapshot({
  countryCodes = listRankableCountries(),
  now = () => new Date(),
  readSources = readScorecardSources,
} = {}) {
  const sources = await readSources(countryCodes);
  const snapshot = buildFiveFactorSnapshot(countryCodes, sources, now().toISOString());
  const coverage = scorecardCoverage(snapshot);
  console.log(`[scorecard] ${countryCodes.length} countries, ${coverage.scoreableCountries} scoreable, ${scorecardSnapshotBytes(snapshot)} bytes`);
  console.log(`[scorecard] scoreable by pillar ${JSON.stringify(coverage.scoreableCountriesByPillar)}`);
  return snapshot;
}

export function declareScorecardRecords(snapshot) {
  return scorecardCoverage(snapshot).scoreableCountries;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  loadEnvFile(import.meta.url);
  if (process.argv.includes('--dry-run')) {
    const snapshot = await buildScorecardSeedSnapshot();
    if (!validateFiveFactorSnapshot(snapshot)) throw new Error('dry-run snapshot validation failed');
    console.log('[scorecard] dry-run valid; Redis was not modified');
  } else {
    let stagedReadModelKey = null;
    runSeed('scorecard', 'five-factor', FIVE_FACTOR_SCORECARD_KEY, buildScorecardSeedSnapshot, {
    validateFn: validateFiveFactorSnapshot,
    ttlSeconds: SCORECARD_TTL_SECONDS,
    declareRecords: declareScorecardRecords,
    sourceVersion: 'five-factor-scorecard-1.0.0',
    schemaVersion: 1,
    maxStaleMin: SCORECARD_MAX_STALE_MIN,
    lockTtlMs: 240_000,
    fetchPhaseTimeoutMs: 25_000,
    emptyDataIsFailure: true,
    preserveKeys: [FIVE_FACTOR_SCORECARD_READ_MODEL_KEY],
    beforePublish: async (snapshot, { runId }) => {
      stagedReadModelKey = await stageScorecardReadModel(snapshot, { runId });
    },
    publishAtomically: async (_snapshot, { canonicalKey, payload, ttlSeconds }) => {
      if (!stagedReadModelKey) throw new Error('scorecard read model was not staged');
      await publishScorecardCohortAtomically(stagedReadModelKey, { canonicalKey, payload, ttlSeconds });
    },
    afterPublish: async (snapshot) => {
      const coverage = scorecardCoverage(snapshot);
      return {
        freshnessMetaPatch: {
          ...coverage,
          poolCounts: {
            population: coverage.populationEvidenceCountries,
            ...coverage.scoreableCountriesByPillar,
          },
        },
      };
    },
    }).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
