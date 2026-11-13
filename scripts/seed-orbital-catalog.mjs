#!/usr/bin/env node
// Orbit elements for every satellite in the sensor-profile inventory, from CelesTrak's
// `active` GP group, with a daily ring of prior elements: past passes are computed from the
// elements nearest in time, because propagating today's elements back a week drifts.
import { pathToFileURL } from 'node:url';
import {
  buildCatalog,
  CELESTRAK_ACTIVE_URL,
  ORBITAL_CATALOG_ACTIVATION_KEY,
  ORBITAL_CATALOG_KEY,
  RING_DAYS,
} from './_orbital-catalog.mjs';
import { loadEnvFile, markPreservableFetchFailure, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

export { ORBITAL_CATALOG_ACTIVATION_KEY, ORBITAL_CATALOG_KEY };

const USER_AGENT = 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)';
const FETCH_TIMEOUT_MS = 60_000;
// The ring outlives a multi-day seeder outage; readers judge freshness by fetchedAt.
export const CACHE_TTL_SECONDS = RING_DAYS * 86_400;
// The climate bundle runs every 3 hours; 3x that before health calls the catalog stale.
export const MAX_STALE_MIN = 540;
// CelesTrak answers 403 to a client that downloads unchanged data again too soon.
const REFUSAL_STATUSES = new Set([403, 429]);

function outage(message) {
  const err = markPreservableFetchFailure(new Error(message));
  err.nonRetryable = true;
  return err;
}

function blocked(reason) {
  return { publishBlocked: reason, satellites: [], ring: [] };
}

export async function fetchOrbitalCatalog({
  fetchImpl = (...args) => globalThis.fetch(...args),
  readPrevious = () => readCanonicalValue(ORBITAL_CATALOG_KEY, { strict: true }),
  nowMs = Date.now(),
} = {}) {
  // Before the download: a failed Redis read retries the run, and a repeat download
  // inside CelesTrak's update interval is refused.
  const previous = await readPrevious();
  let response;
  try {
    response = await fetchImpl(CELESTRAK_ACTIVE_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw outage(`CelesTrak unreachable: ${err?.message || err}`);
  }
  if (REFUSAL_STATUSES.has(response.status)) {
    await response.body?.cancel();
    return blocked(`CelesTrak refused the download (HTTP ${response.status})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw outage(`CelesTrak HTTP ${response.status}`);
  }
  let records;
  try {
    records = await response.json();
  } catch (err) {
    throw outage(`CelesTrak returned unreadable JSON: ${err?.message || err}`);
  }
  if (!Array.isArray(records)) return blocked('CelesTrak returned no element list');
  const catalog = buildCatalog({ records, previous, nowMs });
  if (catalog.satellites.length === 0) return blocked(`none of ${records.length} CelesTrak objects matches a sensor profile`);
  console.log(`  Profiled satellites: ${catalog.satellites.length} of ${records.length}; ring days: ${catalog.ring.map((d) => d.day).join(', ')}`);
  return catalog;
}

export function buildSeedOptions() {
  return {
    validateFn: (data) => Array.isArray(data?.satellites) && data.satellites.length > 0,
    ttlSeconds: CACHE_TTL_SECONDS,
    recordCount: (data) => data?.satellites?.length ?? 0,
    declareRecords: (data) => data?.satellites?.length ?? 0,
    sourceVersion: 'celestrak-gp-active-omm',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    // runSeed calls this only after the canonical key and seed-meta are written.
    afterFreshness: async () => {
      const creds = getOptionalUpstashCreds();
      if (!creds) throw new Error('Missing orbital catalog activation credentials');
      await upstashCommand(creds, ['SET', ORBITAL_CATALOG_ACTIVATION_KEY, '1']);
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed('orbital', 'catalog', ORBITAL_CATALOG_KEY, () => fetchOrbitalCatalog(), buildSeedOptions()).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
