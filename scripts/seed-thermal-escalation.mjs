#!/usr/bin/env node

import { loadEnvFile, runSeed, verifySeedKey, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { computeThermalEscalationWatch, emptyThermalEscalationWatch } from './lib/thermal-escalation.mjs';
import { compactThermalDashboardPayload } from './_thermal-dashboard.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'thermal:escalation:v1';
// Dashboard-sized projection of the canonical watch. The bootstrap slow tier
// hydrates from THIS key so every client stops downloading ~117 clusters to
// render 12 (#5300). The canonical key above is untouched and still serves the
// RPC and analytical consumers.
const BOOTSTRAP_KEY = 'thermal:escalation-bootstrap:v1';
const HISTORY_KEY = 'thermal:escalation:history:v1';
// 9h. The cron is `0 */3 * * *` — every THREE hours, not two (the previous comment
// said 2h and sized the TTL off that wrong premise). 9h = 3x the real interval, so
// two consecutive missed ticks still do not expire the key.
//
// It must also OUTLIVE maxStaleMin (360 = 6h) — at the old 6h they were exactly
// EQUAL, so a late seeder hit the staleness gate at the same instant its data
// expired, and health reported EMPTY (crit) for what is really STALE_SEED (warn).
// See tests/seed-ttl-outlives-staleness-fleet (#5309 invariant).
const CACHE_TTL = 9 * 60 * 60;
const SOURCE_VERSION = 'thermal-escalation-v1';
const MIN_THERMAL_ESCALATION_CLUSTERS = 1;
let latestHistoryPayload = { updatedAt: '', cells: {} };

async function fetchEscalations() {
  const [rawWildfires, previousHistory] = await Promise.all([
    verifySeedKey('wildfire:fires:v1'),
    verifySeedKey(HISTORY_KEY).catch(() => null),
  ]);

  const detections = Array.isArray(rawWildfires?.fireDetections) ? rawWildfires.fireDetections : [];
  if (detections.length === 0) {
    const result = {
      watch: emptyThermalEscalationWatch(Date.now(), SOURCE_VERSION),
      history: previousHistory?.cells ? previousHistory : { updatedAt: new Date().toISOString(), cells: {} },
    };
    latestHistoryPayload = result.history;
    return result;
  }

  const result = computeThermalEscalationWatch(detections, previousHistory, {
    nowMs: Date.now(),
    sourceVersion: SOURCE_VERSION,
  });
  latestHistoryPayload = result.history;
  return result;
}

export function declareRecords(data) {
  return Array.isArray(data?.clusters) ? data.clusters.length : 0;
}

export function validateFn(data) {
  return declareRecords(data) >= MIN_THERMAL_ESCALATION_CLUSTERS;
}

async function main() {
  await runSeed('thermal', 'escalation', CANONICAL_KEY, async () => {
    const result = await fetchEscalations();
    return result.watch;
  }, {
    validateFn,
    ttlSeconds: CACHE_TTL,
    lockTtlMs: 180_000,
    sourceVersion: SOURCE_VERSION,
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 360,
    extraKeys: [{
      key: BOOTSTRAP_KEY,
      transform: compactThermalDashboardPayload,
      declareRecords,
      metaKey: 'seed-meta:thermal:escalation-bootstrap',
    }],
    afterPublish: async () => {
      await writeExtraKeyWithMeta(
        HISTORY_KEY,
        latestHistoryPayload,
        30 * 24 * 60 * 60,
        Object.keys(latestHistoryPayload?.cells ?? {}).length,
      );
    },
  });
}

if (process.argv[1]?.endsWith('seed-thermal-escalation.mjs')) {
  main().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
