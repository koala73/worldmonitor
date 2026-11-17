#!/usr/bin/env node
// Candidate manoeuvres for the profiled imaging satellites (#9110), from the R2 orbit-element
// history that seed-orbital-catalog.mjs keeps. Publishes the candidates with both element sets
// and the threshold applied, plus each satellite's status, to orbital:maneuvers:v1.
//
// Fails closed. Missing R2 config, an R2 read failure or a history of an unknown shape fails the
// run, so the previous publication stays and seed-meta ages; it never publishes "no manoeuvres".
// A history that has stopped updating, or one too young for any satellite to be judged (the first
// ~11 days after the history starts), publishes nothing either: the run reports PUBLISH_BLOCKED,
// last-good stays, and health keeps the key pending (first publication) or ages it to STALE.
import {
  DEFAULT_DETECTION_OPTIONS,
  detectCandidateManeuvers,
  MANEUVER_DETECTION_VERSION,
  REGIME_FLOORS,
} from './_orbital-maneuvers.mjs';
import { assertReadableHistory, ORBITAL_HISTORY_R2_KEY } from './_orbital-history.mjs';
import { getR2JsonObject, resolveR2StorageConfig } from './_r2-storage.mjs';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';

loadEnvFile(import.meta.url);

export const ORBITAL_MANEUVERS_KEY = 'orbital:maneuvers:v1';
export const ORBITAL_MANEUVERS_ACTIVATION_KEY = 'seed-activated:orbital:maneuvers';
export const MANEUVERS_SCHEMA = 1;
export const TTL_SECONDS = 7 * 86_400;
// The climate bundle runs this every 6 hours; 4 missed runs before health calls it stale.
export const MAX_STALE_MIN = 1440;
// The catalog seeder adds new epochs every 2 hours; a history older than this has stopped updating.
export const MAX_HISTORY_AGE_MS = 12 * 3_600_000;

export function buildManeuverPayload(history, nowMs) {
  assertReadableHistory(history);
  const entries = history?.entries ?? [];
  // No space-weather source is wired in yet (#5700), so drag is unknown and a fall in LEO
  // semi-major axis is never flagged.
  const result = detectCandidateManeuvers(entries, { nowMs });
  return {
    schema: MANEUVERS_SCHEMA,
    detectionVersion: MANEUVER_DETECTION_VERSION,
    generatedAt: nowMs,
    history: {
      updatedAt: history?.updatedAt ?? null,
      windowDays: history?.windowDays ?? null,
      entries: entries.length,
    },
    method: {
      options: DEFAULT_DETECTION_OPTIONS,
      floors: REGIME_FLOORS,
      drag: 'unknown: falls in LEO semi-major axis are not flagged',
    },
    evaluatedSatellites: result.satellites.filter((s) => s.status === 'evaluated').length,
    candidates: result.candidates,
    satellites: result.satellites,
  };
}

/** Why this payload must not be published, or null: a stalled history or nothing judged yet. */
export function publishBlockReason(payload, history, nowMs) {
  const updatedAt = Number(history?.updatedAt);
  if (history && Number.isFinite(updatedAt) && nowMs - updatedAt > MAX_HISTORY_AGE_MS) {
    return `orbit-element history last updated ${Math.round((nowMs - updatedAt) / 3_600_000)} h ago; the catalog seeder's R2 writes have stopped`;
  }
  if (payload.evaluatedSatellites === 0) {
    return history
      ? 'no satellite has a full 10-day baseline in the orbit-element history yet'
      : 'no orbit-element history is stored yet';
  }
  return null;
}

export function makeFetchManeuvers({
  storageConfig = resolveR2StorageConfig(process.env),
  readHistory = (config) => getR2JsonObject(config, ORBITAL_HISTORY_R2_KEY),
  now = () => Date.now(),
} = {}) {
  return async function fetchManeuvers() {
    if (!storageConfig) throw new Error('R2 storage is not configured; the orbit-element history cannot be read');
    const history = await readHistory(storageConfig);
    const nowMs = now();
    const payload = buildManeuverPayload(history, nowMs);
    console.log(`  History entries: ${payload.history.entries}; evaluated satellites: ${payload.evaluatedSatellites}; candidates: ${payload.candidates.length}`);
    const blocked = publishBlockReason(payload, history, nowMs);
    return blocked ? { ...payload, publishBlocked: blocked } : payload;
  };
}

export function buildSeedOptions() {
  return {
    validateFn: (data) => data?.schema === MANEUVERS_SCHEMA && Array.isArray(data.candidates) && Array.isArray(data.satellites),
    ttlSeconds: TTL_SECONDS,
    // A blocked run declares zero, which sends runSeed down its publish-blocked path.
    recordCount: (data) => (data?.publishBlocked ? 0 : data?.evaluatedSatellites ?? 0),
    declareRecords: (data) => (data?.publishBlocked ? 0 : data?.evaluatedSatellites ?? 0),
    sourceVersion: `orbital-elements-history-detector-v${MANEUVER_DETECTION_VERSION}`,
    schemaVersion: MANEUVERS_SCHEMA,
    maxStaleMin: MAX_STALE_MIN,
    afterFreshness: async () => {
      const creds = getOptionalUpstashCreds();
      if (!creds) throw new Error('Missing orbital manoeuvre activation credentials');
      await upstashCommand(creds, ['SET', ORBITAL_MANEUVERS_ACTIVATION_KEY, '1']);
    },
  };
}

/** Runs only while Orbital Watch is on (ORBITAL_WATCH_ENABLED, #10710); the catalog seeder builds the history regardless. */
export const maneuversEnabled = (env = process.env) => (env.ORBITAL_WATCH_ENABLED ?? '').trim().toLowerCase() === 'true';

if (isMainModule(import.meta.url, process.argv[1]) && !maneuversEnabled()) {
  console.log('  SKIPPED: Orbital Watch ships dark (#10710); set ORBITAL_WATCH_ENABLED=true to publish candidate manoeuvres');
} else if (isMainModule(import.meta.url, process.argv[1])) {
  runSeed('orbital', 'maneuvers', ORBITAL_MANEUVERS_KEY, makeFetchManeuvers(), buildSeedOptions()).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
