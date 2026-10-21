#!/usr/bin/env node
// Runs as the Alberta-Emergency-Alert member of seed-bundle-canada (#6711), not
// as its own Railway service. Gated on intervalMs 15min and kept there
// deliberately: the payload is ~12KB, so the cadence is about timeliness rather
// than bandwidth, and an emergency-alert layer that lags is worthless.
// Seeder for Alberta Emergency Alert Atom (#6610).
// Do not add Canada loops to ais-relay.cjs. Do not merge into the NWS weather alerts Redis key.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  fetchAlbertaEmergencyAlerts,
  declareAlbertaAeaRecords,
  validateAlbertaAeaEnvelope,
  albertaAeaContentMeta,
  AEA_MAX_CONTENT_AGE_MIN,
  albertaAeaAfterPublish,
  albertaAeaPublishTransform,
} from './lib/alberta-emergency-alert.mjs';
import {
  CANADA_ALERT_SOURCES,
  CANADA_ALERTS_LEGACY_KEY,
  rebuildCanadaAlertsUnion,
} from './lib/canada-alerts-union.mjs';

loadEnvFile(import.meta.url);

const SOURCE = CANADA_ALERT_SOURCES.find((entry) => entry.province === 'AB');
const CACHE_TTL = 5400; // 90 min ≥ 3× the */15 cron (900s)

async function fetchAlbertaAea() {
  return fetchAlbertaEmergencyAlerts({ userAgent: CHROME_UA });
}

runSeed('alerts', 'alberta-aea', SOURCE.key, fetchAlbertaAea, {
  validateFn: validateAlbertaAeaEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alberta-aea-v1',
  declareRecords: declareAlbertaAeaRecords,
  extraKeys: [{
    key: CANADA_ALERTS_LEGACY_KEY,
    transform: albertaAeaPublishTransform,
  }],
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  contentMeta: albertaAeaContentMeta,
  maxContentAgeMin: AEA_MAX_CONTENT_AGE_MIN,
  publishTransform: albertaAeaPublishTransform,
  afterPublish: async (data) => {
    const diagnostics = albertaAeaAfterPublish(data);
    await rebuildCanadaAlertsUnion({
      currentSource: {
        province: 'AB',
        snapshot: albertaAeaPublishTransform(data),
        metaPatch: diagnostics.freshnessMetaPatch,
      },
    });
    return diagnostics;
  },
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
