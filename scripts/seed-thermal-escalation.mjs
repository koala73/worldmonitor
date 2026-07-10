#!/usr/bin/env node

import { loadEnvFile, runSeed, verifySeedKey, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { computeThermalEscalationWatch, emptyThermalEscalationWatch } from './lib/thermal-escalation.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'thermal:escalation:v1';
const HISTORY_KEY = 'thermal:escalation:history:v1';
const CACHE_TTL = 6 * 60 * 60; // 6h — cron runs every 2h; 3x interval so one missed run does not expire the key (was 3h = 1.5x, too tight)
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
