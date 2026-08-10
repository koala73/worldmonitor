#!/usr/bin/env node
import {
  CROSS_STRAIT_ACTIVITY_KEY,
  CROSS_STRAIT_BLOCKED_SOURCE_REASONS,
  fetchCrossStraitActivitySnapshot,
  validateCrossStraitActivitySnapshot,
} from './cross-strait-activity/adapters.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { loadEnvFile, readSeedSnapshot, runSeed, writeExtraKey } from './_seed-utils.mjs';
import { makeSeedHistoryAfterPublish } from './_seed-history.mjs';

loadEnvFile(import.meta.url);

export const CROSS_STRAIT_ACTIVITY_TTL_SECONDS = 180 * 24 * 60 * 60;
export const CROSS_STRAIT_ACTIVITY_MAX_STALE_MIN = 720;
export const CROSS_STRAIT_ACTIVITY_SOURCE_FAILURE_TTL_SECONDS =
  CROSS_STRAIT_ACTIVITY_MAX_STALE_MIN * 60;
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
export const CROSS_STRAIT_ACTIVITY_JAPAN_SOURCE_HEALTH_KEY =
  `${CROSS_STRAIT_ACTIVITY_KEY}:source:japan-mod`;
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
 * Strips operator-only diagnostics from the anonymous bootstrap. The proxy
 * fields describe OUR egress rather than the source: the response detail can
 * carry upstream body text, and the control probe reports whether our own proxy
 * is currently working. `shadowIndexProbe` is the same class of information for
 * the blocked English index. `candidates` is a review-workflow artifact — the UI
 * renders only admitted observations, so publishing an unreviewed backlog to
 * every anonymous client would grow hydration for nobody's benefit. The bounded
 * reason codes that remain (`blockedReason`, `fallbackReason`,
 * `proxyFailureReason`) are what the disclosure UI reads, and they explain the
 * state without publishing our transport's health.
 */
function withoutOperatorOnlyDiagnostics(source) {
  const {
    proxyFailureDetail: _proxyFailureDetail,
    proxyControlProbe: _proxyControlProbe,
    shadowIndexProbe: _shadowIndexProbe,
    candidates: _candidates,
    ...publicSource
  } = source;
  return publicSource;
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
    sources: (snapshot?.sources ?? []).map(withoutOperatorOnlyDiagnostics),
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
  const outcomes = await Promise.allSettled((snapshot?.sources ?? []).map(async (source) => {
    const healthy = source?.transportStatus === 'fresh';
    const blocked = CROSS_STRAIT_BLOCKED_SOURCE_REASONS.includes(source?.blockedReason);
    const fetchedAt = Date.parse(
      blocked ? snapshot?.generatedAt ?? '' : source?.lastSuccessAt ?? '',
    );
    const metaTtlSeconds = healthy || blocked
      ? CROSS_STRAIT_ACTIVITY_TTL_SECONDS
      : CROSS_STRAIT_ACTIVITY_SOURCE_FAILURE_TTL_SECONDS;
    const writeData = () => writer(
      sourceHealthKey(source.id),
      source,
      CROSS_STRAIT_ACTIVITY_TTL_SECONDS,
    );
    const writeMeta = () => writer(sourceHealthMetaKey(source.id), {
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
      recordCount: sourceRecordCount(snapshot, source.id),
      sourceState: healthy ? 'ok' : (blocked ? 'blocked' : 'error'),
      stale: !healthy && !blocked,
    }, metaTtlSeconds);

    // Never leave health claiming success when an error detail write fails.
    // Healthy observations may publish data first because an older `ok` meta
    // remains truthful; degraded observations publish the error meta first.
    if (healthy || blocked) {
      await writeData();
      await writeMeta();
    } else {
      await writeMeta();
      await writeData();
    }
  }));
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `cross-Strait source-health write failed: ${failures.map((error) => error?.message ?? error).join('; ')}`,
    );
  }
}

export async function writePublicationCompletion(
  snapshot,
  writer = writeExtraKey,
  completedAt = Date.now(),
) {
  await writer(CROSS_STRAIT_ACTIVITY_COMPLETION_META_KEY, {
    fetchedAt: completedAt,
    recordCount: snapshot.observations.length,
    sourceState: 'ok',
  }, CROSS_STRAIT_ACTIVITY_TTL_SECONDS);
}

/**
 * runSeed invokes the hook as `afterFreshness(data, { canonicalKey, ttlSeconds,
 * recordCount, runId })`. `writePublicationCompletion` takes its injectable
 * writer in that same positional slot, and a `= writeExtraKey` default only
 * applies to `undefined` — so wiring it in bare put the meta object in `writer`
 * and threw `TypeError: writer is not a function` on every run (#5614). Keep
 * the runSeed meta in its own ignored slot and the writer seam after it.
 */
export function crossStraitActivityAfterPublish(snapshot, _runSeedMeta, writer = writeExtraKey) {
  return writePublicationCompletion(snapshot, writer);
}

// Source-health is a mandatory pre-publication cohort; completion uses the
// meta-tolerant #5614 wrapper only after primary freshness metadata succeeds.
export const crossStraitActivityBeforePublish = (snapshot) => writeSourceHealth(snapshot);

export function crossStraitActivityContentMeta(snapshot) {
  return tokensToContentMeta((snapshot?.observations ?? [])
    .filter((row) => row?.sourceId === 'taiwan-mnd')
    .map((row) => row.reportingPeriod?.end));
}

/**
 * A rejected first publication can leave source health with the only durable
 * Japan candidate/probe cursor. Keep that cursor available for the next tick
 * when the canonical archive was never published.
 */
export async function fetchCrossStraitActivitySeedSnapshot({
  readSnapshot = readSeedSnapshot,
  fetchSnapshot: fetchSnapshotFn = fetchCrossStraitActivitySnapshot,
  writeHealth = writeSourceHealth,
} = {}) {
  // This seed accumulates a staged 90-day backfill and revision history.
  // A failed Redis read must abort instead of replacing that state with a
  // first-run partial snapshot.
  const previousSnapshot = await readSnapshot(CROSS_STRAIT_ACTIVITY_KEY, { strict: true });
  const previousSourceHealth = previousSnapshot
    ? null
    : await readSnapshot(CROSS_STRAIT_ACTIVITY_JAPAN_SOURCE_HEALTH_KEY);
  const snapshot = await fetchSnapshotFn({ previousSnapshot, previousSourceHealth });
  // A first-run MND failure cannot publish the durable archive, but its source
  // health still needs to tell operators why no archive exists yet.
  if (!validateCrossStraitActivitySnapshot(snapshot)) await writeHealth(snapshot);
  return snapshot;
}

async function fetchSnapshot() {
  return fetchCrossStraitActivitySeedSnapshot();
}

// Which country's ministry reported the observation, for the history store's
// filterable country field (the activity itself concerns the Taiwan Strait).
const HISTORY_SOURCE_COUNTRY = Object.freeze({ 'taiwan-mnd': 'TW', 'japan-mod': 'JP' });

/**
 * Project published cross-Strait observations into intel-history records
 * (#5694). Observations are revisioned in place (same id, new vintage); the
 * dedupe key intentionally uses the bare observation id so history keeps the
 * first-seen vintage rather than one row per correction.
 */
export function buildCrossStraitHistoryRecords(snapshot) {
  return (snapshot?.observations ?? []).map((obs) => {
    if (!obs?.id) return null;
    const occurredAt = Date.parse(obs.reportingDay ?? '') || Date.parse(obs.publicationTime ?? '');
    if (!Number.isFinite(occurredAt) || occurredAt <= 0) return null;
    const categories = obs.categories && typeof obs.categories === 'object'
      ? Object.entries(obs.categories)
        .filter(([, value]) => value != null && value !== '')
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ')
      : '';
    const detail = obs.summary || categories || obs.originalTerminology || 'activity report';
    return {
      dedupeKey: `military:cross-strait-activity:${obs.id}`,
      country: HISTORY_SOURCE_COUNTRY[obs.sourceId],
      category: obs.observationKind || undefined,
      title: `Cross-Strait activity ${obs.reportingDay ?? ''}: ${detail}`.trim(),
      summary: obs.summary || undefined,
      sourceUrl: obs.sourceUrl || undefined,
      occurredAt,
    };
  }).filter(Boolean);
}

// This seeder's completion marker rides afterFreshness, so history takes the
// afterPublish slot.
export const crossStraitHistoryAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'military',
  resource: 'cross-strait-activity',
  buildRecords: buildCrossStraitHistoryRecords,
});

function validatePublishableSnapshot(snapshot) {
  if (!validateCrossStraitActivitySnapshot(snapshot)) return false;
  // runSeed commits the canonical key before extraKeys. Precomputing the
  // bounded projection here prevents a transform failure from creating a fresh
  // canonical archive with no UI payload. Source health is written through
  // runSeed's pre-publish hook; the completion marker remains the final cohort
  // write so the bundle retries any partial publication on its next tick.
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
    // Bumped with the #5904 discovery cutover and the bounded empty-content
    // proxy fallback: a merged PR is not proof the new adapter is running, and
    // the published `_seed.sourceVersion` is what lets an operator distinguish
    // this resilient homepage-discovery run from an older deployed adapter.
    sourceVersion: 'taiwan-mnd-html+japan-joint-staff-homepage-v3',
    schemaVersion: 1,
    maxStaleMin: CROSS_STRAIT_ACTIVITY_MAX_STALE_MIN,
    contentMeta: crossStraitActivityContentMeta,
    maxContentAgeMin: CROSS_STRAIT_ACTIVITY_MAX_CONTENT_AGE_MIN,
    extraKeys: [{
      key: CROSS_STRAIT_ACTIVITY_BOOTSTRAP_KEY,
      transform: projectCrossStraitActivityBootstrap,
      declareRecords: (projection) => projection.observations.length,
      metaKey: CROSS_STRAIT_ACTIVITY_BOOTSTRAP_META_KEY,
      metaCritical: true,
    }],
    beforePublish: crossStraitActivityBeforePublish,
    afterPublish: crossStraitHistoryAfterPublish,
    afterFreshness: crossStraitActivityAfterPublish,
  });
}
