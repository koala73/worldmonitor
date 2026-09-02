#!/usr/bin/env node
/**
 * Seed USDA FAS PSD food stocks with a FAOSTAT Food Balances gap fill into Redis.
 *
 * Canonical key: resilience:food-stocks:v1
 * Stages: PSD authoritative stocks, FAOSTAT balance fill, then stocks-to-use.
 * Marketing years stay on the record as "YYYY/YY"; never calendar-bucketed.
 *
 * Usage:
 *   node scripts/seed-food-stocks.mjs
 */

import { resolveIso2 } from './_country-resolver.mjs';
import Papa from 'papaparse';
import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
  FOOD_STOCKS_MAX_STALE_MIN,
  FOOD_STOCKS_SOURCE_VERSION,
  FOOD_STOCKS_TTL_SECONDS,
  FOOD_STOCKS_WORLD_KEY,
  PSD_COMMODITIES,
  applyFaostatFoodBalanceFill,
  assembleFoodStocksSnapshot,
  foodStocksContentMeta,
  parsePsdForecastRows,
} from './_food-stocks-helpers.mjs';
import { CHROME_UA, loadEnvFile, loadSharedConfig, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url, { only: ['USDA_FAS_PSD_API_KEY', 'USDA_FAS_API_KEY'] });

// Official FAS Open Data host (swagger base api.fas.usda.gov). The legacy
// apps.fas.usda.gov/OpenData path returns HTTP 500 for the same routes.
const PSD_BASE = 'https://api.fas.usda.gov/api/psd';
const FAOSTAT_DATA = 'https://api.data.apps.fao.org/api/v2/bigquery';
const FAOSTAT_QUERY_SQL = 'https://data.apps.fao.org/catalog/dataset/5c00a4e6-0ec8-4191-a0c0-a7cd5fda3674/resource/91b9d43c-55c4-4a2a-9b25-78f2fabba28b/download/fct-fbs-food-balances.query.sql';
const M49_TO_ISO2 = loadSharedConfig('un-to-iso2.json');
const FETCH_GAP_MS = 150;
// Wall clock for the whole FAOSTAT enrichment stage. Six 30-second requests
// could otherwise consume three minutes after the authoritative PSD stage.
const FAOSTAT_STAGE_BUDGET_MS = 120_000;

export const CANONICAL_KEY = FOOD_STOCKS_CANONICAL_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

async function fetchUpstream(fetchImpl, url, headers, label) {
  const resp = await fetchImpl(url, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`${label} HTTP ${resp.status}${text ? ` — ${text.slice(0, 180)}` : ''}`);
    // Callers must distinguish "this marketing year is not published yet" (404)
    // from "the upstream is broken" (401/5xx/timeout). Without the status they
    // read identically and a transient outage silently republishes an older MY.
    err.status = resp.status;
    throw err;
  }
  return resp;
}

async function fetchJson(fetchImpl, url, headers, label) {
  return (await fetchUpstream(fetchImpl, url, headers, label)).json();
}

async function fetchText(fetchImpl, url, headers, label) {
  return (await fetchUpstream(fetchImpl, url, headers, label)).text();
}

/** A 404 means the year is genuinely unpublished; anything else is a failure. */
function isUnpublishedYear(err) {
  return err?.status === 404;
}

function asRowArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function fetchPsdCommodityYear(commodity, year, { fetchImpl = defaultFetch, apiKey } = {}) {
  if (!apiKey) throw new Error('USDA_FAS_PSD_API_KEY is required for PSD ingestion');
  // Swagger security scheme is X-Api-Key. Query api_key also works, but putting
  // the secret on the URL lands it in access logs — do not add it here.
  const headers = { 'X-Api-Key': apiKey };
  const code = commodity.code;
  const countryUrl = `${PSD_BASE}/commodity/${code}/country/all/year/${year}`;
  const worldUrl = `${PSD_BASE}/commodity/${code}/world/year/${year}`;
  const settle = async (url, label) => {
    try {
      return { rows: asRowArray(await fetchJson(fetchImpl, url, headers, label)), failed: false };
    } catch (err) {
      console.warn(`  ${label} failed: ${err.message}`);
      // A 404 is a real answer ("not published"); everything else means we do
      // not know what this endpoint holds.
      return { rows: [], failed: !isUnpublishedYear(err) };
    }
  };
  const [country, world] = await Promise.all([
    settle(countryUrl, `PSD countries ${commodity.slug} ${year}`),
    settle(worldUrl, `PSD world ${commodity.slug} ${year}`),
  ]);
  return {
    rows: [...country.rows, ...world.rows],
    countryFailed: country.failed,
    worldFailed: world.failed,
    failed: country.failed || world.failed,
  };
}

export async function selectLatestPsdYear(commodity, { fetchImpl, apiKey, now = new Date(), gapMs = FETCH_GAP_MS } = {}) {
  const current = now.getUTCFullYear();
  const candidates = [current, current - 1, current - 2];
  let sawFailure = false;
  for (const year of candidates) {
    try {
      const { rows, countryFailed, worldFailed, failed } = await fetchPsdCommodityYear(commodity, year, { fetchImpl, apiKey });
      if (failed) sawFailure = true;
      const parsed = parsePsdForecastRows(rows, { commodity: commodity.slug });
      // Shape predicate, NOT just `parsed.length > 0`. The world endpoint alone
      // yields one `_world` record, which would accept the year and ship a
      // commodity with no country stocks at all. Require real country coverage.
      const countryRecords = parsed.filter((rec) => rec.countryCode !== FOOD_STOCKS_WORLD_KEY);
      if (countryRecords.length > 0) {
        // `sawFailure` carries forward failures from NEWER candidate years. A
        // 5xx on the current year that forced this fall-back is exactly the
        // case that must not look like a clean publish.
        return { year, rows, parsed, degraded: failed || sawFailure, countryFailed, worldFailed };
      }
      if (parsed.length > 0 || countryFailed) {
        // World-only (or an outright country failure) is a DEGRADED year, not an
        // unpublished one — do not walk back to an older marketing year on the
        // strength of it.
        console.warn(
          `  PSD ${commodity.slug} ${year}: ${countryRecords.length} country records`
          + `${countryFailed ? ' (country endpoint failed)' : ''} — not accepting this year`,
        );
        sawFailure = true;
      }
    } catch (err) {
      console.warn(`  PSD ${commodity.slug} ${year} failed: ${err.message}`);
      if (!isUnpublishedYear(err)) sawFailure = true;
    }
    if (gapMs) await sleep(gapMs);
  }
  return { year: null, rows: [], parsed: [], degraded: sawFailure };
}

export function parseFaostatFoodBalanceRows(csv, { commodity }) {
  const parsed = Papa.parse(String(csv || ''), { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(`FAOSTAT Food Balances CSV parse failed: ${parsed.errors[0].message}`);
  }
  const rows = [];
  for (const row of parsed.data) {
    if (Number(row?.item_code) !== PSD_COMMODITIES[commodity]?.faostatBalanceItem) continue;
    const m49 = String(row?.m49_code || '').padStart(3, '0');
    const iso2 = M49_TO_ISO2[m49] || resolveIso2({ name: row?.country_name_en });
    if (!iso2) continue;
    const calendarYear = Number(row?.year);
    const production = row?.production_1000_tonnes == null || row.production_1000_tonnes === ''
      ? null
      : Number(row.production_1000_tonnes);
    const consumption = row?.domestic_supply_quantity_1000_tonnes == null
      || row.domestic_supply_quantity_1000_tonnes === ''
      ? null
      : Number(row.domestic_supply_quantity_1000_tonnes);
    if (!Number.isInteger(calendarYear)
      || !Number.isFinite(production)
      || production < 0
      || !Number.isFinite(consumption)
      || consumption <= 0) continue;
    rows.push({ countryCode: iso2, commodity, calendarYear, production, consumption });
  }
  return rows;
}

async function fetchFaostatFoodBalance(commodity, { fetchImpl }) {
  const url = new URL(FAOSTAT_DATA);
  url.searchParams.set('download', 'true');
  url.searchParams.set('item_code', String(commodity.faostatBalanceItem));
  url.searchParams.set('sql_url', FAOSTAT_QUERY_SQL);
  const csv = await fetchText(fetchImpl, url, { Accept: 'text/csv' }, `FAOSTAT ${commodity.slug}`);
  return parseFaostatFoodBalanceRows(csv, { commodity: commodity.slug });
}

/**
 * Three-stage fetch used by runSeed. FAOSTAT failures are swallowed so PSD
 * data remains the published snapshot.
 */
function resolvePsdApiKey(explicit) {
  if (explicit) return explicit;
  return process.env.USDA_FAS_PSD_API_KEY || process.env.USDA_FAS_API_KEY || '';
}

export async function fetchFoodStocks({
  fetchImpl = defaultFetch,
  apiKey = resolvePsdApiKey(),
  now = new Date(),
  gapMs = FETCH_GAP_MS,
} = {}) {
  if (!apiKey) throw new Error('USDA_FAS_PSD_API_KEY is required');

  const allRecords = [];
  const stageNotes = { psd: {}, faostat: {} };
  let upstreamDegraded = false;

  // FAOSTAT is an optional balance gap fill over authoritative PSD data, but
  // it is six potential 30-second fetches on top of a PSD stage that can already
  // consume the fetch-phase budget. Its own wall clock prevents a slow FAOSTAT
  // service from starving the authoritative stage.
  const faostatDeadline = Date.now() + FAOSTAT_STAGE_BUDGET_MS;

  for (const commodity of Object.values(PSD_COMMODITIES)) {
    console.log(`  PSD ${commodity.slug}…`);
    const { year, parsed, degraded } = await selectLatestPsdYear(commodity, { fetchImpl, apiKey, now, gapMs });
    const countryCount = parsed.filter((rec) => rec.countryCode !== FOOD_STOCKS_WORLD_KEY).length;
    stageNotes.psd[commodity.slug] = { year, countries: countryCount, degraded: Boolean(degraded) };
    if (degraded) upstreamDegraded = true;
    let merged = parsed;
    if (year) {
      const faostatYears = [year - 1, year - 2, year - 3];
      let fill = null;
      if (Date.now() > faostatDeadline) {
        console.warn(`  FAOSTAT ${commodity.slug}: stage budget exhausted — skipping fill`);
        stageNotes.faostat[commodity.slug] = { skipped: 'stage-budget' };
      } else {
        try {
          const rows = await fetchFaostatFoodBalance(commodity, { fetchImpl });
          for (const faoYear of faostatYears) {
            const sameYear = rows.filter((row) => row.calendarYear === faoYear);
            if (!sameYear.length) continue;
            fill = sameYear;
            stageNotes.faostat[commodity.slug] = { year: faoYear, rows: fill.length };
            break;
          }
        } catch (err) {
          console.warn(`  FAOSTAT ${commodity.slug} failed: ${err.message}`);
          fill = err;
        }
      }
      merged = applyFaostatFoodBalanceFill(parsed, fill, { commodity: commodity.slug });
    }
    allRecords.push(...merged);
    if (gapMs) await sleep(gapMs);
  }

  const snapshot = assembleFoodStocksSnapshot(allRecords);
  stageNotes.degraded = upstreamDegraded;
  snapshot.stageNotes = stageNotes;
  snapshot.fetchedAt = now.toISOString();
  return snapshot;
}

export function declareRecords(data) {
  return Object.keys(data || {}).filter((key) => key !== 'stageNotes' && key !== 'fetchedAt').length;
}

// Publish below this many of the six PSD commodities and the snapshot is not a
// food-stocks snapshot. 5 of 6 tolerates one commodity being genuinely
// unpublished at a marketing-year boundary without accepting a hollowed-out run.
export const MIN_WORLD_COMMODITIES = 5;

export function validateFoodStocks(data) {
  if (!data || typeof data !== 'object') return false;
  // `_world` is an aggregate, not a country — counting it toward the floor let 9
  // real countries plus the world row satisfy a "10 countries" gate.
  const countries = Object.keys(data)
    .filter((key) => key !== 'stageNotes' && key !== 'fetchedAt' && key !== FOOD_STOCKS_WORLD_KEY);
  if (countries.length < 10) return false;

  const worldCommodities = data[FOOD_STOCKS_WORLD_KEY]?.commodities;
  if (!worldCommodities) return false;

  // Coverage, not just presence. Counting country KEYS lets five of six
  // commodities vanish while ~200 countries keep the floor satisfied, and lets a
  // FAOSTAT-only snapshot (every endingStocks null) publish as
  // "food stocks". Require most commodities to carry a REAL world ratio.
  const withWorldRatio = Object.entries(worldCommodities)
    .filter(([slug, rec]) => PSD_COMMODITIES[slug] && Number.isFinite(rec?.stocksToUseRatio));
  if (withWorldRatio.length < MIN_WORLD_COMMODITIES) return false;

  // ...and at least one country (not just `_world`) must carry real stocks, so a
  // world-row-plus-FAOSTAT-fill run cannot pass.
  return countries.some((code) => Object.values(data[code]?.commodities ?? {})
    .some((rec) => Number.isFinite(rec?.endingStocks)));
}

const isMain = process.argv[1]?.endsWith('seed-food-stocks.mjs');

if (isMain) {
  runSeed('resilience', 'food-stocks', CANONICAL_KEY, fetchFoodStocks, {
    validateFn: validateFoodStocks,
    ttlSeconds: FOOD_STOCKS_TTL_SECONDS,
    sourceVersion: FOOD_STOCKS_SOURCE_VERSION,
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: FOOD_STOCKS_MAX_STALE_MIN,
    contentMeta: foodStocksContentMeta,
    maxContentAgeMin: FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
    // A rejected snapshot is an upstream FAILURE, not a quiet period. Without
    // this, runSeed's validate-skip path exits 0 AND stamps seed-meta with
    // fetchedAt=now/recordCount=0, so _bundle-runner's `elapsed < intervalMs*0.8`
    // gate then skips this section for 24 days on a single transient PSD outage.
    // Same incident already logged for imf-external (Railway, 2026-04-13).
    emptyDataIsFailure: true,
    // PSD worst case is 6 commodities x 3 year probes x 30s = 540s; FAOSTAT is
    // budgeted separately (FAOSTAT_STAGE_BUDGET_MS). fetchPhaseTimeoutMs sits
    // below lockTtlMs so the lock still covers the publish phase.
    lockTtlMs: 540_000,
    fetchPhaseTimeoutMs: 420_000,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
