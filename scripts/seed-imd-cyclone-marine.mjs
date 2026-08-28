#!/usr/bin/env node
/**
 * IMD cyclone, port, coastal, and marine seeder (#7005).
 *
 * Planned Railway service for cyclone/port/coastal/marine products only.
 * Does not write the NWS/ECCC/SWIC weather-alerts key. Live fetch requires IMD_API_KEY.
 */

import { loadEnvFile, CHROME_UA, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  IMD_CANONICAL_KEY,
  IMD_MAX_CONTENT_AGE_MIN,
  IMD_SOURCE_VERSION,
  declareImdRecords,
  fetchImdCycloneMarine,
  imdAfterPublish,
  imdContentMeta,
  validateImdEnvelope,
} from './lib/imd-cyclone-marine.mjs';

loadEnvFile(import.meta.url);

export const IMD_ACTIVATION_KEY = 'seed-activated:weather:imd-cyclone-marine';

const CACHE_TTL = 5400;

async function markImdActivated(data) {
  const result = imdAfterPublish(data);
  if (data?.coverageState === 'disabled') return result;
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return result;
    await upstashCommand(creds, ['SET', IMD_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
  return result;
}

async function fetchSnapshot() {
  let previous = null;
  try {
    const existing = await readCanonicalValue(IMD_CANONICAL_KEY);
    if (existing && typeof existing === 'object') previous = existing;
  } catch (err) {
    console.warn(`imd-cyclone-marine: last-good read failed: ${err.message || err}`);
  }
  return fetchImdCycloneMarine({ userAgent: CHROME_UA, previous });
}

runSeed('weather', 'imd-cyclone-marine', IMD_CANONICAL_KEY, fetchSnapshot, {
  validateFn: validateImdEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: IMD_SOURCE_VERSION,
  declareRecords: declareImdRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  contentMeta: imdContentMeta,
  maxContentAgeMin: IMD_MAX_CONTENT_AGE_MIN,
  afterPublish: markImdActivated,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
