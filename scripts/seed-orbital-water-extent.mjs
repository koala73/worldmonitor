#!/usr/bin/env node
// Radar water-extent series for the strategic reservoirs, which the watched-site registry carries as
// `water` sites (#10714). Daily: for each reservoir, find new Sentinel-1 RTC scenes over its core box
// and record the open-water share of each scene that images the whole box. The series accumulates in
// the canonical key; the change scorer never sees these sites (it scores land sites only).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { STAC_SEARCH_URL } from './_orbital-sites.mjs';
import { WATCHED_SITES } from './shared/orbital-watched-sites.generated.mjs';
import {
  METHODOLOGY,
  SOURCE,
  WATER_EXTENT_SCHEMA,
  WATER_THRESHOLD_DB,
  MIN_VALID_PERCENT,
  freshReservoirCount,
  measureReservoir,
  orderTargets,
  reservoirTargets,
  statisticsQuery,
} from './_orbital-water-extent.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ORBITAL_WATER_EXTENT_KEY = 'orbital:water-extent:v1';
export const ORBITAL_WATER_EXTENT_ACTIVATION_KEY = 'seed-activated:orbital:water-extent';
export const WATCHLIST_PATH = join(__dirname, 'data', 'strategic-reservoirs.json');
export const STATISTICS_URL = 'https://planetarycomputer.microsoft.com/api/data/v1/item/statistics';
/** Daily cron: the series must outlive two missed runs. */
export const TTL_SECONDS = 7 * 86_400;
export const MAX_STALE_MIN = 4_320;
export const RUN_BUDGET_MS = 6 * 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const USER_AGENT = 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)';

export const loadWatchlist = (path = WATCHLIST_PATH) => JSON.parse(readFileSync(path, 'utf8')).reservoirs;

async function postJson(url, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export const makeSceneSearch = (fetchImpl = (...args) => globalThis.fetch(...args)) =>
  (body) => postJson(STAC_SEARCH_URL, body, fetchImpl);

export const makeStatisticsFetch = (fetchImpl = (...args) => globalThis.fetch(...args)) =>
  (sceneId, geometry) => postJson(`${STATISTICS_URL}?${statisticsQuery(sceneId)}`, { type: 'Feature', properties: {}, geometry }, fetchImpl);

/** Measures every reservoir in turn, carrying each previous series forward, inside one run budget. */
export function makeFetchWaterExtent({ sites = WATCHED_SITES, watchlist = loadWatchlist(), readPrevious, searchScenes, fetchStatistics, budgetMs = RUN_BUDGET_MS, now = Date.now }) {
  return async function fetchWaterExtent() {
    const nowMs = now();
    const deadlineMs = nowMs + budgetMs;
    const previous = await readPrevious();
    const prior = previous?.schema === WATER_EXTENT_SCHEMA ? previous.reservoirs ?? {} : {};
    const targets = orderTargets(reservoirTargets(sites, watchlist), prior);
    const reservoirs = {};
    let requests = 0;
    let added = 0;
    const errors = [];
    for (const target of targets) {
      const result = await measureReservoir(target, prior[target.siteId], { searchScenes, fetchStatistics, nowMs, deadlineMs, clock: now });
      reservoirs[target.siteId] = result.record;
      requests += result.requests;
      added += result.added;
      if (result.error) errors.push(`${target.reservoirId}: ${result.error}`);
    }
    console.log(`  Water extent: ${targets.length} reservoirs, ${added} new readings, ${requests} requests, ${errors.length} errors`);
    for (const line of errors.slice(0, 5)) console.warn(`  ${line}`);
    return {
      schema: WATER_EXTENT_SCHEMA,
      runAt: nowMs,
      thresholdDb: WATER_THRESHOLD_DB,
      minValidPercent: MIN_VALID_PERCENT,
      source: SOURCE,
      methodology: METHODOLOGY,
      reservoirs,
    };
  };
}

export function buildSeedOptions(watchlistSize = loadWatchlist().length) {
  return {
    validateFn: (data) => data?.schema === WATER_EXTENT_SCHEMA && data.reservoirs && Object.keys(data.reservoirs).length === watchlistSize,
    ttlSeconds: TTL_SECONDS,
    declareRecords: (data) => freshReservoirCount(data),
    sourceVersion: 'planetary-computer-sentinel-1-rtc-vv-18db',
    schemaVersion: WATER_EXTENT_SCHEMA,
    maxStaleMin: MAX_STALE_MIN,
    fetchPhaseTimeoutMs: RUN_BUDGET_MS + 60_000,
    lockTtlMs: RUN_BUDGET_MS + 3 * 60_000,
    afterFreshness: async () => {
      const creds = getOptionalUpstashCreds();
      if (!creds) throw new Error('Missing water extent activation credentials');
      await upstashCommand(creds, ['SET', ORBITAL_WATER_EXTENT_ACTIVATION_KEY, '1']);
    },
  };
}

/** Ships dark with the rest of Orbital Watch (#10710). */
export const waterExtentEnabled = (env = process.env) => (env.ORBITAL_WATCH_ENABLED ?? '').trim().toLowerCase() === 'true';

if (isMainModule(import.meta.url, process.argv[1]) && !waterExtentEnabled()) {
  console.log('  SKIPPED: Orbital Watch ships dark (#10710); set ORBITAL_WATCH_ENABLED=true to seed reservoir water extent');
} else if (isMainModule(import.meta.url, process.argv[1])) {
  const fetchWaterExtent = makeFetchWaterExtent({
    readPrevious: () => readCanonicalValue(ORBITAL_WATER_EXTENT_KEY, { strict: true }),
    searchScenes: makeSceneSearch(),
    fetchStatistics: makeStatisticsFetch(),
    budgetMs: Number(process.env.ORBITAL_WATER_EXTENT_RUN_BUDGET_MS) || RUN_BUDGET_MS,
  });
  runSeed('orbital', 'water-extent', ORBITAL_WATER_EXTENT_KEY, fetchWaterExtent, buildSeedOptions()).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
