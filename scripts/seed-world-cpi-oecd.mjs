#!/usr/bin/env node
// OECD national CPI overlay for the worldwide CPI read.
//
// The OECD SDMX feed frames CPI identically to Eurostat's HICP (COICOP all
// items, index level, monthly except AU/NZ which are quarterly). It is used as
// a gap-fill behind the IMF world feed: the IMF monthly series is the default
// and OECD supplies countries or periods the IMF print lacks.
//
// Live measurements (2026-09-23):
//   105 ISO-3 codes, M+Q, lastNObservations 120/40 -> ~2.2 MB CSV
//   46 countries with data; JPN/MEX/ZAF/TUR monthly is stale or absent
//
// The Accept header MUST be the versioned SDMX CSV media type; the default
// negotiation returns 406.

import {
  CHROME_UA,
  loadEnvFile,
  loadSharedConfig,
  runSeed,
  sleep,
  withRetry,
} from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CPI_MAX_CONTENT_AGE_MIN,
  CPI_MONTHLY_WINDOW,
  CPI_QUARTERLY_WINDOW,
  MONTHLY_CHANGE_LAG,
  buildNational,
  cpiContentMeta,
  countCpiPoints,
  latestCpiWindow,
  parseSdmxCsv,
} from './_world-cpi-shared.mjs';

loadEnvFile(import.meta.url);

export const OECD_CPI_KEY = 'economic:world-cpi:oecd:v1';
export const OECD_CPI_LATEST_KEY = 'economic:world-cpi:oecd:latest:v1';
export const OECD_CPI_ACTIVATION_KEY = 'seed-activated:economic:world-cpi-oecd';

const OECD_BASE = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL';
const SDMX_CSV_ACCEPT = 'application/vnd.sdmx.data+csv;version=2.0.0';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FETCH_TIMEOUT_MS = 120_000;
const OECD_REQUEST_STAGGER_MS = 15_000;

// OECD members plus key partners. The list is explicit because the `all`
// wildcard returns 404 on this dataflow and an unrequested country costs a
// round trip with no output. ISO-3 codes match the shared mapping.
export const OECD_CPI_COUNTRIES = [
  'AUS', 'AUT', 'BEL', 'BGR', 'BRA', 'CAN', 'CHE', 'CHL', 'CHN', 'COL',
  'CRI', 'CZE', 'DEU', 'DNK', 'ESP', 'EST', 'FIN', 'FRA', 'GBR', 'GRC',
  'HRV', 'HUN', 'IDN', 'IND', 'IRL', 'ISL', 'ISR', 'ITA', 'JPN', 'KOR',
  'LTU', 'LUX', 'LVA', 'MEX', 'NLD', 'NOR', 'NZL', 'PER', 'PHL', 'POL',
  'PRT', 'ROU', 'SAU', 'SVK', 'SVN', 'SWE', 'TUR', 'USA', 'ZAF',
];

/**
 * Fetch one frequency for every OECD code. `lastNObservations` is not honoured
 * uniformly by this service, so the caller trims to the window.
 *
 * The public SDMX endpoint throttles and intermittently answers 500/429 in
 * bursts (observed live 2026-09-23: bursts of HTTP 500 across identical
 * requests, then 429s under rapid retries), so this waits on the upstream
 * Retry-After hint and backs off harder than the shared default.
 */
async function fetchFrequency(iso3Codes, frequency, observations) {
  const url = `${OECD_BASE}/${iso3Codes.join('+')}.${frequency}.N.CPI.IX._T.N._Z`
    + `?lastNObservations=${observations}`;
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: SDMX_CSV_ACCEPT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`OECD CPI ${frequency}: HTTP ${resp.status}`);
      if (resp.status === 400 || resp.status === 404 || resp.status === 406) err.nonRetryable = true;
      const retryAfter = Number(resp.headers?.get?.('retry-after'));
      if (resp.status === 429 || resp.status === 503) {
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      }
      throw err;
    }
    return resp.text();
  }, 2, 20_000);
}

/**
 * Parse OECD rows into `{ ISO2: [{ date, value }] }` plus index bases.
 * The frame is `REF_AREA.FREQ.N.CPI.IX._T.N._Z`, so `BASE_PER` carries the
 * reference year (e.g. `2015`).
 */
export function parseOecdCpiRows(rows, iso3ToIso2) {
  const byCountry = {};
  const indexBases = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso2 = iso3ToIso2.get(row?.REF_AREA);
    const value = Number(row?.OBS_VALUE);
    if (!iso2 || !Number.isFinite(value) || value <= 0) continue;
    const frequency = String(row?.FREQ ?? '').toUpperCase();
    if (frequency !== 'M' && frequency !== 'Q') continue;
    if (String(row?.MEASURE ?? '') !== 'CPI' || String(row?.UNIT_MEASURE ?? '') !== 'IX') continue;
    (byCountry[iso2] ??= []).push({ date: String(row?.TIME_PERIOD ?? ''), value });
    const base = String(row?.BASE_PER ?? '').trim();
    if (/^\d{4}$/.test(base)) indexBases[iso2] = `${base}=100`;
  }
  return { byCountry, indexBases };
}

async function fetchWorldCpiOecd() {
  const iso3ToIso2 = new Map(Object.entries(loadSharedConfig('iso3-to-iso2.json')));
  // Stagger the two heavy batch pulls: consecutive full-window requests are
  // what trips the endpoint's burst throttle.
  const monthlyText = await fetchFrequency(OECD_CPI_COUNTRIES, 'M', CPI_MONTHLY_WINDOW);
  await sleep(OECD_REQUEST_STAGGER_MS);
  const quarterlyText = await fetchFrequency(OECD_CPI_COUNTRIES, 'Q', CPI_QUARTERLY_WINDOW);
  const monthly = parseOecdCpiRows(parseSdmxCsv(monthlyText), iso3ToIso2);
  const quarterly = parseOecdCpiRows(parseSdmxCsv(quarterlyText), iso3ToIso2);

  const merged = {};
  for (const iso2 of new Set([...Object.keys(monthly.byCountry), ...Object.keys(quarterly.byCountry)])) {
    merged[iso2] = [...(monthly.byCountry[iso2] ?? []), ...(quarterly.byCountry[iso2] ?? [])];
  }
  const data = buildNational(merged, { ...quarterly.indexBases, ...monthly.indexBases });
  console.log(`  OECD CPI: ${Object.keys(data.countries).length}/${OECD_CPI_COUNTRIES.length} countries with data`);
  return data;
}

export function validate(data) {
  return Object.keys(data?.countries ?? {}).length >= 25;
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', OECD_CPI_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: world-cpi OECD activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-world-cpi-oecd.mjs')) {
  runSeed('economic', 'world-cpi-oecd', OECD_CPI_KEY, fetchWorldCpiOecd, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 210_000,
    fetchPhaseTimeoutMs: 180_000,
    sourceVersion: 'oecd-prices-cpi-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta: cpiContentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN['oecd-cpi'],
    extraKeys: [
      {
        key: OECD_CPI_LATEST_KEY,
        transform: (data) => latestCpiWindow(data, MONTHLY_CHANGE_LAG),
        declareRecords: countCpiPoints,
      },
    ],
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
