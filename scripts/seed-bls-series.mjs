#!/usr/bin/env node
// Seed labor market time series via FRED (replaces direct BLS API which is blocked
// from Railway container IPs — api.bls.gov rejects HTTPS CONNECT through proxies).
// FRED mirrors the national BLS series with identical data and no IP restrictions.
// Metro-area unemployment rates (LAUMT*) are dropped; no FRED equivalent exists.
//
// The canonical `bls:series:v1` envelope is the only key this seeder publishes:
// server/worldmonitor/economic/v1/get-bls-series.ts selects a series from it and
// api/health.js watches it. The per-series `bls:series:<id>` extra keys were
// dropped in #8424 — their seed-meta override was the data key itself, so every
// run erased the series it had just written, unwatched by health.

import { loadEnvFile, runSeed, sleep, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

const CANONICAL_KEY = 'bls:series:v1';
const CACHE_TTL = 259200; // 72h = 3× daily seed interval
// Content-age budget — the newest observation across the FRED-mirrored BLS
// series. The dominant freeze mode is FRED-stops or BLS-discontinues; 75 days
// clears the monthly publication lag plus a missed cycle while flipping
// /api/health to STALE_CONTENT well before a real BLS outage is invisible.
// (Note: catches a whole-upstream freeze; a single discontinued series among
// several would be masked by the others — newestItemAt is the max.) See #3845.
const BLS_MAX_CONTENT_AGE_MIN = 75 * DAY_MIN;

// FRED equivalents for the national BLS series.
// seriesId must match what the RPC handler and frontend BLS_SERIES array use.
const FRED_SERIES = [
  { id: 'USPRIV',    title: 'Total Private Nonfarm Payrolls', units: 'Thousands of Persons', fredId: 'USPRIV' },
  { id: 'ECIALLCIV', title: 'Employment Cost Index - All Civilian Workers', units: 'Index (Dec 2005=100)', fredId: 'ECIALLCIV' },
];

/** The ids the RPC may ask for; must stay equal to economicBlsSeriesIds in shared/openapi-filter-param-contracts.json. */
export const BLS_SERIES_IDS = FRED_SERIES.map((def) => def.id);

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
      all.push({
        seriesId: def.id,
        title: def.title,
        units: def.units,
        observations: result.observations,
      });
    }
  }

  return { series: all, fetchedAt: new Date().toISOString() };
}

// The shape the RPC will serve, kept deliberately identical to
// isServableSeries in server/worldmonitor/economic/v1/get-bls-series.ts. The
// reader refuses an entry narrower than this, so the producer must refuse to
// publish one: otherwise the seed passes validation, health reads fresh, and
// every request for that series 503s until the next run.
function isPublishableSeries(s) {
  return typeof s?.seriesId === 'string'
    && typeof s.title === 'string'
    && typeof s.units === 'string'
    && Array.isArray(s.observations)
    && s.observations.length > 0;
}

// A partial cohort is not a publishable seed either. The RPC answers a known
// series that is absent from a valid envelope with 503, and runSeed writes
// fresh seed-meta for whatever this accepts, so publishing a 1-of-2 fetch
// would serve a 503 for the dropped series all day while health reads OK.
// Refusing it takes runSeed's validation-skip path instead: the last-good
// envelope keeps serving both series and STALE_SEED fires if the outage
// persists.
export function validate(data) {
  if (!Array.isArray(data?.series)) return false;
  return FRED_SERIES.every((def) =>
    data.series.some((s) => isPublishableSeries(s) && s.seriesId === def.id),
  );
}

export function declareRecords(data) {
  return Array.isArray(data?.series) ? data.series.length : 0;
}

// Content-age contract: newest observation across all series, derived from the
// BLS year + period (M01..M12) pair. Detects a frozen FRED/BLS feed that
// seeder-liveness checks cannot — see scripts/_content-age-helpers.mjs.
export function blsContentMeta(data) {
  const tokens = [];
  for (const s of Array.isArray(data?.series) ? data.series : []) {
    for (const o of Array.isArray(s?.observations) ? s.observations : []) {
      const mm = /^M(\d{2})$/.exec(o?.period ?? '');
      if (mm && o?.year) tokens.push(`${o.year}-${mm[1]}`);
    }
  }
  return tokensToContentMeta(tokens);
}

if (process.argv[1]?.endsWith('seed-bls-series.mjs')) {
  runSeed('economic', 'bls-series', CANONICAL_KEY, fetchAllSeries, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'fred-v1',

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
    contentMeta: blsContentMeta,
    maxContentAgeMin: BLS_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
