#!/usr/bin/env node
// Daily US policy rate, H.15 Treasury constant-maturity yields, and overnight
// SOFR. FRED republishes the New York Fed and H.15 prints. This is not the
// Treasury par curve.

import { loadEnvFile, fredFetchJson, resolveProxyForConnect, runSeed } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

const proxyAuth = resolveProxyForConnect();

export const RATES_CANONICAL_KEY = 'economic:us-interest-rates:v1';
export const RATES_ACTIVATION_KEY = 'seed-activated:economic:us-interest-rates';
export const RATES_DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030];
export const RATE_SERIES = [
  { id: 'fedFundsEffective', fredId: 'DFF', redisSuffix: 'fed-funds-effective', minPoints: 24000, startsWith: '1954-07-01' },
  { id: 'fedFundsTargetLower', fredId: 'DFEDTARL', redisSuffix: 'fed-funds-target-lower', minPoints: 4000, startsWith: '2008-12-16' },
  { id: 'fedFundsTargetUpper', fredId: 'DFEDTARU', redisSuffix: 'fed-funds-target-upper', minPoints: 4000, startsWith: '2008-12-16' },
  { id: 'treasuryOneMonth', fredId: 'DGS1MO', redisSuffix: 'treasury-one-month', minPoints: 5000, startsWith: '2001-07' },
  { id: 'treasuryThreeMonth', fredId: 'DGS3MO', redisSuffix: 'treasury-three-month', minPoints: 8000, startsWith: '198' },
  { id: 'treasurySixMonth', fredId: 'DGS6MO', redisSuffix: 'treasury-six-month', minPoints: 8000, startsWith: '198' },
  { id: 'treasuryOneYear', fredId: 'DGS1', redisSuffix: 'treasury-one-year', minPoints: 14000, startsWith: '1962-01' },
  { id: 'treasuryTwoYear', fredId: 'DGS2', redisSuffix: 'treasury-two-year', minPoints: 10000, startsWith: '1976-06' },
  { id: 'treasuryFiveYear', fredId: 'DGS5', redisSuffix: 'treasury-five-year', minPoints: 14000, startsWith: '1962-01' },
  { id: 'treasuryTenYear', fredId: 'DGS10', redisSuffix: 'treasury-ten-year', minPoints: 14000, startsWith: '1962-01' },
  { id: 'treasuryThirtyYear', fredId: 'DGS30', redisSuffix: 'treasury-thirty-year', minPoints: 8000, startsWith: '1977-02' },
  { id: 'sofr', fredId: 'SOFR', redisSuffix: 'sofr', minPoints: 1800, startsWith: '2018-04-02' },
];

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const MAX_CONTENT_AGE_MIN = 10 * DAY_MIN;
const OBSERVATION_START = '1954-07-01';

export function fredRateObservations(payload) {
  const observations = Array.isArray(payload?.observations) ? payload.observations : [];
  const byDate = new Map();
  for (const observation of observations) {
    const date = String(observation?.date ?? '').slice(0, 10);
    const value = Number(observation?.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || observation?.value === '.' || !Number.isFinite(value)) continue;
    byDate.set(date, value);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
}

export function rateSeriesDecadeKey(id, decade) {
  const series = RATE_SERIES.find((item) => item.id === id);
  return `${RATES_CANONICAL_KEY}:${series?.redisSuffix ?? id}:${decade}`;
}

export function rateDecadeShard(data, id, decade) {
  const points = (data?.series?.[id] ?? []).filter((point) => point.date.startsWith(String(decade).slice(0, 3)));
  return { points };
}

export function rateSnapshot(data) {
  const snapshot = {};
  for (const series of RATE_SERIES) {
    const point = data?.series?.[series.id]?.at(-1);
    if (point) snapshot[series.id] = point;
  }
  return snapshot;
}

export function countRatePoints(data) {
  if (Array.isArray(data?.points)) return data.points.length;
  if (data?.series) {
    return RATE_SERIES.reduce((sum, series) => sum + (data.series[series.id]?.length ?? 0), 0);
  }
  return RATE_SERIES.filter((series) => data?.[series.id]?.date).length;
}

export function validateRateHistory(data) {
  for (const series of RATE_SERIES) {
    const points = data?.series?.[series.id];
    if (!Array.isArray(points) || points.length < series.minPoints) return false;
    if (!String(points[0]?.date ?? '').startsWith(series.startsWith)) return false;
    if (!Number.isFinite(points.at(-1)?.value)) return false;
  }
  return true;
}

function validateSnapshot(data) {
  return RATE_SERIES.every((series) => (
    typeof data?.[series.id]?.date === 'string' && Number.isFinite(data[series.id].value)
  ));
}

async function fetchSeries(series, apiKey) {
  const params = new URLSearchParams({
    series_id: series.fredId,
    api_key: apiKey,
    file_type: 'json',
    observation_start: OBSERVATION_START,
    sort_order: 'asc',
  });
  const payload = await fredFetchJson(
    `https://api.stlouisfed.org/fred/series/observations?${params}`,
    proxyAuth,
  );
  const points = fredRateObservations(payload);
  console.log(`  ${series.fredId}: ${points.length} observations`);
  return points;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchUsInterestRates() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');
  const fetched = await mapPool(RATE_SERIES, 4, (series) => fetchSeries(series, apiKey));
  const series = {};
  RATE_SERIES.forEach((item, index) => {
    series[item.id] = fetched[index];
  });
  const data = { series };
  if (!validateRateHistory(data)) {
    throw new Error('US interest-rate history failed validation');
  }
  return data;
}

function contentMeta(data) {
  // The effective funds rate is published every day. A later Treasury or SOFR
  // print must not hide a frozen DFF.
  return tokensToContentMeta(data?.series?.fedFundsEffective?.at(-1)?.date);
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', RATES_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: interest-rate activation marker write failed: ${err?.message || err}`);
  }
}

// Built with a loop because the bundle attestation parser cannot follow flatMap.
export function interestRateShardKeys() {
  const keys = [];
  for (const series of RATE_SERIES) {
    for (const decade of RATES_DECADES) {
      keys.push({
        key: rateSeriesDecadeKey(series.id, decade),
        transform: (data) => rateDecadeShard(data, series.id, decade),
        declareRecords: countRatePoints,
        skipWhenEmpty: true,
        allowMissingOnSkip: true,
      });
    }
  }
  return keys;
}

if (process.argv[1]?.endsWith('seed-us-interest-rates.mjs')) {
  const extraKeys = interestRateShardKeys();

  runSeed('economic', 'us-interest-rates', RATES_CANONICAL_KEY, fetchUsInterestRates, {
    publishTransform: rateSnapshot,
    validateFn: validateSnapshot,
    ttlSeconds: CACHE_TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    sourceVersion: 'fred-interest-rates-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countRatePoints,
    declareRecords: countRatePoints,
    contentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
