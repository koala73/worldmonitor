#!/usr/bin/env node
// Candidate manoeuvres for the profiled imaging satellites (#9110), from the R2 orbit-element
// history that seed-orbital-catalog.mjs keeps. Publishes the candidates with both element sets
// and the threshold applied, plus each satellite's status, to orbital:maneuvers:v1.
//
// Fails closed. Missing R2 config, an R2 read failure or a history of an unknown shape fails the
// run, so the previous publication stays and seed-meta ages; it never publishes "no manoeuvres".
// The record count is the number of satellites actually evaluated, so a history too short or too
// stale to judge anything is not published as an empty all-clear.
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

export function makeFetchManeuvers({
  storageConfig = resolveR2StorageConfig(process.env),
  readHistory = (config) => getR2JsonObject(config, ORBITAL_HISTORY_R2_KEY),
  now = () => Date.now(),
} = {}) {
  return async function fetchManeuvers() {
    if (!storageConfig) throw new Error('R2 storage is not configured; the orbit-element history cannot be read');
    const history = await readHistory(storageConfig);
    const payload = buildManeuverPayload(history, now());
    console.log(`  History entries: ${payload.history.entries}; evaluated satellites: ${payload.evaluatedSatellites}; candidates: ${payload.candidates.length}`);
    return payload;
  };
}

export function buildSeedOptions() {
  return {
    validateFn: (data) => data?.schema === MANEUVERS_SCHEMA && Array.isArray(data.candidates) && Array.isArray(data.satellites),
    ttlSeconds: TTL_SECONDS,
    recordCount: (data) => data?.evaluatedSatellites ?? 0,
    declareRecords: (data) => data?.evaluatedSatellites ?? 0,
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

/** Ships dark with the rest of Orbital Watch (#10710); the history keeps building meanwhile. */
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
