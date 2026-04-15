#!/usr/bin/env node

/**
 * Seed: Think Global Health Vaccine-Preventable Disease Tracker
 *
 * Source: https://thinkglobalhealth.github.io/disease_tracker
 * Both datasets are embedded in index_bundle.js (updated ~weekly by CFR staff).
 * No API key required — the bundle is public GitHub Pages.
 *
 * Writes two Redis keys:
 *   health:vpd-tracker:realtime:v1   — geo-located outbreak alerts (lat/lng, cases, source URL)
 *   health:vpd-tracker:historical:v1 — WHO annual case counts by country/disease/year
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'health:vpd-tracker:realtime:v1';
const HISTORICAL_KEY = 'health:vpd-tracker:historical:v1';
const BUNDLE_URL = 'https://thinkglobalhealth.github.io/disease_tracker/index_bundle.js';
const CACHE_TTL = 259200; // 72h (3 days) — 3× daily cron interval per gold standard; survives 2 consecutive missed runs

/**
 * Parse realtime outbreak alerts from the embedded object array.
 *
 * Bundle format (webpack CommonJS):
 *   var a=[{Alert_ID:"8731706",lat:"56.85",lng:"24.92",diseases:"Measles",...},
 *          ...
 *          {Alert_ID:"8707570",...}];
 *   a.columns=["Alert_ID","lat","lng","diseases","place_name","country","date","cases","link","Type","summary"]
 *
 * The .columns metadata property marks the end of the array.
 */
function parseRealtimeAlerts(bundle) {
  const colIdx = bundle.indexOf('.columns=["Alert_ID"');
  if (colIdx === -1) throw new Error('[VPD] Realtime data columns marker not found in bundle');

  const arrayEnd = bundle.lastIndexOf('}]', colIdx);
  const arrayStart = bundle.lastIndexOf('var a=[', arrayEnd);
  if (arrayStart === -1) throw new Error('[VPD] Realtime data array start not found');

  const rawArray = bundle.slice(arrayStart + 6, arrayEnd + 2); // skip 'var a='
  // eslint-disable-next-line no-new-func
  const rows = Function('"use strict"; return ' + rawArray)();

  return rows
    .filter(r => r.lat && r.lng)
    .map(r => ({
      alertId: r.Alert_ID,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      disease: r.diseases,
      placeName: r.place_name,
      country: r.country,
      date: r.date,
      cases: r.cases ? parseInt(String(r.cases).replace(/,/g, ''), 10) || 0 : null,
      sourceUrl: r.link,
      summary: r.summary,
    }));
}

/**
 * Parse historical WHO annual case counts from the embedded JS object array.
 *
 * Bundle format (second dataset, follows immediately after realtime module):
 *   [{"country":"Afghanistan","iso":"AF","disease":"Diphtheria","year":"2024","cases":"207"}, ...]
 */
function parseHistoricalData(bundle) {
  const colIdx = bundle.indexOf('.columns=["Alert_ID"');
  if (colIdx === -1) throw new Error('[VPD] Bundle anchor not found for historical data search');

  const arrayStart = bundle.indexOf('[{country:"', colIdx);
  if (arrayStart === -1) throw new Error('[VPD] Historical data array not found');
  const arrayEnd = bundle.indexOf('];', arrayStart);
  if (arrayEnd === -1) throw new Error('[VPD] Historical data end marker not found');

  const rawArray = bundle.slice(arrayStart, arrayEnd + 1);
  // eslint-disable-next-line no-new-func
  const rows = Function('"use strict"; return ' + rawArray)();

  return rows.map(r => ({
    country: r.country,
    iso: r.iso,
    disease: r.disease,
    year: parseInt(r.year, 10),
    cases: parseInt(r.cases, 10) || 0,
  }));
}

async function fetchVpdTracker() {
  const resp = await fetch(BUNDLE_URL, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`[VPD] Bundle fetch failed: HTTP ${resp.status}`);
  const bundle = await resp.text();

  const alerts = parseRealtimeAlerts(bundle);
  const historical = parseHistoricalData(bundle);

  console.log(`[VPD] Realtime alerts: ${alerts.length} | Historical records: ${historical.length}`);

  return { alerts, historical, fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.alerts) && data.alerts.length >= 10
    && Array.isArray(data?.historical) && data.historical.length >= 100;
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

runSeed('health', 'vpd-tracker', CANONICAL_KEY, fetchVpdTracker, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'tgh-bundle-v1',
  extraKeys: [
    {
      key: HISTORICAL_KEY,
      ttl: CACHE_TTL,
      transform: data => ({ records: data.historical, fetchedAt: data.fetchedAt }),
    },
  ],

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 2880,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
