#!/usr/bin/env node

// Railway service config (set up manually via Railway dashboard or `railway service`):
//   - Service name: seed-fire-detections
//   - Builder: NIXPACKS (root Dockerfile not used for this seed)
//   - rootDirectory: scripts
//   - startCommand: node seed-fire-detections.mjs
//   - Cron schedule: "*/10 * * * *" (every 10min UTC)

import { getRedisCredentials, loadEnvFile, readSeedSnapshot, redisCommand, runSeed, withRetry, writeExtraKey, MAX_PAYLOAD_BYTES } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';
import { compactWildfireDashboardPayload, WILDFIRE_CANONICAL_DETECTION_LIMIT } from './_wildfire-dashboard.mjs';
import {
  summarizeWildfireDetections,
  WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY,
  WILDFIRE_FIRES_SUMMARY_KEY,
  WILDFIRE_FIRES_SUMMARY_META_KEY,
} from './shared/wildfire-fires-summary.mjs';
import {
  fetchCwfisFires,
  CWFIS_SNAPSHOT_TTL_SECONDS,
  CWFIS_SNAPSHOT_KEY,
} from './wildfire/cwfis-wfs.mjs';
import {
  BC_SNAPSHOT_KEY,
  BC_SNAPSHOT_TTL_SECONDS,
  canadianWildfireAfterPublish,
  fetchBcFirePoints,
  hasCompleteWorldwideWildfireCoverage,
  mergeWildfireSourcesWithBc,
  wildfirePublishData,
} from './wildfire/bc-fire-points.mjs';
import {
  fetchAllFirmsRegions,
  FIRMS_SOURCES,
} from './wildfire/firms-area.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'wildfire:fires:v1';
const BOOTSTRAP_KEY = 'wildfire:fires-bootstrap:v1';

export function declareRecords(data) {
  return Array.isArray(data?.fireDetections) ? data.fireDetections.length : 0;
}

// Bound the canonical payload before it reaches atomicPublish (#5866). FIRMS detection volume
// is seasonal and unbounded: on 2026-07-30 a clean run (27/27 sources ok, zero upstream
// failures) accumulated 20,442 detections, serialized to 5.2MB, and atomicPublish hard-threw
// above its 5MB cap. That throw escapes to main().catch — exit 1, nothing published, TTL not
// extended — so the deliberately short 2h TTL below then blanked the panel.
//
// Ranking is the dashboard comparator (possibleExplosion -> confidence -> brightness -> frp ->
// detectedAt), so what gets dropped is always the lowest-signal tail, and the real FIRMS count
// survives in `pagination.totalCount`.
const CANONICAL_SOURCE_VERSION = `${FIRMS_SOURCES.join('+')}+firms-area-v2+cwfis-wfs-v1+bc-wildfire-kml-v1`;

function measureCanonicalPublishBytes(data) {
  return Buffer.byteLength(JSON.stringify(buildEnvelope({
    fetchedAt: Date.now(),
    recordCount: Array.isArray(data?.fireDetections) ? data.fireDetections.length : 0,
    sourceVersion: CANONICAL_SOURCE_VERSION,
    schemaVersion: 1,
    state: 'OK',
    data,
  })), 'utf8');
}

function capCanonicalPayload(data) {
  data = wildfirePublishData(data);
  const capped = compactWildfireDashboardPayload(data, WILDFIRE_CANONICAL_DETECTION_LIMIT, {
    maxBytes: MAX_PAYLOAD_BYTES,
    measureBytes: measureCanonicalPublishBytes,
  });
  // Same reference back = already under the cap (or an unrecognized shape). Never dereference
  // blindly here: a throw inside publishTransform is the exact FATAL this function exists to
  // prevent.
  if (capped === data) return data;
  const total = data.fireDetections.length;
  const kept = capped.fireDetections.length;
  console.log(`  canonical cap: publishing ${kept} of ${total} detections (dropped ${total - kept} lowest-signal to stay under the 5MB publish cap)`);
  return capped;
}

async function fetchMergedWildfires() {
  const apiKey = process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY || '';
  const cache = new Map();
  // Missing config is NOT runtime degradation. Without this refusal an absent key
  // reaches mergeWildfireSourcesWithBc, is swallowed by allSettled, and silently
  // republishes the canonical worldwide key as Canada-only on every tick.
  // Let a live FIRMS outage degrade; never let a misconfigured deploy do it.
  if (!apiKey) {
    console.error('[seed-fire-detections] NASA_FIRMS_API_KEY (or FIRMS_API_KEY) is required but not set. Refusing to run.');
    process.exit(1);
  }
  console.log('  FIRMS key configured');
  const data = await mergeWildfireSourcesWithBc({
    fetchFirms: () => fetchAllFirmsRegions(apiKey),
    fetchCwfis: async () => fetchCwfisFires({
      fetchFn: globalThis.fetch, cache,
      previousSnapshot: await readSeedSnapshot(CWFIS_SNAPSHOT_KEY),
    }),
    // The strict read fails closed, so a transient Upstash glitch (an HTTP-200
    // body that is not JSON, a 5xx, a timeout) would otherwise exit 1 with no
    // BC snapshot to persist. A read that keeps failing still exits 1 after
    // the retries, so last-good BC state is never overwritten from a bad read.
    fetchBcWildfire: async () => fetchBcFirePoints({
      fetchFn: globalThis.fetch, cache,
      previousSnapshot: await withRetry(() => readSeedSnapshot(BC_SNAPSHOT_KEY, { strict: true }), 2, 500),
    }),
  });
  if (data.fireDetections.length === 0) {
    await persistSourceSnapshots(data).catch(error => {
      throw Object.assign(error, { nonRetryable: true });
    });
  }
  return data;
}

async function persistSourceSnapshots(data) {
  const snapshot = data._cwfisSnapshot;
  if (!snapshot) throw new Error('CWFIS recovery snapshot is missing');
  await writeExtraKey(CWFIS_SNAPSHOT_KEY, snapshot, CWFIS_SNAPSHOT_TTL_SECONDS);
  await writeExtraKey('seed-meta:wildfire:cwfis-source', {
    fetchedAt: snapshot.fetchedAt,
    recordCount: snapshot.fireDetections.length,
    lastAttemptAt: snapshot.lastAttemptAt,
    sourceState: snapshot.consecutiveFailures ? 'degraded' : 'ok',
    sourceVersion: 'cwfis-recovery-v1',
  }, CWFIS_SNAPSHOT_TTL_SECONDS);
  const bcSnapshot = data._bcSnapshot;
  if (!bcSnapshot) throw new Error('BC recovery snapshot is missing');
  await writeExtraKey(BC_SNAPSHOT_KEY, bcSnapshot, BC_SNAPSHOT_TTL_SECONDS);
  await writeExtraKey('seed-meta:wildfire:bc-source', {
    fetchedAt: bcSnapshot.fetchedAt,
    recordCount: bcSnapshot.fireDetections.length,
    lastAttemptAt: bcSnapshot.lastAttemptAt,
    sourceState: bcSnapshot.errorCode ? 'degraded' : 'ok',
    errorCode: bcSnapshot.errorCode,
    sourceVersion: 'bc-fire-points-v1',
  }, BC_SNAPSHOT_TTL_SECONDS);
}

// Durable (no TTL) marker that ends /api/health's pre-rollout softening of the
// wildfiresSummary probe; runSeed calls it after the extra keys and the canonical
// seed-meta are written. Best-effort: a missed marker costs one more cycle of
// on-demand softening.
async function markSummaryActivated() {
  try {
    const { url, token } = getRedisCredentials();
    await redisCommand(url, token, ['SET', WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY, '1'], {
      label: `Activation marker ${WILDFIRE_FIRES_SUMMARY_ACTIVATION_KEY}`,
    });
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

async function main() {
  await runSeed('wildfire', 'fires', CANONICAL_KEY, fetchMergedWildfires, {
    // A partial response cannot replace a key whose contract is worldwide.
    // runSeed preserves both canonical and bootstrap last-good keys when this
    // returns false, then afterValidationSkip records the current diagnosis.
    validateFn: hasCompleteWorldwideWildfireCoverage,
    // 2h — deliberately BELOW the 6h health gate (maxStaleMin 360). Do NOT "fix" this
    // by raising it to satisfy tests/seed-ttl-outlives-staleness-fleet: doing so DOWNGRADES
    // a safety alarm. Verified against classifyKey with the seeder dead for 3h:
    //
    //   ttl 2h (this):  wildfires -> EMPTY (crit)   — ops is paged, panel blanks honestly
    //   ttl 7h:         wildfires -> OK    (green)  — 3h-old fire data served, silently
    //
    // The canonical `wildfires` is NOT in EMPTY_DATA_OK_KEYS, so its key expiring at 2h is
    // exactly what makes a dead fire feed loud. A longer TTL keeps stale data alive past
    // the gate and turns that crit into a warn (and, inside the gate, into a green).
    ttlSeconds: 7200,
    // Applied to the CANONICAL key only. runSeed feeds extraKey transforms the RAW fetcher
    // output, not publishData (scripts/_seed-utils.mjs), so the bootstrap key below still
    // ranks its top-500 over every detection FIRMS returned — capping here cannot change what
    // the dashboard renders. Capping inside fetchAllRegions would not have that property.
    publishTransform: capCanonicalPayload,
    lockTtlMs: 2_700_000, // 45 min — 27 slots × 72s (2 × 30s attempts + 2 × 6s pace) = 32.4 min; leave fetch and publication headroom. Overlapping cron ticks skip the held lock.
    fetchPhaseTimeoutMs: 2_400_000, // 40 min — bound whole-fetch retries if all upstreams fail, before the lock expires.
    sourceVersion: CANONICAL_SOURCE_VERSION,
    extraKeys: [{
      key: BOOTSTRAP_KEY,
      transform: (data) => compactWildfireDashboardPayload(wildfirePublishData(data)),
      declareRecords,
      metaKey: 'seed-meta:wildfire:fires-bootstrap',
    }, {
      // Per-country intensity rows plus the FIRMS clock for the CII and
      // temporal-anomaly rebuilds (#9509). Built from the RAW detections, so it
      // counts the whole fetch even when the canonical key above was capped.
      key: WILDFIRE_FIRES_SUMMARY_KEY,
      transform: (data) => summarizeWildfireDetections(wildfirePublishData(data)),
      declareRecords: (summary) => summary?.totalCount ?? 0,
      metaKey: WILDFIRE_FIRES_SUMMARY_META_KEY,
    }],
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 360,
    beforePublish: persistSourceSnapshots,
    afterPublish: canadianWildfireAfterPublish,
    // Success path only: the marker follows the summary extra key and the
    // canonical seed-meta, never a validation skip or a preserved last-good run.
    afterFreshness: markSummaryActivated,
    afterValidationSkip: async (data, { existingSeedMeta }) => {
      await persistSourceSnapshots(data);
      return canadianWildfireAfterPublish(data, { previousMeta: existingSeedMeta });
    },
  });
}

main().catch(err => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
