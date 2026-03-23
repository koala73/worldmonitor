#!/usr/bin/env node
// Seed BLS-only time series not available on FRED (issue #2046).
// Uses BLS Public Data API v2 — requires free API key (BLS_API_KEY).

import { loadEnvFile, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'bls:series:v1';
const KEY_PREFIX = 'bls:series';
const CACHE_TTL = 259200; // 72h = 3× daily seed interval
const BLS_API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const INTER_REQUEST_DELAY_MS = 2_000;

// BLS-only series not adequately mirrored on FRED.
// For standard FRED-mirrored series (PAYEMS, CPIAUCSL, etc.), use seed-economy.mjs instead.
const BLS_SERIES = [
  { id: 'CES0500000001', title: 'Total Private Nonfarm Payrolls', units: 'Thousands' },
  { id: 'CIU1010000000000A', title: 'Employment Cost Index - All Civilian Workers', units: 'Index (Dec 2005=100)' },
  // Metro-area unemployment (selected major metros)
  { id: 'LAUMT064748000000003', title: 'San Francisco metro unemployment rate', units: 'Percent' },
  { id: 'LAUMT253590000000003', title: 'Boston metro unemployment rate', units: 'Percent' },
  { id: 'LAUMT357340000000003', title: 'New York metro unemployment rate', units: 'Percent' },
];

async function fetchBlsSeries(seriesId) {
  const apiKey = process.env.BLS_API_KEY;
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 5;

  const body = {
    seriesid: [seriesId],
    startyear: String(startYear),
    endyear: String(currentYear),
    catalog: true,
    calculations: false,
    annualaverage: false,
  };

  if (apiKey) body.registrationkey = apiKey;

  const resp = await fetch(BLS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`BLS API HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.status !== 'REQUEST_SUCCEEDED') {
    throw new Error(`BLS API error: ${data.message?.join('; ') ?? data.status}`);
  }

  const series = data.Results?.series?.[0];
  if (!series) return null;

  const observations = (series.data ?? [])
    .map((d) => ({
      year: String(d.year ?? ''),
      period: String(d.period ?? ''),
      periodName: String(d.periodName ?? ''),
      value: String(d.value ?? ''),
    }))
    .filter((d) => d.year && d.value && d.value !== '-')
    .reverse(); // oldest first

  return { observations };
}

async function fetchAllSeries() {
  const all = [];
  const perKeySeries = {};

  for (let i = 0; i < BLS_SERIES.length; i++) {
    const def = BLS_SERIES[i];
    if (i > 0) await sleep(INTER_REQUEST_DELAY_MS);
    console.log(`  Fetching ${def.id} (${def.title})...`);

    let result = null;
    try {
      result = await fetchBlsSeries(def.id);
      console.log(`    ${result?.observations?.length ?? 0} observations`);
    } catch (err) {
      console.warn(`    ${def.id}: failed (${err.message})`);
    }

    if (result) {
      const series = {
        seriesId: def.id,
        title: def.title,
        units: def.units,
        observations: result.observations,
      };
      all.push(series);
      perKeySeries[`${KEY_PREFIX}:${def.id}`] = { series };
    }
  }

  return { series: all, perKeySeries, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  return Array.isArray(data?.series) && data.series.length > 0;
}

function publishTransform(data) {
  const { perKeySeries: _pks, ...rest } = data;
  return rest;
}

async function afterPublish(data, _meta) {
  for (const [key, value] of Object.entries(data.perKeySeries ?? {})) {
    // Strip the prefix to get just the series ID for the meta key label
    const seriesId = key.replace(`${KEY_PREFIX}:`, '');
    await writeExtraKeyWithMeta(key, value, CACHE_TTL, value.series?.observations?.length ?? 0, `bls:series:${seriesId}`);
  }
}

if (process.argv[1]?.endsWith('seed-bls-series.mjs')) {
  runSeed('economic', 'bls-series', CANONICAL_KEY, fetchAllSeries, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'bls-public-api-v2',
    publishTransform,
    afterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
