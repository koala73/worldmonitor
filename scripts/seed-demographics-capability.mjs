#!/usr/bin/env node
/**
 * Seed the country demographics capability stack into one on-demand Redis key.
 *
 * Each source stage settles independently. A partial outage retains only the
 * failed stage from the prior canonical snapshot, with the original fetchedAt.
 */

import {
  DEMOGRAPHICS_CAPABILITY_KEY,
  DEMOGRAPHICS_CAPABILITY_MAX_CONTENT_AGE_MIN,
  DEMOGRAPHICS_CAPABILITY_MAX_STALE_MIN,
  DEMOGRAPHICS_CAPABILITY_SOURCE_VERSION,
  DEMOGRAPHICS_CAPABILITY_TTL_SECONDS,
  buildDemographicsPayload,
  declareDemographicsRecords,
  demographicsContentMeta,
  demographicsStageCoverageMeta,
  fetchEducationStage,
  fetchIlostatStage,
  fetchWppStage,
  validateDemographicsPayload,
} from './_demographics-capability-source.mjs';
import { loadEnvFile, readSeedSnapshot, runSeed, writeFreshnessMetadataSafely } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const declareRecords = declareDemographicsRecords;
export const DEMOGRAPHICS_CAPABILITY_COMPLETION_RESOURCE = 'capability-complete';

/**
 * Stamp the bundle completion marker only after a fully fresh three-stage
 * publish. Partial/DEGRADED runs still write seed-meta via runSeed, and the
 * interval gate treats an older or missing completion as due.
 */
export async function recordDemographicsCapabilityCompletedRun(
  snapshot,
  writeMetadataFn = writeFreshnessMetadataSafely,
  now = Date.now(),
) {
  await writeMetadataFn(
    'demographics',
    DEMOGRAPHICS_CAPABILITY_COMPLETION_RESOURCE,
    declareDemographicsRecords(snapshot),
    DEMOGRAPHICS_CAPABILITY_SOURCE_VERSION,
    DEMOGRAPHICS_CAPABILITY_TTL_SECONDS,
    now,
  );
}

export async function demographicsCapabilityAfterPublish(
  data,
  writeMetadataFn = writeFreshnessMetadataSafely,
  now = Date.now(),
) {
  const coverage = demographicsStageCoverageMeta(data);
  if (coverage.status === 'complete') {
    await recordDemographicsCapabilityCompletedRun(data, writeMetadataFn, now);
  }
  return {
    completionState: coverage.status === 'complete' ? 'OK' : 'DEGRADED',
    freshnessMetaPatch: { coverage },
  };
}

const DEFAULT_STAGE_FETCHERS = Object.freeze({
  wpp: fetchWppStage,
  education: fetchEducationStage,
  ilostat: fetchIlostatStage,
});

async function runStageWithTimeout(name, timeoutMs, task) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`demographics ${name} stage timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchDemographicsCapability({
  fetchImpl = globalThis.fetch,
  now = new Date(),
  readPrevious = () => readSeedSnapshot(DEMOGRAPHICS_CAPABILITY_KEY, { strict: true }),
  stageFetchers = DEFAULT_STAGE_FETCHERS,
  stageTimeoutMs = 45_000,
} = {}) {
  const currentYear = now.getUTCFullYear();
  const previousPromise = readPrevious();
  const stagePromises = {
    wpp: runStageWithTimeout('wpp', stageTimeoutMs, (signal) => (
      stageFetchers.wpp({ fetchImpl, currentYear, signal })
    )),
    education: runStageWithTimeout('education', stageTimeoutMs, (signal) => (
      stageFetchers.education({ fetchImpl, currentYear, signal })
    )),
    ilostat: runStageWithTimeout('ilostat', stageTimeoutMs, (signal) => (
      stageFetchers.ilostat({ fetchImpl, signal })
    )),
  };
  const stageNames = Object.keys(stagePromises);
  const [stageResults, previousResult] = await Promise.all([
    Promise.allSettled(Object.values(stagePromises)),
    Promise.allSettled([previousPromise]),
  ]);
  const settled = Object.fromEntries(stageNames.map((name, index) => [name, stageResults[index]]));
  if (previousResult[0].status === 'rejected') throw previousResult[0].reason;
  const previous = previousResult[0].value;
  for (const [name, result] of Object.entries(settled)) {
    if (result.status === 'rejected') {
      console.warn(`  [demographics:${name}] ${result.reason?.message || result.reason}`);
    }
  }
  return buildDemographicsPayload(settled, previous, { generatedAt: now.toISOString() });
}

if (process.argv[1]?.endsWith('seed-demographics-capability.mjs')) {
  runSeed('demographics', 'capability', DEMOGRAPHICS_CAPABILITY_KEY, fetchDemographicsCapability, {
    validateFn: validateDemographicsPayload,
    ttlSeconds: DEMOGRAPHICS_CAPABILITY_TTL_SECONDS,
    sourceVersion: DEMOGRAPHICS_CAPABILITY_SOURCE_VERSION,
    schemaVersion: 1,
    declareRecords,
    maxStaleMin: DEMOGRAPHICS_CAPABILITY_MAX_STALE_MIN,
    contentMeta: demographicsContentMeta,
    maxContentAgeMin: DEMOGRAPHICS_CAPABILITY_MAX_CONTENT_AGE_MIN,
    afterPublish: (data) => demographicsCapabilityAfterPublish(data),
    emptyDataIsFailure: true,
    fetchPhaseTimeoutMs: 55_000,
    lockTtlMs: 70_000,
  }).catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
