#!/usr/bin/env node
// Worldwide national CPI (+ Eurostat-harmonised HICP) from the IMF STA CPI
// dataflow (SDMX 3.0).
//
// This is the default worldwide source: one SDMX series per ISO-3, no API key
// required today, monthly where the country publishes it and quarterly
// otherwise. It is NOT the WEO seed (seed-imf-macro.mjs) — WEO is an
// April/October annual vintage; this is the monthly statistical series.
//
// The same request carries both INDEX_TYPE series:
//   CPI   national CPI, 187 countries monthly (196 with any frequency)
//   HICP  Eurostat-harmonised index for 32 European countries
// Storing both lets the read path prefer the comparable Europe basket without
// a second fetch, and covers the case where Eurostat's dissemination API lags
// (observed at 9 months on 2026-09-23 while this feed was current to 2026-08).
//
// Live measurements (2026-09-23):
//   all 239 ISO-3 codes, CPI+HICP, M (120 obs) + Q (40 obs) -> ~3.4 MB CSV, ~7 s
//
// `startPeriod` is IGNORED by this endpoint and a bare `*` country returns 403.
// Windows are expressed as `lastNObservations`, and countries are requested as
// an explicit `+`-joined list.

import {
  CHROME_UA,
  PERMANENT_4XX_STATUSES,
  imfAuthHeaders,
  loadEnvFile,
  loadSharedConfig,
  parseRetryAfterMs,
  runSeed,
  withRetry,
} from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CPI_MAX_CONTENT_AGE_MIN,
  CPI_MONTHLY_WINDOW,
  CPI_QUARTERLY_WINDOW,
  MONTHLY_CHANGE_LAG,
  buildNational,
  buildHarmonised,
  cpiContentMeta,
  countCpiPoints,
  latestCpiWindow,
  parseSdmxCsv,
} from './_world-cpi-shared.mjs';

loadEnvFile(import.meta.url);

export const IMF_CPI_KEY = 'economic:world-cpi:imf:v1';
export const IMF_CPI_LATEST_KEY = 'economic:world-cpi:imf:latest:v1';
export const IMF_CPI_ACTIVATION_KEY = 'seed-activated:economic:world-cpi-imf';

const IMF_SDMX_BASE = 'https://api.imf.org/external/sdmx/3.0';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Fetch one frequency's CSV for every ISO-3 in `iso3Codes`. The `INDEX_TYPE`
 * dimension is an OR list so both series arrive in one response.
 *
 * A permanent 4xx is tagged non-retryable so withRetry exits immediately
 * instead of burning the fetch deadline — IMF enforces subscription keys
 * intermittently (see imfAuthHeaders), and a 401/403 must surface as a failed
 * section rather than a SIGTERM.
 */
async function fetchFrequency(iso3Codes, frequency, observations) {
  const url = `${IMF_SDMX_BASE}/data/dataflow/IMF.STA/CPI/+/${iso3Codes.join('+')}`
    + `.CPI+HICP._T.IX.${frequency}?lastNObservations=${observations}`;
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv', ...imfAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`IMF SDMX CPI ${frequency}: HTTP ${resp.status}`);
      if (PERMANENT_4XX_STATUSES.has(resp.status)) err.nonRetryable = true;
      if (resp.status === 429 || resp.status === 503) {
        err.retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      }
      throw err;
    }
    return resp.text();
  }, 2, 2000);
}

/**
 * Split parsed SDMX rows into the national and harmonised maps, keyed by ISO-2.
 * Rows for aggregates (`WLD`, `EUU`, …) have no ISO-2 mapping and are dropped.
 * The index base comes from `COMMON_REFERENCE_PERIOD` (e.g. `2020A`).
 */
export function splitImfCpiRows(rows, iso3ToIso2) {
  const national = {};
  const harmonised = {};
  const indexBases = { CPI: { M: {}, Q: {} }, HICP: { M: {}, Q: {} } };
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso2 = iso3ToIso2.get(row?.COUNTRY);
    const value = Number(row?.OBS_VALUE);
    if (!iso2 || !Number.isFinite(value) || value <= 0) continue;
    const frequency = String(row?.FREQUENCY ?? '').toUpperCase();
    if (frequency !== 'M' && frequency !== 'Q') continue;
    const indexType = String(row?.INDEX_TYPE ?? '').toUpperCase();
    const target = indexType === 'HICP' ? harmonised : indexType === 'CPI' ? national : null;
    if (!target) continue;
    const base = String(row?.COMMON_REFERENCE_PERIOD ?? '').trim();
    if (/^\d{4}A$/.test(base)) indexBases[indexType][frequency][iso2] = `${base.slice(0, 4)}=100`;
    (target[iso2] ??= []).push({ date: String(row?.TIME_PERIOD ?? ''), value });
  }
  return { national, harmonised, indexBases };
}

function mergePoints(left, right) {
  const merged = {};
  for (const iso2 of new Set([...Object.keys(left), ...Object.keys(right)])) {
    merged[iso2] = [...(left[iso2] ?? []), ...(right[iso2] ?? [])];
  }
  return merged;
}

/** Keep each base label with the index type and frequency selected for its points. */
export function buildImfCpiPayload(monthly, quarterly) {
  const data = {
    ...buildNational(mergePoints(monthly.national, quarterly.national)),
    ...buildHarmonised(mergePoints(monthly.harmonised, quarterly.harmonised)),
  };
  for (const [field, indexType] of [['countries', 'CPI'], ['harmonised', 'HICP']]) {
    for (const [iso2, series] of Object.entries(data[field])) {
      const source = series.frequency === 'Q' ? quarterly : monthly;
      const base = source.indexBases[indexType][series.frequency][iso2];
      if (base) series.indexBase = base;
    }
  }
  return data;
}

async function fetchWorldCpiImf() {
  const iso3ToIso2 = new Map(Object.entries(loadSharedConfig('iso3-to-iso2.json')));
  const iso3Codes = [...iso3ToIso2.keys()].sort();

  const monthlyText = await fetchFrequency(iso3Codes, 'M', CPI_MONTHLY_WINDOW);
  const quarterlyText = await fetchFrequency(iso3Codes, 'Q', CPI_QUARTERLY_WINDOW);

  const monthly = splitImfCpiRows(parseSdmxCsv(monthlyText), iso3ToIso2);
  const quarterly = splitImfCpiRows(parseSdmxCsv(quarterlyText), iso3ToIso2);

  const data = buildImfCpiPayload(monthly, quarterly);

  const countries = Object.values(data.countries);
  const monthlyCount = countries.filter((entry) => entry.frequency === 'M').length;
  console.log(
    `  IMF CPI: ${countries.length} countries (${monthlyCount} monthly), `
    + `${Object.keys(data.harmonised ?? {}).length} HICP series`,
  );
  return data;
}

export function validate(data) {
  const countries = Object.values(data?.countries ?? {});
  if (countries.length < 150) return false;
  return countries.filter((entry) => entry.frequency === 'M').length >= 90;
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', IMF_CPI_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: world-cpi IMF activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-world-cpi-imf.mjs')) {
  runSeed('economic', 'world-cpi-imf', IMF_CPI_KEY, fetchWorldCpiImf, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 240_000,
    fetchPhaseTimeoutMs: 210_000,
    sourceVersion: 'imf-sta-cpi-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta: cpiContentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN['imf-cpi'],
    extraKeys: [
      {
        key: IMF_CPI_LATEST_KEY,
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
