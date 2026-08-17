#!/usr/bin/env node
/**
 * Optional seeder for VIA Rail Tracker unofficial live JSON (#6615).
 *
 * Best-effort, undocumented, no customer-facing SLA. 404 / shape-break skip
 * publish and record sourceState 'unavailable'. Do not fail the box.
 *
 * Runs as the VIA-Rail-Live member of seed-bundle-canada (#6711), not as its own
 * Railway service, gated on intervalMs 15min — an optional unofficial feed does
 * not earn a dedicated slot. Because the bundle owns the schedule, the freshness
 * acknowledgement clears on BUNDLE provisioning, not on this script deploying.
 */
import { loadEnvFile, readSeedSnapshot, runSeed, writeFreshnessMetadata } from './_seed-utils.mjs';
import {
  DEFAULT_FETCH,
  VIA_RAIL_LIVE_KEY,
  VIA_RAIL_LIVE_MAX_STALE_MIN,
  VIA_RAIL_LIVE_SCHEMA_VERSION,
  VIA_RAIL_LIVE_SOURCE_VERSION,
  VIA_RAIL_LIVE_TTL_SECONDS,
  fetchViaRailLive,
  resolveViaRailLivePublish,
  validateViaRailLiveSnapshot,
  viaRailLiveRecordCount,
} from './viarail-live.mjs';

loadEnvFile(import.meta.url);

async function fetchViaRailLiveSnapshot() {
  try {
    const fetchResult = await fetchViaRailLive({ fetchImpl: DEFAULT_FETCH });
    let lastGood = null;
    try {
      lastGood = await readSeedSnapshot(VIA_RAIL_LIVE_KEY);
    } catch (err) {
      console.warn(`  VIA Rail live last-good read failed: ${err?.message || err}`);
    }
    const decision = resolveViaRailLivePublish(fetchResult, lastGood);
    if (decision.persist) return decision.snapshot;

    console.warn(
      `  VIA Rail live skip (${decision.reason || 'unavailable'}): `
      + (decision.keepLastGood ? 'keeping last-good' : 'sourceState=unavailable'),
    );
    if (decision.sourceState === 'unavailable') {
      try {
        await writeFreshnessMetadata(
          'transit',
          'viarail-live',
          0,
          VIA_RAIL_LIVE_SOURCE_VERSION,
          VIA_RAIL_LIVE_TTL_SECONDS,
          undefined,
          undefined,
          { sourceState: 'unavailable', skipReason: decision.reason || 'unavailable' },
        );
      } catch (err) {
        console.warn(`  VIA Rail live unavailable-meta write failed: ${err?.message || err}`);
      }
    }
    return { sourceUnavailable: true, trains: [] };
  } catch (err) {
    console.warn(`  VIA Rail live unavailable: ${err?.message || err}`);
    return { sourceUnavailable: true, trains: [] };
  }
}

if (process.argv[1]?.endsWith('seed-viarail-live.mjs')) {
  runSeed(
    'transit',
    'viarail-live',
    VIA_RAIL_LIVE_KEY,
    fetchViaRailLiveSnapshot,
    {
      ttlSeconds: VIA_RAIL_LIVE_TTL_SECONDS,
      lockTtlMs: 60_000,
      fetchPhaseTimeoutMs: 30_000,
      validateFn: validateViaRailLiveSnapshot,
      declareRecords: viaRailLiveRecordCount,
      zeroIsValid: false,
      sourceVersion: VIA_RAIL_LIVE_SOURCE_VERSION,
      schemaVersion: VIA_RAIL_LIVE_SCHEMA_VERSION,
      maxStaleMin: VIA_RAIL_LIVE_MAX_STALE_MIN,
    },
  );
}
