#!/usr/bin/env node
import {
  CROSS_STRAIT_ACTIVITY_KEY,
  fetchCrossStraitActivitySnapshot,
  validateCrossStraitActivitySnapshot,
} from './cross-strait-activity/adapters.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { loadEnvFile, readSeedSnapshot, runSeed, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CROSS_STRAIT_ACTIVITY_TTL_SECONDS = 180 * 24 * 60 * 60;
export const CROSS_STRAIT_ACTIVITY_MAX_CONTENT_AGE_MIN = 3 * DAY_MIN;
export const CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS = 240_000;
// Leave time after the bounded upstream phase to atomically publish the durable
// archive, its compact bootstrap projection, and both source-health records.
export const CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS = 40_000;
export const CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS = 320_000;
// Keep this literal inside scripts/: Railway's nixpacks service copies only
// scripts/, so importing the shared browser/Edge registry would crash at boot.
// The production-registration test pins it to BOOTSTRAP_CACHE_KEYS.
export const CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY = 'military:cross-strait-activity-bootstrap:v1';
export const CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY = 'seed-meta:military:cross-strait-activity-bootstrap';
export const CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY = 'seed-meta:military:cross-strait-activity:complete';
export const CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES = 128 * 1024;

if (CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS <= (
  CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS + CROSS_STRAIT_ACTIVITY_PUBLISH_CLEANUP_HEADROOM_MS
)) {
  throw new Error('cross-Strait activity lock TTL must exceed fetch deadline plus publish cleanup headroom');
}

function withoutRevisionHistory(observation) {
  const { history: _history, ...currentRevision } = observation;
  return currentRevision;
}

/**
 * The durable record retains the bounded MND backfill and correction vintages.
 * Bootstrap only needs the current MND row plus reviewed Japan context; keeping
 * archival revisions here would make initial hydration grow with every run.
 */
export function projectCrossStraitActivityBootstrap(snapshot) {
  const mnd = (snapshot?.observations ?? [])
    .filter((row) => row?.sourceId === 'taiwan-mnd')
    .sort((a, b) => Date.parse(b.reportingPeriod?.end ?? 0) - Date.parse(a.reportingPeriod?.end ?? 0))
    .slice(0, 1);
  const reviewedJapan = (snapshot?.observations ?? [])
    .filter((row) => row?.sourceId === 'japan-mod' && row?.observationKind === 'reviewed_regional_augmentation');
  const projection = {
    schemaVersion: snapshot?.schemaVersion,
    generatedAt: snapshot?.generatedAt,
    status: snapshot?.status,
    sources: snapshot?.sources ?? [],
    coverage: snapshot?.coverage ?? {},
    observations: [...mnd, ...reviewedJapan].map(withoutRevisionHistory),
    baselines: snapshot?.baselines ?? {},
  };
  const bytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
  if (bytes > CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES) {
    throw new Error(
      `cross-Strait activity bootstrap projection is ${bytes} bytes; maximum is ${CROSS_STRAIT_ACTIVITY_BOOTSTRAP_MAX_BYTES}`,
    );
  }
  return projection;
}

function sourceHealthKey(sourceId) {
  return `military:cross-strait-activity:v1:source:${sourceId}`;
}

function sourceHealthMetaKey(sourceId) {
  return `seed-meta:military:cross-strait-activity:${sourceId}`;
}

function sourceRecordCount(snapshot, sourceId) {
  return (snapshot?.observations ?? []).filter((row) => row?.sourceId === sourceId).length;
}

export async function writeSourceHealth(snapshot, writer = writeExtraKey) {
  await Promise.all((snapshot?.sources ?? []).map(async (source) => {
    const healthy = source?.transportStatus === 'fresh';
    const fetchedAt = Date.parse(source?.lastSuccessAt ?? '');
    await writer(sourceHealthKey(source.id), source, CROSS_STRAIT_ACTIVITY_TTL_SECONDS);
    await writer(sourceHealthMetaKey(source.id), {
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
      recordCount: sourceRecordCount(snapshot, source.id),
      sourceState: healthy ? 'ok' : 'error',
      stale: !healthy,
    }, CROSS_STRAIT_ACTIVITY_TTL_SECONDS);
  }));
}

export async function writePublicationCompletion(
  snapshot,
  writer = writeExtraKey,
  completedAt = Date.now(),
) {
  await writeSourceHealth(snapshot, writer);
  await writer(CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY, {
    fetchedAt: completedAt,
    recordCount: snapshot.observations.length,
    sourceState: 'ok',
  }, CROSS_STRAIT_ACTIVITY_TTL_SECONDS);
}

export function crossStraitActivityContentMeta(snapshot) {
  return tokensToContentMeta((snapshot?.observations ?? [])
    .filter((row) => row?.sourceId === 'taiwan-mnd')
    .map((row) => row.reportingPeriod?.end));
}

async function fetchSnapshot() {
  // This seed accumulates a staged 90-day backfill and revision history.
  // A failed Redis read must abort instead of replacing that state with a
  // first-run partial snapshot.
  const previousSnapshot = await readSeedSnapshot(CROSS_STRAIT_ACTIVITY_KEY, { strict: true });
  const snapshot = await fetchCrossStraitActivitySnapshot({ previousSnapshot });
  // A first-run MND failure cannot publish the durable archive, but its source
  // health still needs to tell operators why no archive exists yet.
  if (!validateCrossStraitActivitySnapshot(snapshot)) await writeSourceHealth(snapshot);
  return snapshot;
}

function validatePublishableSnapshot(snapshot) {
  if (!validateCrossStraitActivitySnapshot(snapshot)) return false;
  // runSeed commits the canonical key before extraKeys. Precomputing the
  // bounded projection here prevents a transform failure from creating a fresh
  // canonical archive with no UI payload. The completion marker below makes a
  // later source-health write failure retryable on the next bundle tick.
  projectCrossStraitActivityBootstrap(snapshot);
  return true;
}

if (process.argv[1]?.endsWith('seed-cross-strait-activity.mjs')) {
  runSeed('military', 'cross-strait-activity', CROSS_STRAIT_ACTIVITY_KEY, fetchSnapshot, {
    ttlSeconds: CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
    lockTtlMs: CROSS_STRAIT_ACTIVITY_LOCK_TTL_MS,
    fetchPhaseTimeoutMs: CROSS_STRAIT_ACTIVITY_FETCH_PHASE_TIMEOUT_MS,
    validateFn: validatePublishableSnapshot,
    declareRecords: (snapshot) => snapshot.observations.length,
    sourceVersion: 'taiwan-mnd-html+japan-joint-staff-reviewed-v1',
    schemaVersion: 1,
    maxStaleMin: 720,
    contentMeta: crossStraitActivityContentMeta,
    maxContentAgeMin: CROSS_STRAIT_ACTIVITY_MAX_CONTENT_AGE_MIN,
    extraKeys: [{
      key: CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY,
      transform: projectCrossStraitActivityBootstrap,
      declareRecords: (snapshot) => projectCrossStraitActivityBootstrap(snapshot).observations.length,
      metaKey: CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
      metaCritical: true,
    }],
    afterPublish: writePublicationCompletion,
  });
}
