#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import {
  ECCC_MAX_BYTES,
  NWS_ALERTS_URL,
  NWS_HOST,
  SWIC_MAX_BYTES,
  WEATHER_ALERTS_SOURCE_VERSION,
  carryFailedWeatherAlertSources,
  fetchApprovedWeatherJson,
  fetchEcccAlertFeatures,
  fetchSwicAlertCatalog,
  formatTruncationWarning,
  mergeAlertSources,
  rankEligibleAlerts,
  requireAlertFeatures,
  selectEcccAlerts,
  selectSwicAlerts,
  validateSelectedAlerts,
  weatherAlertsAfterPublish,
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
  const [nwsFeatures, ecccResult, swicResult] = await Promise.all([
    fetchSourceFeatures(NWS_ALERTS_URL, [NWS_HOST], 'NWS'),
    fetchEcccAlertFeatures({
      userAgent: CHROME_UA,
      maxBytes: ECCC_MAX_BYTES,
    }).catch((err) => {
      console.warn(`weather-alerts: ECCC fetch failed: ${err.message || err}`);
      return null;
    }),
    fetchSwicAlertCatalog({
      userAgent: CHROME_UA,
      maxBytes: SWIC_MAX_BYTES,
    }).catch((err) => {
      console.warn(`weather-alerts: SWIC fetch failed: ${err.message || err}`);
      return null;
    }),
  ]);

  if (nwsFeatures == null && ecccResult == null && swicResult == null) {
    throw new Error('NWS, ECCC, and SWIC weather alert fetches all failed');
  }

  const degraded = [];
  const failedSources = [];
  if (ecccResult?.partial) {
    degraded.push(`eccc-partial:${ecccResult.failedStatuses.join('+')}`);
    failedSources.push('eccc');
    console.warn(
      `weather-alerts: ECCC PARTIAL — status ${ecccResult.failedStatuses.join(', ')} failed `
      + `(${ecccResult.failureDetail}); carrying the previous complete ECCC slice`,
    );
  }
  if (nwsFeatures == null) {
    degraded.push('nws-unavailable');
    failedSources.push('nws');
  }
  if (ecccResult == null) {
    degraded.push('eccc-unavailable');
    failedSources.push('eccc');
  }
  if (swicResult == null) {
    degraded.push('swic-unavailable');
    failedSources.push('swic');
  }

  let previousAlerts = [];
  if (failedSources.length > 0) {
    try {
      const previous = await readCanonicalValue(CANONICAL_KEY);
      previousAlerts = Array.isArray(previous?.alerts) ? previous.alerts : [];
    } catch (err) {
      console.warn(`weather-alerts: last-good read failed: ${err.message || err}`);
    }
  }
  const carried = carryFailedWeatherAlertSources(previousAlerts, failedSources);
  const nwsAlerts = failedSources.includes('nws') ? carried.nws : rankEligibleAlerts(nwsFeatures);
  const ecccAlerts = failedSources.includes('eccc') ? carried.eccc : selectEcccAlerts(ecccResult.features);
  const swicAlerts = failedSources.includes('swic')
    ? carried.swic
    : selectSwicAlerts(swicResult.items, swicResult.membersByMid);
  const alerts = mergeAlertSources({ nws: nwsAlerts, eccc: ecccAlerts, swic: swicAlerts });
  const truncationWarning = formatTruncationWarning(
    nwsAlerts.length + ecccAlerts.length + swicAlerts.length,
    alerts.length,
  );
  if (truncationWarning) console.warn(truncationWarning);

  return degraded.length
    ? {
        alerts,
        sourceState: 'degraded',
        errorCode: 'WEATHER_ALERT_SOURCE_INCOMPLETE',
        failedSources,
        skipReason: degraded.join(','),
      }
    : { alerts };
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
  afterPublish: weatherAlertsAfterPublish,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
