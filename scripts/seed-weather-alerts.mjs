#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  ECCC_ALERTS_URL,
  ECCC_HOST,
  ECCC_MAX_BYTES,
  NWS_ALERTS_URL,
  NWS_HOST,
  WEATHER_ALERTS_SOURCE_VERSION,
  fetchApprovedWeatherJson,
  formatTruncationWarning,
  mergeAlertSources,
  rankEligibleAlerts,
  requireAlertFeatures,
  selectEcccAlerts,
  validateSelectedAlerts,
} from './_weather-alert-select.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'weather:alerts:v1';
const CACHE_TTL = 900; // 15 min — standalone is planned; live writer is the relay (TTL 5400s)

async function fetchSourceFeatures(url, allowedHosts, label) {
  try {
    const data = await fetchApprovedWeatherJson(url, {
      allowedHosts,
      maxBytes: ECCC_MAX_BYTES,
      userAgent: CHROME_UA,
      accept: 'application/geo+json',
    });
    return requireAlertFeatures(data);
  } catch (err) {
    console.warn(`weather-alerts: ${label} fetch failed: ${err.message || err}`);
    return null;
  }
}

async function fetchAlerts() {
  const [nwsFeatures, ecccFeatures] = await Promise.all([
    fetchSourceFeatures(NWS_ALERTS_URL, [NWS_HOST], 'NWS'),
    fetchSourceFeatures(ECCC_ALERTS_URL, [ECCC_HOST], 'ECCC'),
  ]);

  if (nwsFeatures == null && ecccFeatures == null) {
    throw new Error('NWS and ECCC weather alert fetches both failed');
  }

  const nwsAlerts = nwsFeatures ? rankEligibleAlerts(nwsFeatures) : [];
  const ecccAlerts = ecccFeatures ? selectEcccAlerts(ecccFeatures) : [];
  const alerts = mergeAlertSources({ nws: nwsAlerts, eccc: ecccAlerts });
  const truncationWarning = formatTruncationWarning(nwsAlerts.length + ecccAlerts.length, alerts.length);
  if (truncationWarning) console.warn(truncationWarning);

  return { alerts };
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

runSeed('weather', 'alerts', CANONICAL_KEY, fetchAlerts, {
  validateFn: validateSelectedAlerts,
  ttlSeconds: CACHE_TTL,
  sourceVersion: WEATHER_ALERTS_SOURCE_VERSION,

  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
