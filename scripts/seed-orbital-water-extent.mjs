#!/usr/bin/env node
// Radar water-extent series for the strategic reservoirs, which the watched-site registry carries as
// `water` sites (#10714). Daily: for each reservoir, find new Sentinel-1 RTC scenes over its core box
// and record the open-water share of each scene that images the whole box. The series accumulates in
// the canonical key; the change scorer never sees these sites (it scores land sites only).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRedisCredentials, loadEnvFile, readCanonicalValue, redisCommand, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';
import {
  ARCHIVE_REFUSAL_STATUSES,
  ArchiveRefusal,
  archiveBackoffCommand,
  nextBackoff,
  ORBITAL_SITES_BACKOFF_KEY,
  STAC_SEARCH_URL,
} from './_orbital-sites.mjs';
import { WATCHED_SITES } from './shared/orbital-watched-sites.generated.mjs';
import {
  FIRST_PASS_SCENES,
  MAX_SCENES_PER_SITE_PER_RUN,
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

/** Planetary Computer is shared with the watched-sites seeder: a refusal stops this run and backs both off. */
function checkResponse(response) {
  if (ARCHIVE_REFUSAL_STATUSES.has(response.status)) throw new ArchiveRefusal(`Planetary Computer refused the request (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function postJson(url, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  checkResponse(response);
  return response.json();
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  checkResponse(response);
  return response.json();
}

export const MAX_SEARCH_PAGES = 5;

const nextLink = (page) => (Array.isArray(page?.links) ? page.links.find((l) => l?.rel === 'next') : null);

/** The next page of a STAC search, followed only on the search host; null when it is elsewhere. */
function fetchNextPage(link, body, fetchImpl) {
  const href = new URL(link.href ?? STAC_SEARCH_URL, STAC_SEARCH_URL);
  if (href.origin !== new URL(STAC_SEARCH_URL).origin) return null;
  if (String(link.method ?? 'GET').toUpperCase() === 'POST') return postJson(href.href, link.merge ? { ...body, ...link.body } : (link.body ?? body), fetchImpl);
  return getJson(href.href, fetchImpl);
}

/**
 * Every page of a scene search, up to the run deadline; `truncated` when pages remain or a later page fails, so the scenes found
 * are still measured but the search window is not marked complete.
 */
export const makeSceneSearch = (fetchImpl = (...args) => globalThis.fetch(...args), clock = Date.now) => async (body, { deadlineMs = Infinity } = {}) => {
  let page = await postJson(STAC_SEARCH_URL, body, fetchImpl);
  const features = [];
  for (let n = 1; ; n += 1) {
    if (Array.isArray(page?.features)) features.push(...page.features);
    const link = nextLink(page);
    if (!link) return { features, truncated: false };
    const next = n < MAX_SEARCH_PAGES && clock() < deadlineMs ? fetchNextPage(link, body, fetchImpl) : null;
    if (!next) return { features, truncated: true };
    try {
      page = await next;
    } catch (error) {
      if (error instanceof ArchiveRefusal) throw error;
      return { features, truncated: true };
    }
  }
};

export const makeStatisticsFetch = (fetchImpl = (...args) => globalThis.fetch(...args)) =>
  (sceneId, geometry) => postJson(`${STATISTICS_URL}?${statisticsQuery(sceneId)}`, { type: 'Feature', properties: {}, geometry }, fetchImpl);

const isRefusal = (error) => error instanceof ArchiveRefusal;

/**
 * Measures every reservoir inside one run budget, carrying each previous series forward. The first pass
 * takes the newest scenes of every reservoir, so a cold start reaches the whole watchlist; the second
 * spends what is left of the budget on the backlog, reusing the first pass's searches. A run inside the
 * shared archive backoff makes no request; a refusal stops the run and extends that backoff.
 */
export function makeFetchWaterExtent({
  sites = WATCHED_SITES, watchlist = loadWatchlist(), readPrevious, readBackoff = async () => null, writeBackoff = async () => {},
  searchScenes, fetchStatistics, budgetMs = RUN_BUDGET_MS, now = Date.now,
}) {
  return async function fetchWaterExtent() {
    const nowMs = now();
    const backoff = await readBackoff();
    if (backoff && nowMs < backoff.until) {
      return { publishBlocked: `archive backoff after ${backoff.refusals} refusal(s) until ${new Date(backoff.until).toISOString()}: ${backoff.reason}`, reservoirs: {} };
    }
    const deadlineMs = nowMs + budgetMs;
    const previous = await readPrevious();
    const prior = previous?.schema === WATER_EXTENT_SCHEMA ? previous.reservoirs ?? {} : {};
    const targets = orderTargets(reservoirTargets(sites, watchlist), prior);
    const searches = new Map();
    const searchOnce = async (body, options) => {
      const key = JSON.stringify(body);
      if (!searches.has(key)) searches.set(key, await searchScenes(body, options));
      return searches.get(key);
    };
    const firstPass = new Map();
    const reservoirs = {};
    let requests = 0;
    let added = 0;
    let refused = null;
    const tally = { searched: 0, searchFailed: 0, answered: 0, failed: 0 };
    const errors = [];
    for (const [pass, limit] of [[1, FIRST_PASS_SCENES], [2, MAX_SCENES_PER_SITE_PER_RUN - FIRST_PASS_SCENES]]) {
      for (const target of targets) {
        const first = firstPass.get(target.siteId);
        if (pass === 2 && (refused || first.searched !== true || first.complete || first.error)) continue;
        // After a refusal the remaining reservoirs are carried without a request (a deadline already past).
        const result = await measureReservoir(target, pass === 1 ? prior[target.siteId] : first.record, {
          searchScenes: searchOnce, fetchStatistics, nowMs, deadlineMs: refused ? -Infinity : deadlineMs, clock: now, limit, isRefusal,
        });
        if (pass === 1) firstPass.set(target.siteId, result);
        reservoirs[target.siteId] = result.record;
        // The second pass's search is the first pass's, answered from memory.
        requests += pass === 2 && result.searched === true ? result.requests - 1 : result.requests;
        added += result.added;
        if (pass === 1 && result.searched === true) tally.searched += 1;
        if (pass === 1 && result.searched === false) tally.searchFailed += 1;
        tally.answered += result.answered;
        tally.failed += result.failed;
        if (result.error) errors.push(`${target.reservoirId}: ${result.error}`);
        refused ??= result.refused;
      }
    }
    console.log(`  Water extent: ${targets.length} reservoirs, ${added} new readings, ${requests} requests, ${errors.length} errors`);
    for (const line of errors.slice(0, 5)) console.warn(`  ${line}`);
    if (refused) {
      const next = nextBackoff(backoff, refused, now());
      await writeBackoff(next);
      console.warn(`  ARCHIVE REFUSED: ${refused}; no further requests this run, backing off until ${new Date(next.until).toISOString()}`);
      if (tally.answered === 0) return { publishBlocked: refused, reservoirs: {} };
    }
    // A run in which the archive answered nothing must not refresh seed-meta from the carried series.
    if (tally.searchFailed > 0 && tally.searched === 0) throw new Error(`every scene search failed (${errors[0]})`);
    if (tally.failed > 0 && tally.answered === 0) throw new Error(`every statistics request failed (${errors[0]})`);
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
    async readBackoff() {
      const { url, token } = getRedisCredentials();
      const { result } = await redisCommand(url, token, ['GET', ORBITAL_SITES_BACKOFF_KEY], { label: 'Redis GET orbital archive backoff' });
      return typeof result === 'string' ? JSON.parse(result) : null;
    },
    async writeBackoff(backoff) {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, archiveBackoffCommand(backoff), { label: 'Redis SET orbital archive backoff' });
    },
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
