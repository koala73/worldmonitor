#!/usr/bin/env node
// Seed labor market time series via FRED (replaces direct BLS API which is blocked
// from Railway container IPs — api.bls.gov rejects HTTPS CONNECT through proxies).
// FRED mirrors the national BLS series with identical data and no IP restrictions.
// Metro-area unemployment rates (LAUMT*) are dropped; no FRED equivalent exists.

import { loadEnvFile, runSeed, writeExtraKeyWithMeta, sleep, resolveProxy, fredFetchJson } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxy();

const CANONICAL_KEY = 'bls:series:v1';
const KEY_PREFIX = 'bls:series';
const CACHE_TTL = 259200; // 72h = 3× daily seed interval

// FRED equivalents for the national BLS series.
// seriesId must match what the RPC handler and frontend BLS_SERIES array use.
const FRED_SERIES = [
  { id: 'USPRIV',    title: 'Total Private Nonfarm Payrolls', units: 'Thousands of Persons', fredId: 'USPRIV' },
  { id: 'ECIALLCIV', title: 'Employment Cost Index - All Civilian Workers', units: 'Index (Dec 2005=100)', fredId: 'ECIALLCIV' },
];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** Convert a FRED date string ("2024-12-01") to BLS-style observation fields. */
function fredDateToBls(dateStr) {
  const [year, mm] = dateStr.split('-');
  const monthIdx = parseInt(mm, 10) - 1;
  const period = `M${mm.padStart(2, '0')}`;
  const periodName = MONTH_NAMES[monthIdx] ?? mm;
  return { year, period, periodName };
}

async function fetchFredSeries(fredId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const currentYear = new Date().getFullYear();
  const startDate = `${currentYear - 5}-01-01`;

  const params = new URLSearchParams({
    series_id: fredId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'asc',
    observation_start: startDate,
  });

  const data = await fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, _proxyAuth);
  const raw = data?.observations ?? [];

  const observations = raw
    .filter(o => o.value && o.value !== '.' && o.date)
    .map(o => ({
      ...fredDateToBls(o.date),
      value: o.value,
    }));

  return { observations };
}

async function fetchAllSeries() {
  const all = [];
  const perKeySeries = {};

  for (let i = 0; i < FRED_SERIES.length; i++) {
    const def = FRED_SERIES[i];
    if (i > 0) await sleep(200);
    console.log(`  Fetching ${def.id} (${def.title}) via FRED...`);

    let result = null;
    try {
      result = await fetchFredSeries(def.fredId);
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
    const seriesId = key.replace(`${KEY_PREFIX}:`, '');
    await writeExtraKeyWithMeta(key, value, CACHE_TTL, value.series?.observations?.length ?? 0, `bls:series:${seriesId}`);
  }
}

if (process.argv[1]?.endsWith('seed-bls-series.mjs')) {
  runSeed('economic', 'bls-series', CANONICAL_KEY, fetchAllSeries, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'fred-v1',
    publishTransform,
    afterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
