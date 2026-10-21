#!/usr/bin/env node
// Japan national CPI overlay (e-Stat official statistics API).
//
// The IMF monthly series carries Japan, but the national print is the release
// authority and is published ~3 weeks after month end. This overlay keeps the
// official 2020-base series for the read path to prefer over the IMF copy.
//
// Requires ESTAT_APPID (registered application ID). Live measurements
// (2026-09-23) against statsDataId 0003427113:
//   area 00000 = 全国 (national), cat01 0001 = 総合 (all items), tab 1 = index
//   monthly back to 1970-01, 792 time entries, newest 2026-08
//
// Time codes are `YYYY00MMDD` (e.g. `2026000808` = 2026-08). Fiscal-year
// entries use month `00` and are not CPI observations for this read.

import { CHROME_UA, loadEnvFile, runSeed, withRetry } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CPI_MAX_CONTENT_AGE_MIN,
  CPI_MONTHLY_WINDOW,
  MONTHLY_CHANGE_LAG,
  buildNational,
  cpiContentMeta,
  countCpiPoints,
  latestCpiWindow,
} from './_world-cpi-shared.mjs';

loadEnvFile(import.meta.url);

export const ESTAT_CPI_KEY = 'economic:world-cpi:estat:v1';
export const ESTAT_CPI_LATEST_KEY = 'economic:world-cpi:estat:latest:v1';
export const ESTAT_CPI_ACTIVATION_KEY = 'seed-activated:economic:world-cpi-estat';

// CPI table id (2020-base, monthly). Verified live; a new base year ships as a
// new statsDataId, and a stale id returns STATUS 300 rather than silent zeros.
export const ESTAT_CPI_STATS_DATA_ID = '0003427113';
const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FETCH_TIMEOUT_MS = 90_000;

/**
 * Convert an e-Stat time class code to an ISO month.
 *   '2026000808' -> '2026-08'   (YYYY + '00' + MM + DD)
 *   '2025100000' -> undefined   (fiscal year, month `00`)
 */
export function estatCpiPeriod(code) {
  const match = /^(\d{4})00(\d{2})\d{2}$/.exec(String(code ?? ''));
  if (!match) return undefined;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return `${match[1]}-${String(month).padStart(2, '0')}`;
}

/**
 * Extract the national all-items index series from a getStatsData response.
 * Returns `{ JP: [{ date, value }] }`, or an empty object when the payload
 * carries no usable observation.
 */
export function parseEstatCpi(payload) {
  const values = payload?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE;
  const points = [];
  for (const row of Array.isArray(values) ? values : []) {
    const date = estatCpiPeriod(row?.['@time']);
    const value = Number(row?.$);
    if (!date || !Number.isFinite(value) || value <= 0) continue;
    points.push({ date, value });
  }
  return points.length > 0 ? { JP: points } : {};
}

function requireEstatKey() {
  const key = process.env.ESTAT_APPID;
  if (!key) throw new Error('Missing ESTAT_APPID');
  return key;
}

async function fetchEstatCpi() {
  const params = new URLSearchParams({
    statsDataId: ESTAT_CPI_STATS_DATA_ID,
    cdArea: '00000',
    cdCat01: '0001',
    cdTab: '1',
    limit: '100000',
    appId: requireEstatKey(),
  });
  const url = `${ESTAT_BASE}?${params}`;

  const payload = await withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`e-Stat CPI: HTTP ${resp.status}`);
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) err.nonRetryable = true;
      throw err;
    }
    return resp.json();
  }, 2, 2000);

  const status = payload?.GET_STATS_DATA?.RESULT?.STATUS;
  if (status !== 0) {
    const message = payload?.GET_STATS_DATA?.RESULT?.ERROR_MSG || 'unknown';
    throw new Error(`e-Stat CPI: STATUS ${status} — ${message}`);
  }

  const byCountry = parseEstatCpi(payload);
  const data = buildNational(byCountry, { JP: '2020=100' });
  console.log(`  e-Stat CPI: ${data.countries.JP?.points?.length ?? 0} months for JP`);
  return data;
}

export function validate(data) {
  return (data?.countries?.JP?.points?.length ?? 0) >= CPI_MONTHLY_WINDOW / 2;
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', ESTAT_CPI_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: world-cpi e-Stat activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-world-cpi-estat.mjs')) {
  runSeed('economic', 'world-cpi-estat', ESTAT_CPI_KEY, fetchEstatCpi, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    sourceVersion: 'estat-cpi-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta: cpiContentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN['estat-cpi'],
    extraKeys: [
      {
        key: ESTAT_CPI_LATEST_KEY,
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
