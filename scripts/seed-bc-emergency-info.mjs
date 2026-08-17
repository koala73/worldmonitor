#!/usr/bin/env node
// B.C. Evacuation Orders and Alerts member of seed-bundle-canada (#6659).

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  BC_ALERTS_MAX_CONTENT_AGE_MIN,
  bcAlertsContentMeta,
  declareBcAlertRecords,
  fetchBcEmergencyInfoAlerts,
  validateBcAlertsEnvelope,
} from './lib/bc-emergency-info.mjs';
import {
  CANADA_ALERT_SOURCES,
  rebuildCanadaAlertsUnion,
} from './lib/canada-alerts-union.mjs';

loadEnvFile(import.meta.url);

const SOURCE = CANADA_ALERT_SOURCES.find((entry) => entry.province === 'BC');
const CACHE_TTL = 5_400;

runSeed('alerts', 'bc-emergency-info', SOURCE.key, () => (
  fetchBcEmergencyInfoAlerts({ userAgent: CHROME_UA })
), {
  validateFn: validateBcAlertsEnvelope,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'bc-evacuation-orders-alerts-v1',
  declareRecords: declareBcAlertRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  contentMeta: bcAlertsContentMeta,
  maxContentAgeMin: BC_ALERTS_MAX_CONTENT_AGE_MIN,
  afterPublish: async (data) => {
    await rebuildCanadaAlertsUnion({
      currentSource: { province: 'BC', snapshot: data },
    });
    return { freshnessMetaPatch: { sourceState: 'ok' } };
  },
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
