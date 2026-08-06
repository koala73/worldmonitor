#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { MAX_ALERTS, eligibleAlertCount, selectAlerts } from './_weather-alert-select.mjs';

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
  const features = data.features || [];

  const eligible = eligibleAlertCount(features);
  const alerts = selectAlerts(features, MAX_ALERTS);
  if (eligible > alerts.length) {
    console.warn(`weather-alerts: kept ${alerts.length}/${eligible} by severity rank (${eligible - alerts.length} dropped)`);
  }

  return { alerts };
}

function validate(data) {
  return Array.isArray(data?.alerts) && data.alerts.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

runSeed('weather', 'alerts', CANONICAL_KEY, fetchAlerts, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'nws-active',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
