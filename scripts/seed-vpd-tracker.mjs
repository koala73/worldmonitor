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
 * Extract a JSON array from an `eval("var res = [...]")` block in the bundle.
 *
 * Bundle format (post-2026-04 webpack rebuild — verified against the live
 * 7.5MB index_bundle.js on 2026-05-01):
 *
 *   eval("var res = [{\"Alert_ID\":\"8731706\",\"lat\":\"56.85\",...}, ...]")
 *   eval("var res = [{\"country\":\"Afghanistan\",\"iso\":\"AF\",...}, ...]")
 *
 * The bundle has exactly TWO such blocks: one whose first object key is
 * `Alert_ID` (realtime alerts), one whose first key is `country` (historical
 * WHO annual counts). The wrapping is a JS string literal — properties are
 * JSON-quoted with backslash-escaped quotes.
 *
 * Pre-2026-04 the bundle used `var a=[{Alert_ID:"...",...}]` (unquoted keys,
 * named array, separate `.columns` metadata) and the parser anchored on
 * `.columns=["Alert_ID"`, `var a=[`, and `[{country:"`. All three anchors
 * are dead in the current bundle. This rewrite anchors on the FIELD NAMES
 * (`Alert_ID`, `country`) which are domain-stable — they only change if
 * Think Global Health renames the data schema itself, not when their
 * bundler is upgraded.
 *
 * @param {string} bundle  raw JS bundle text
 * @param {string} marker  first field name of the target dataset (e.g. 'Alert_ID', 'country')
 * @returns {Array<object>} parsed JSON array
 */
function extractEvalResArray(bundle, marker) {
  const evalNeedle = `eval("var res = [{\\"${marker}\\"`;
  const start = bundle.indexOf(evalNeedle);
  if (start === -1) {
    throw new Error(`[VPD] eval-block anchor for marker '${marker}' not found in bundle (upstream format drift?)`);
  }

  // The opening `[` of the array sits right after `eval("var res = `.
  // The eval block itself wraps the ENTIRE compiled module (millions of
  // bytes — d3 helpers, DOM code, etc.) so we cannot anchor on its closing
  // `]")`. Instead bracket-match within the JS-escaped form to find the
  // closing `]` of the array specifically. Treat `\"...\"` JSON-string
  // segments as opaque so brackets inside data values don't shift depth.
  const arrayOpen = start + 'eval("var res = '.length;
  if (bundle[arrayOpen] !== '[') {
    throw new Error(`[VPD] expected '[' at start of '${marker}' array, got '${bundle[arrayOpen]}'`);
  }

  let depth = 0;
  let inJsonString = false;
  let arrayClose = -1;
  for (let i = arrayOpen; i < bundle.length; i++) {
    const ch = bundle[i];
    if (ch === '\\') {
      // JS-string-literal escape sequence. Inspect next char.
      const next = bundle[i + 1];
      if (next === '"') {
        // \"  ── toggles JSON-string boundary in the eval'd source
        inJsonString = !inJsonString;
        i++; // skip the "
        continue;
      }
      if (next === 'u') {
        i += 5; // \uXXXX → skip the 5 hex/digit chars after \
        continue;
      }
      // \\, \n, \t, \/, \b, \f, \r — skip the next char wholesale
      i++;
      continue;
    }
    if (inJsonString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { arrayClose = i; break; }
    }
  }

  if (arrayClose === -1) {
    throw new Error(`[VPD] array did not close for '${marker}' (bracket-match exhausted bundle)`);
  }

  // bundle[arrayOpen..arrayClose] is the JS-escaped JSON array literal.
  // JSON.parse('"' + escaped + '"') unescapes the JS-string-literal
  // wrapping; JSON.parse on the result yields the data.
  const escapedArray = bundle.slice(arrayOpen, arrayClose + 1);
  const arrayJson = JSON.parse(`"${escapedArray}"`);
  return JSON.parse(arrayJson);
}

export function parseRealtimeAlerts(bundle) {
  const rows = extractEvalResArray(bundle, 'Alert_ID');
  return rows
    .filter((r) => r.lat && r.lng)
    .map((r) => ({
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

export function parseHistoricalData(bundle) {
  const rows = extractEvalResArray(bundle, 'country');
  return rows.map((r) => ({
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

// Standalone-only entrypoint guard. Without this, importing the file from
// tests (e.g. to test parseRealtimeAlerts / parseHistoricalData) kicks off
// the full runSeed pipeline at module-load time — Redis lock acquisition,
// external bundle fetch, Redis writes — which hangs the test runner.
if (process.argv[1]?.endsWith('seed-vpd-tracker.mjs')) {
  runSeed('health', 'vpd-tracker', CANONICAL_KEY, fetchVpdTracker, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'tgh-bundle-v2',
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
}
