#!/usr/bin/env node
// - Service name: seed-alberta-emergency-alert
// Standalone nixpacks seeder for Alberta Emergency Alert Atom (#6610).
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

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'alerts:alberta-aea:v1';
const CACHE_TTL = 5400; // 90 min ≥ 3× the */15 cron (900s)

async function fetchAlbertaAea() {
  return fetchAlbertaEmergencyAlerts({ userAgent: CHROME_UA });
}

runSeed('alerts', 'alberta-aea', CANONICAL_KEY, fetchAlbertaAea, {
  validateFn: validateAlbertaAeaEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alberta-aea-v1',
  declareRecords: declareAlbertaAeaRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  contentMeta: albertaAeaContentMeta,
  maxContentAgeMin: AEA_MAX_CONTENT_AGE_MIN,
  publishTransform: albertaAeaPublishTransform,
  afterPublish: albertaAeaAfterPublish,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
