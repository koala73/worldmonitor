#!/usr/bin/env node
// Riksbank SWEA government bond fixings (2Y 5Y 7Y 10Y), daily since
// 1990-01-02. The SWEA API serves per-series date-ranged observations.
// A full-range request per series returns the entire history in one call
// (verified: 36 years / 9198 obs / 329 KB), so no window fan-out is needed —
// SWEA throttles bursts hard (429 with escalating Retry-After) and four
// paced requests stay far under that limit.

import { CHROME_UA, loadEnvFile, runSeed, sleep } from './_seed-utils.mjs';
import { RIKSBANK_SERIES, parseRiksbankObservations } from './lib/yield-curves/riksbank.mjs';
import { collapseCurves, countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const SWEA_BASE = 'https://api.riksbank.se/swea/v1/Observations';
const START_YEAR = 1990;
// SWEA throttles bursts (429 with Retry-After, verified 2026-09-22: a rapid
// fan-out trips a ~32s block and repeats escalate). Four requests with 2s
// pacing plus one Retry-After-honoring retry per series stays under it.
const REQUEST_GAP_MS = 2000;

async function fetchSeriesHistory(seriesId, { retryOn429 = true } = {}) {
  const end = new Date().getUTCFullYear();
  const url = `${SWEA_BASE}/${seriesId}/${START_YEAR}-01-01/${end}-12-31`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429 && retryOn429) {
    const retryAfterMs = Math.min(Number(response.headers.get('retry-after') ?? 35) * 1000, 60_000);
    console.log(`  Riksbank 429 for ${seriesId} — waiting ${retryAfterMs / 1000}s`);
    await sleep(retryAfterMs);
    return fetchSeriesHistory(seriesId, { retryOn429: false });
  }
  if (!response.ok) throw new Error(`Riksbank HTTP ${response.status} for ${seriesId}`);
  return parseRiksbankObservations(seriesId, await response.json());
}

export async function fetchRiksbankCurve() {
  const points = [];
  for (const seriesId of Object.keys(RIKSBANK_SERIES)) {
    const parsed = await fetchSeriesHistory(seriesId);
    if (parsed.length === 0) throw new Error(`Riksbank ${seriesId} parsed no observations`);
    points.push(...parsed);
    console.log(`  Riksbank ${seriesId}: ${parsed.length} observations`);
    await sleep(REQUEST_GAP_MS);
  }
  const curves = collapseCurves(points);
  if (curves.length === 0) throw new Error('Riksbank parsed no observations');
  console.log(`  Riksbank: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-se.mjs')) {
  const extraKeys = [latestExtraKeyEntry('SE')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1990; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('SE', year, year === endYear));
  }
  runSeed('economic', seedResource('SE'), canonicalKey('SE'), fetchRiksbankCurve, {
    validateFn: makeValidate(3000, '1990-01'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'riksbank-swea-json-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('SE'),

    lockTtlMs: 240_000,
    fetchPhaseTimeoutMs: 220_000,  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
