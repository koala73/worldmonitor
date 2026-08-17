#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  ECCC_MAX_BYTES,
  NWS_ALERTS_URL,
  NWS_HOST,
  WEATHER_ALERTS_SOURCE_VERSION,
  fetchApprovedWeatherJson,
  fetchEcccAlertFeatures,
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
  const [nwsFeatures, ecccResult] = await Promise.all([
    fetchSourceFeatures(NWS_ALERTS_URL, [NWS_HOST], 'NWS'),
    fetchEcccAlertFeatures({
      userAgent: CHROME_UA,
      maxBytes: ECCC_MAX_BYTES,
    }).catch((err) => {
      console.warn(`weather-alerts: ECCC fetch failed: ${err.message || err}`);
      return null;
    }),
  ]);

  if (nwsFeatures == null && ecccResult == null) {
    throw new Error('NWS and ECCC weather alert fetches both failed');
  }

  const nwsAlerts = nwsFeatures ? rankEligibleAlerts(nwsFeatures) : [];
  const ecccAlerts = ecccResult ? selectEcccAlerts(ecccResult.features) : [];
  const alerts = mergeAlertSources({ nws: nwsAlerts, eccc: ecccAlerts });
  const truncationWarning = formatTruncationWarning(nwsAlerts.length + ecccAlerts.length, alerts.length);
  if (truncationWarning) console.warn(truncationWarning);

  // A partial ECCC fetch still publishes — dropping the statuses that DID answer
  // would trade a silent gap for a bigger one. But it must not read healthy:
  // sourceState 'degraded' classifies as SEED_ERROR, so a national alert set
  // missing its `continued` half is visible instead of indistinguishable from a
  // quiet day. Whole-source loss is already reported by the warnings above.
  const degraded = [];
  if (ecccResult?.partial) {
    degraded.push(`eccc-partial:${ecccResult.failedStatuses.join('+')}`);
    console.warn(
      `weather-alerts: ECCC PARTIAL — status ${ecccResult.failedStatuses.join(', ')} failed `
      + `(${ecccResult.failureDetail}); published set is missing those alerts`,
    );
  }
  if (nwsFeatures == null) degraded.push('nws-unavailable');
  if (ecccResult == null) degraded.push('eccc-unavailable');

  return degraded.length
    ? { alerts, sourceState: 'degraded', errorCode: 'WEATHER_ALERT_SOURCE_INCOMPLETE', skipReason: degraded.join(',') }
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
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
