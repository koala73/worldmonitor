#!/usr/bin/env node
// Official Toronto Police Service Calls for Service public map (#6682).
// Member of seed-bundle-canada, gated on intervalMs 15min (layer refresh
// 15–20 min). Own key — do not append to canadaAlerts / canadaRoads /
// torontoRoads. Privacy exclusions stay empty; do not fill from radio/news.
// Last-good is this seeder's runSeed path; a TFS failure cannot wipe it.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  TPS_KEY,
  TPS_MAX_STALE_MIN,
  TPS_SOURCE_VERSION,
  TPS_TTL_SECONDS,
  declareTpsRecords,
  fetchTorontoTps,
  torontoTpsContentMeta,
  validateTpsEnvelope,
} from './lib/toronto-official-cad.mjs';

loadEnvFile(import.meta.url);

export const TPS_ACTIVATION_KEY = 'seed-activated:safety:toronto-tps';

async function markTpsActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', TPS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

runSeed('safety', 'toronto-tps', TPS_KEY, () => (
  fetchTorontoTps({ userAgent: CHROME_UA })
), {
  validateFn: validateTpsEnvelope,
  ttlSeconds: TPS_TTL_SECONDS,
  sourceVersion: TPS_SOURCE_VERSION,
  declareRecords: declareTpsRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: TPS_MAX_STALE_MIN,
  contentMeta: torontoTpsContentMeta,
  maxContentAgeMin: TPS_MAX_STALE_MIN,
  fetchPhaseTimeoutMs: 90_000,
  afterPublish: markTpsActivated,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
