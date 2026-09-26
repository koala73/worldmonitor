#!/usr/bin/env node
// Eurostat HICP overlay for worldwide CPI — a sibling of
// seed-eurostat-country-data.mjs rather than an extension of it.
//
// The existing country-tile seeder keeps only the latest two annual-rate
// prints. This seeder carries the long monthly INDEX history (TOTAL basket,
// I15) that the world CPI read needs, so the two never share one payload.
//
// Eurostat moved HICP to ECOICOP ver. 2 in 2026: prc_hicp_midx is frozen at
// 1996-01 .. 2025-12 and prc_hicp_minr continues it, with the basket keyed as
// `coicop18` (TOTAL) instead of `coicop` (CP00).
//
// Live measurements (2026-09-23):
//   all 29 geos in ONE request -> ~161 KB JSON, ~2 s
//   full history 1996-01 .. 2026-08 (368 months), 10,533 observations

import { CHROME_UA, loadEnvFile, runSeed, withRetry } from './_seed-utils.mjs';
import { EUROSTAT_BASE, EU_GEOS } from './_eurostat-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  CPI_MAX_CONTENT_AGE_MIN,
  MONTHLY_CHANGE_LAG,
  buildNational,
  cpiContentMeta,
  countCpiPoints,
  latestCpiWindow,
} from './_world-cpi-shared.mjs';

loadEnvFile(import.meta.url);

export const EUROSTAT_HICP_KEY = 'economic:world-cpi:eurostat:v1';
export const EUROSTAT_HICP_LATEST_KEY = 'economic:world-cpi:eurostat:latest:v1';
export const EUROSTAT_HICP_ACTIVATION_KEY = 'seed-activated:economic:world-cpi-eurostat';

const DATASET = 'prc_hicp_minr';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FETCH_TIMEOUT_MS = 90_000;

/**
 * Parse a multi-geo JSON-stat response into `{ ISO2: [{ date, value }] }`.
 *
 * JSON-stat flattens a dense cube into a sparse `value` object keyed by the
 * flat index. The strides are derived from `id` + `size` so a change in
 * Eurostat's dimension order or a new dimension does not silently mis-attribute
 * values to the wrong country.
 *
 * `geo` labels are Eurostat codes (`EL`, `EA20`, …) and are mapped to ISO-2 by
 * `geoToIso2`; unmapped aggregates are dropped by the caller.
 */
export function parseEurostatHicp(data, geoToIso2) {
  const dims = data?.dimension;
  const values = data?.value;
  const dimOrder = data?.id;
  const dimSizes = data?.size;
  if (!dims || !values || !Array.isArray(dimOrder) || !Array.isArray(dimSizes)) return {};

  const indexOf = (dim) => dims[dim]?.category?.index ?? null;
  const geoIndex = indexOf('geo');
  const timeIndex = indexOf('time');
  if (!geoIndex || !timeIndex) return {};

  const timeLabels = {};
  for (const [label, position] of Object.entries(timeIndex)) timeLabels[position] = label;

  const strides = {};
  let stride = 1;
  for (let i = dimOrder.length - 1; i >= 0; i -= 1) {
    strides[dimOrder[i]] = stride;
    stride *= dimSizes[i];
  }

  const byCountry = {};
  for (const key of Object.keys(values)) {
    const flatIndex = Number(key);
    const rawValue = values[key];
    if (!Number.isFinite(flatIndex) || rawValue === null || rawValue === undefined) continue;
    let remaining = flatIndex;
    const coords = {};
    for (const dim of dimOrder) {
      const dimStride = strides[dim];
      coords[dim] = Math.floor(remaining / dimStride);
      remaining %= dimStride;
    }
    const geoLabel = Object.keys(geoIndex).find((label) => geoIndex[label] === coords.geo);
    const iso2 = geoLabel ? geoToIso2.get(geoLabel) : undefined;
    if (!iso2) continue;
    const period = timeLabels[coords.time];
    if (!period) continue;
    (byCountry[iso2] ??= []).push({ date: period, value: rawValue });
  }
  return byCountry;
}

/**
 * Build the Eurostat geo -> ISO-2 lookup. Eurostat quirks: Greece is `EL`, the
 * euro area is `EA20`, and the EU aggregate is `EU27_2020` (see EU_GEOS).
 * The two aggregates are not countries and are excluded from country rows.
 */
export function eurostatGeoMap() {
  const map = new Map();
  for (const geo of EU_GEOS) {
    if (geo === 'EL') { map.set(geo, 'GR'); continue; }
    if (geo === 'EA20' || geo === 'EU27_2020') continue;
    map.set(geo, geo);
  }
  return map;
}

export function eurostatHicpUrl() {
  const params = new URLSearchParams({
    coicop18: 'TOTAL',
    unit: 'I15',
    format: 'JSON',
    lang: 'EN',
  });
  for (const geo of EU_GEOS) params.append('geo', geo);
  return `${EUROSTAT_BASE}/${DATASET}?${params}`;
}

async function fetchEurostatHicp() {
  const url = eurostatHicpUrl();

  const payload = await withRetry(async () => {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const err = new Error(`Eurostat ${DATASET}: HTTP ${resp.status}`);
      if (resp.status === 400 || resp.status === 404) err.nonRetryable = true;
      throw err;
    }
    return resp.json();
  }, 2, 2000);

  const byCountry = parseEurostatHicp(payload, eurostatGeoMap());
  const data = buildNational(byCountry, Object.fromEntries(
    Object.keys(byCountry).map((iso2) => [iso2, '2015=100']),
  ));
  console.log(`  Eurostat HICP: ${Object.keys(data.countries).length}/${EU_GEOS.length} geos with data`);
  return data;
}

export function validate(data) {
  return Object.keys(data?.countries ?? {}).length >= 20;
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', EUROSTAT_HICP_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: world-cpi Eurostat activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-world-cpi-eurostat.mjs')) {
  runSeed('economic', 'world-cpi-eurostat', EUROSTAT_HICP_KEY, fetchEurostatHicp, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    sourceVersion: 'eurostat-hicp-minr-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta: cpiContentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN['eurostat-hicp'],
    extraKeys: [
      {
        key: EUROSTAT_HICP_LATEST_KEY,
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
