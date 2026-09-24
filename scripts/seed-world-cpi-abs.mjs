#!/usr/bin/env node
// Australia national CPI overlay (ABS SDMX 2.1).
//
// Australia publishes CPI quarterly; the IMF and OECD copies are also
// quarterly. This overlay keeps the official ABS series as the fallback of
// record for AU, and its presence is what lets the read path label AU as
// quarterly instead of pretending a monthly indicator exists.
//
// Live measurements (2026-09-23):
//   dataflow ABS:CPI, key 1.10001.10.50.Q = All groups CPI, Australia, index
//   1948-Q3 .. 2026-Q2, base 2025=100 (BASE_PERIOD code 25)
//   Cross-checks against IMF AUS.CPI._T.IX.Q: 2026-Q2 = 102.31 in both.
//
// `data.api.abs.gov.au` only serves the legacy `/rest/...` routes (the newer
// `/data/...` path returns 403 from CloudFront), and the host does not resolve
// for every resolver, so a failed fetch is a graceful last-good skip.

import { CHROME_UA, loadEnvFile, runSeed, withRetry } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CPI_MAX_CONTENT_AGE_MIN,
  CPI_QUARTERLY_WINDOW,
  QUARTERLY_CHANGE_LAG,
  buildNational,
  cpiContentMeta,
  countCpiPoints,
  latestCpiWindow,
  parseSdmxCsv,
} from './_world-cpi-shared.mjs';

loadEnvFile(import.meta.url);

export const ABS_CPI_KEY = 'economic:world-cpi:abs:v1';
export const ABS_CPI_LATEST_KEY = 'economic:world-cpi:abs:latest:v1';
export const ABS_CPI_ACTIVATION_KEY = 'seed-activated:economic:world-cpi-abs';

const ABS_BASE = 'https://data.api.abs.gov.au/rest/data/CPI';
// Measure 1 = index, INDEX 10001 = All groups CPI, TSEST 10 = original,
// REGION 50 = Australia, Q = quarterly.
const ABS_CPI_KEY_SPEC = '1.10001.10.50.Q';
const SDMX_CSV_ACCEPT = 'application/vnd.sdmx.data+csv;version=2.0.0';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FETCH_TIMEOUT_MS = 90_000;

// BASE_PERIOD code 25 is `2025 = 100.0` in CL_BASE_PERIOD(2.0.0). Older
// observations in the same response carry the same code, so the base label is
// stable for the whole series.
export const ABS_INDEX_BASE = '2025=100';

/**
 * Parse ABS CPI rows into `{ AU: [{ date, value }] }`.
 * The frame is `MEASURE.INDEX.TSEST.REGION.FREQ`, so MEASURE/INDEX are pinned
 * by the request key rather than re-checked here.
 */
export function parseAbsCpiRows(rows) {
  const points = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = Number(row?.OBS_VALUE);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (String(row?.FREQ ?? '').toUpperCase() !== 'Q') continue;
    points.push({ date: String(row?.TIME_PERIOD ?? ''), value });
  }
  return points.length > 0 ? { AU: points } : {};
}

async function fetchAbsCpi() {
  const url = `${ABS_BASE}/${ABS_CPI_KEY_SPEC}`;
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: SDMX_CSV_ACCEPT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`ABS CPI: HTTP ${resp.status}`);
      if (resp.status === 400 || resp.status === 404 || resp.status === 406) err.nonRetryable = true;
      throw err;
    }
    const text = await resp.text();
    const byCountry = parseAbsCpiRows(parseSdmxCsv(text));
    const data = buildNational(byCountry, { AU: ABS_INDEX_BASE });
    console.log(`  ABS CPI: ${data.countries.AU?.points?.length ?? 0} quarters for AU`);
    return data;
  }, 2, 2000);
}

export function validate(data) {
  return (data?.countries?.AU?.points?.length ?? 0) >= CPI_QUARTERLY_WINDOW / 2;
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', ABS_CPI_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: world-cpi ABS activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-world-cpi-abs.mjs')) {
  runSeed('economic', 'world-cpi-abs', ABS_CPI_KEY, fetchAbsCpi, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    sourceVersion: 'abs-cpi-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta: cpiContentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN['abs-cpi'],
    extraKeys: [
      {
        key: ABS_CPI_LATEST_KEY,
        transform: (data) => latestCpiWindow(data, QUARTERLY_CHANGE_LAG),
        declareRecords: countCpiPoints,
      },
    ],
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
