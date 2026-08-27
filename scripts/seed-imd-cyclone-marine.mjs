#!/usr/bin/env node
/**
 * IMD cyclone, port, coastal, and marine seeder (#7005).
 *
 * Planned Railway service for cyclone/port/coastal/marine products only.
 * Does not write the NWS/ECCC/SWIC weather-alerts key. Live fetch stays disabled until
 * WM_IMD_RIGHTS_ACCEPTED=1 and IMD_API_KEY are both set.
 */

import { loadEnvFile, CHROME_UA, readCanonicalValue, runSeed } from './_seed-utils.mjs';
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

const CACHE_TTL = 5400;

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
  afterPublish: imdAfterPublish,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
