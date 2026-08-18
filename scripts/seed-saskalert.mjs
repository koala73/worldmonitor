#!/usr/bin/env node
// SaskAlert public JSON member of seed-bundle-canada (#6659).

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  SASKALERT_MAX_CONTENT_AGE_MIN,
  declareSaskAlertRecords,
  fetchSaskAlerts,
  saskAlertContentMeta,
  validateSaskAlertEnvelope,
} from './lib/saskalert.mjs';
import {
  CANADA_ALERT_SOURCES,
  rebuildCanadaAlertsUnion,
} from './lib/canada-alerts-union.mjs';

loadEnvFile(import.meta.url);

const SOURCE = CANADA_ALERT_SOURCES.find((entry) => entry.province === 'SK');
const CACHE_TTL = 5_400;

runSeed('alerts', 'saskalert', SOURCE.key, () => (
  fetchSaskAlerts({ userAgent: CHROME_UA })
), {
  validateFn: validateSaskAlertEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'saskalert-v1',
  declareRecords: declareSaskAlertRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  contentMeta: saskAlertContentMeta,
  maxContentAgeMin: SASKALERT_MAX_CONTENT_AGE_MIN,
  afterPublish: async (data) => {
    await rebuildCanadaAlertsUnion({
      currentSource: { province: 'SK', snapshot: data },
    });
    return { freshnessMetaPatch: { sourceState: 'ok' } };
  },
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
