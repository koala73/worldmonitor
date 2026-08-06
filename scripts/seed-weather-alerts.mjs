#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  MAX_ALERTS,
  eligibleAlertCount,
  formatTruncationWarning,
  requireAlertFeatures,
  selectAlerts,
  validateSelectedAlerts,
} from './_weather-alert-select.mjs';

loadEnvFile(import.meta.url);

const NWS_API = 'https://api.weather.gov/alerts/active';
const CANONICAL_KEY = 'weather:alerts:v1';
const CACHE_TTL = 900; // 15 min

async function fetchAlerts() {
  const resp = await fetch(NWS_API, {
    headers: { Accept: 'application/geo+json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`NWS API error: ${resp.status}`);

  const data = await resp.json();
  const features = requireAlertFeatures(data);

  const eligible = eligibleAlertCount(features);
  const alerts = selectAlerts(features, MAX_ALERTS);
  const truncationWarning = formatTruncationWarning(eligible, alerts.length);
  if (truncationWarning) console.warn(truncationWarning);

  return { alerts };
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

runSeed('weather', 'alerts', CANONICAL_KEY, fetchAlerts, {
  validateFn: validateSelectedAlerts,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'nws-active',

  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
