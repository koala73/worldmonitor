#!/usr/bin/env node
// Monthly US CPI basket. FRED republishes the BLS CPI-U indexes. api.bls.gov
// is blocked from Railway, so this seeder does not call BLS.

import { loadEnvFile, fredFetchJson, resolveProxyForConnect, runSeed } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

const proxyAuth = resolveProxyForConnect();

export const CPI_CANONICAL_KEY = 'economic:us-cpi:v1';
export const CPI_LATEST_KEY = 'economic:us-cpi:latest:v1';
export const CPI_ACTIVATION_KEY = 'seed-activated:economic:us-cpi';
export const CPI_COMPONENTS = [
  { key: 'headline', seriesId: 'CPIAUCSL' },
  { key: 'core', seriesId: 'CPILFESL' },
  { key: 'food', seriesId: 'CPIUFDSL' },
  { key: 'energy', seriesId: 'CPIENGSL' },
  { key: 'shelter', seriesId: 'CUSR0000SAH1' },
  { key: 'services', seriesId: 'CUSR0000SAS' },
];
export const CPI_DECADE_STARTS = [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030];

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const CPI_MAX_CONTENT_AGE_MIN = 75 * DAY_MIN;

export function monthStart(date) {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(String(date ?? ''));
  return match ? `${match[1]}-${match[2]}-01` : undefined;
}

export function shiftMonth(isoDate, delta) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(isoDate);
  if (!match) return undefined;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-01`;
}

export function fredObservations(payload) {
  const observations = Array.isArray(payload?.observations) ? payload.observations : [];
  const byMonth = new Map();
  for (const observation of observations) {
    const date = monthStart(observation?.date);
    const value = Number(observation?.value);
    if (!date || observation?.value === '.' || !Number.isFinite(value)) continue;
    byMonth.set(date, value);
  }
  return [...byMonth.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
}

export function countCpiPoints(data) {
  return CPI_COMPONENTS.reduce((total, component) => total + (data?.components?.[component.key]?.length ?? 0), 0);
}

export function latestCpiWindow(data) {
  const headline = data?.components?.headline ?? [];
  const end = headline.at(-1)?.date;
  const start = end ? shiftMonth(end, -12) : undefined;
  const components = {};
  for (const component of CPI_COMPONENTS) {
    const points = data?.components?.[component.key] ?? [];
    components[component.key] = start
      ? points.filter((point) => point.date >= start && point.date <= end)
      : [];
  }
  return { components };
}

export function cpiDecadeShard(data, decade) {
  const components = {};
  for (const component of CPI_COMPONENTS) {
    const points = (data?.components?.[component.key] ?? []).filter((point) => {
      const year = Number(point.date.slice(0, 4));
      return Math.floor(year / 10) * 10 === decade;
    });
    if (points.length > 0) components[component.key] = points;
  }
  return { components };
}

function validate(data) {
  const headline = data?.components?.headline;
  if (!Array.isArray(headline) || headline.length < 800) return false;
  if (headline[0]?.date !== '1947-01-01') return false;
  return CPI_COMPONENTS.every((component) => (data.components?.[component.key]?.length ?? 0) > 0);
}

async function fetchComponent(seriesId, apiKey) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    observation_start: '1947-01-01',
    sort_order: 'asc',
  });
  const payload = await fredFetchJson(
    `https://api.stlouisfed.org/fred/series/observations?${params}`,
    proxyAuth,
  );
  return fredObservations(payload);
}

async function fetchUsCpi() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');
  const components = {};
  for (const component of CPI_COMPONENTS) {
    components[component.key] = await fetchComponent(component.seriesId, apiKey);
    console.log(`  CPI ${component.key}: ${components[component.key].length} months`);
  }
  return { components };
}

function contentMeta(data) {
  // Headline is the release clock. A later component print must not hide a frozen CPIAUCSL.
  return tokensToContentMeta(data?.components?.headline?.at(-1)?.date);
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', CPI_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: CPI activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-us-cpi.mjs')) {
  const extraKeys = [
    {
      key: CPI_LATEST_KEY,
      transform: latestCpiWindow,
      declareRecords: countCpiPoints,
    },
    ...CPI_DECADE_STARTS.map((decade) => ({
      key: `${CPI_CANONICAL_KEY}:${decade}`,
      transform: (data) => cpiDecadeShard(data, decade),
      declareRecords: countCpiPoints,
      skipWhenEmpty: true,
      allowMissingOnSkip: decade >= 2030,
    })),
  ];

  runSeed('economic', 'us-cpi', CPI_CANONICAL_KEY, fetchUsCpi, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 150_000,
    sourceVersion: 'fred-cpi-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCpiPoints,
    declareRecords: countCpiPoints,
    contentMeta,
    maxContentAgeMin: CPI_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
