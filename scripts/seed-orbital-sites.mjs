#!/usr/bin/env node
// Daily satellite evidence for every watched site and a per-country projection of it, so
// the Country Brief, risk context and the API read site evidence without a browser.
// One run evaluates as many sites as fit its budget and the next run resumes after them.
import {
  ArchiveRefusal,
  ARCHIVE_LOOKBACK_DAYS,
  acquisitionsFromStac,
  countryKey,
  evaluateSites,
  ORBITAL_SITES_ACTIVATION_KEY,
  ORBITAL_SITES_KEY,
  planPublication,
  ROLLUP_MAX_AGE_MS,
  siteKey,
  STAC_SEARCH_URL,
  stacSearchBody,
} from './_orbital-sites.mjs';
import { ORBITAL_CATALOG_KEY } from './_orbital-catalog.mjs';
import {
  backfillSearchBody,
  flagShadowKey,
  makeChangeStage,
  ScoringRefusal,
  statisticsUrl,
} from './_orbital-change.mjs';
import {
  getRedisCredentials,
  loadEnvFile,
  markPreservableFetchFailure,
  readCanonicalValue,
  redisCommand,
  runSeed,
  sleep,
} from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { WATCHED_SITES, WATCHED_SITES_VERSION } from './shared/orbital-watched-sites.generated.mjs';

loadEnvFile(import.meta.url);

const USER_AGENT = 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)';
const ARCHIVE_TIMEOUT_MS = 20_000;
// Bounded archive rate: one search at a time, at most about four a second.
export const ARCHIVE_MIN_INTERVAL_MS = 250;
// Leaves the bundle section (9 minutes) room to publish after the evaluation stops.
export const RUN_BUDGET_MS = 6 * 60_000;
export const RECORD_TTL_SECONDS = 14 * 86_400;
// Daily cadence; three missed days before health calls the sites stale.
export const MAX_STALE_MIN = 4_320;
const REFUSAL_STATUSES = new Set([401, 403, 429, 451]);
const MGET_CHUNK = 100;
const PIPELINE_CHUNK = 50;

// Change scoring gets its own share of the run, so a pass of the registry stays within the rollup freshness gate.
export const CHANGE_BUDGET_MS = 2 * 60_000;

/** One request at a time, `minIntervalMs` apart. */
function makeThrottle({ minIntervalMs, clock, wait }) {
  let lastRequestAt = -Infinity;
  return async () => {
    const gap = lastRequestAt + minIntervalMs - clock();
    if (gap > 0) await wait(gap);
    lastRequestAt = clock();
  };
}

/** Searches the archive for one site; `bodyFor` picks the window. Its `backfill` reads older radar scenes on the same throttle. */
export function makeArchiveSearch({ fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = ARCHIVE_MIN_INTERVAL_MS, clock = Date.now, wait = sleep } = {}) {
  const throttle = makeThrottle({ minIntervalMs, clock, wait });
  async function search(body) {
    await throttle();
    const response = await fetchImpl(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (REFUSAL_STATUSES.has(response.status)) {
      await response.body?.cancel();
      throw new ArchiveRefusal(`Planetary Computer refused the search (HTTP ${response.status})`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Planetary Computer HTTP ${response.status}`);
    }
    const json = await response.json();
    return acquisitionsFromStac(json?.features);
  }
  const searchArchive = (site, nowMs) => search(stacSearchBody(site, nowMs));
  searchArchive.backfill = (site, nowMs) => search(backfillSearchBody(site, nowMs, ARCHIVE_LOOKBACK_DAYS)).catch((error) => {
    throw error instanceof ArchiveRefusal ? new ScoringRefusal(error.message) : error;
  });
  return searchArchive;
}

/** Radar statistics of one scene over a footprint; null statistics mean the response had none. */
export function makeStatisticsFetch({ fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = ARCHIVE_MIN_INTERVAL_MS, clock = Date.now, wait = sleep } = {}) {
  const throttle = makeThrottle({ minIntervalMs, clock, wait });
  return async function fetchStatistics(scene, feature) {
    await throttle();
    const response = await fetchImpl(statisticsUrl(scene), {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(feature),
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (REFUSAL_STATUSES.has(response.status)) {
      await response.body?.cancel();
      throw new ScoringRefusal(`Planetary Computer refused the statistics request (HTTP ${response.status})`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Planetary Computer statistics HTTP ${response.status} for ${scene.itemId}`);
    }
    const json = await response.json();
    return json?.properties?.statistics ?? null;
  };
}

export function redisSiteStore({ credentials = getRedisCredentials, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  async function readMany(siteIds, keyOf, label) {
    const { url, token } = credentials();
    const values = new Map();
    for (let start = 0; start < siteIds.length; start += MGET_CHUNK) {
      const chunk = siteIds.slice(start, start + MGET_CHUNK);
      const { result } = await redisCommand(url, token, ['MGET', ...chunk.map(keyOf)], { label });
      chunk.forEach((id, i) => {
        const raw = Array.isArray(result) ? result[i] : null;
        if (typeof raw === 'string') values.set(id, JSON.parse(raw));
      });
    }
    return values;
  }
  return {
    readIndex: () => readCanonicalValue(ORBITAL_SITES_KEY, { strict: true }),
    readCatalog: () => readCanonicalValue(ORBITAL_CATALOG_KEY, { strict: true }),
    readRecords: (siteIds) => readMany(siteIds, siteKey, 'Redis MGET orbital site records'),
    readFlags: (siteIds) => readMany(siteIds, flagShadowKey, 'Redis MGET orbital shadow flags'),
    async write(commands) {
      const { url, token } = credentials();
      for (let start = 0; start < commands.length; start += PIPELINE_CHUNK) {
        const chunk = commands.slice(start, start + PIPELINE_CHUNK);
        const response = await fetchImpl(`${url}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Redis pipeline HTTP ${response.status}`);
        const replies = await response.json();
        const failed = Array.isArray(replies) ? replies.find((reply) => reply?.error) : { error: 'no reply' };
        if (failed) throw new Error(`Redis pipeline failed: ${failed.error}`);
      }
    },
  };
}

/** Site records and rollups land before the index that names their revisions. */
export function publicationCommands(plan, { canonicalKey, payload, ttlSeconds }) {
  return [
    ...plan.siteWrites.map((record) => ['SET', siteKey(record.siteId), JSON.stringify(record), 'EX', RECORD_TTL_SECONDS]),
    ...plan.retainedSiteIds.map((id) => ['EXPIRE', siteKey(id), RECORD_TTL_SECONDS]),
    ...(plan.flagWrites ?? []).map((flag) => ['SET', flagShadowKey(flag.siteId), JSON.stringify(flag), 'EX', RECORD_TTL_SECONDS]),
    ...(plan.flagWrites ? plan.retainedSiteIds.map((id) => ['EXPIRE', flagShadowKey(id), RECORD_TTL_SECONDS]) : []),
    ...plan.rollupWrites.map((rollup) => ['SET', countryKey(rollup.countryCode), JSON.stringify(rollup), 'EX', RECORD_TTL_SECONDS]),
    ...plan.deletes.map((key) => ['DEL', key]),
    ['SET', canonicalKey, payload, 'EX', ttlSeconds],
    ['SET', ORBITAL_SITES_ACTIVATION_KEY, '1'],
  ];
}

/**
 * `scoring` ({ fetchStatistics, searchBackfill, budgetMs, shadow }) adds the change stage;
 * without it site records pass their previous flag through.
 */
export function makeFetchSites({ store, searchArchive, sites = WATCHED_SITES, registryVersion = WATCHED_SITES_VERSION, budgetMs = RUN_BUDGET_MS, clock = Date.now, scoring = null }) {
  let pending = null;
  async function fetchSites() {
    const nowMs = clock();
    const catalog = await store.readCatalog();
    if (!Array.isArray(catalog?.satellites) || catalog.satellites.length === 0) {
      throw markPreservableFetchFailure(new Error('orbital catalog is missing; the catalog seeder has not published'));
    }
    const previousIndex = await store.readIndex();
    const knownIds = [...new Set([...sites.map((site) => site.id), ...Object.keys(previousIndex?.sites ?? {})])];
    const previousRecords = await store.readRecords(knownIds);
    // Scoring runs after the site pass, inside the same run budget.
    const changeBudgetMs = scoring ? Math.min(scoring.budgetMs, budgetMs / 2) : 0;
    const change = scoring && makeChangeStage({
      ...scoring, budgetMs: changeBudgetMs, clock, previousFlags: scoring.shadow === false ? new Map() : await store.readFlags(knownIds),
    });
    const evaluation = await evaluateSites({
      sites, catalog, previousRecords, cursor: previousIndex?.nextSiteId ?? null, searchArchive, nowMs, deadlineMs: nowMs + budgetMs - changeBudgetMs, clock, change,
    });
    if (evaluation.refused) return { publishBlocked: evaluation.refused, sites: {} };
    if (evaluation.evaluated > 0 && evaluation.failed.length === evaluation.evaluated) {
      throw markPreservableFetchFailure(new Error(`archive search failed for all ${evaluation.evaluated} sites: ${evaluation.failed[0].reason}`));
    }
    pending = planPublication({ sites, registryVersion, previousIndex, previousRecords, evaluation, nowMs });
    console.log(`  Sites evaluated: ${evaluation.evaluated} of ${sites.length} (${evaluation.failed.length} kept after archive failure); next: ${evaluation.nextSiteId ?? 'full pass'}; countries: ${pending.rollupWrites.length}; deleted keys: ${pending.deletes.length}`);
    if (evaluation.change) console.log(`  Change scoring${evaluation.change.shadow ? ' (shadow)' : ''}: ${evaluation.change.scoredSites} sites, ${evaluation.change.unfinishedSites} unfinished${evaluation.change.lastStopReason ? ` (last: ${evaluation.change.lastStopReason})` : ''}, ${evaluation.change.skippedSites} skipped, ${evaluation.change.statisticsRequests} statistics requests${evaluation.change.halted ? `; halted: ${evaluation.change.halted}` : ''}`);
    return pending.index;
  }
  async function publishAtomically(_index, context) {
    await store.write(publicationCommands(pending, context));
  }
  return { fetchSites, publishAtomically };
}

/** Health counts only sites evaluated recently enough for their country rollup to pass the freshness gate. */
export const freshSiteCount = (data) =>
  Object.values(data?.sites ?? {}).filter((site) => data.runAt - site.evaluatedAt <= ROLLUP_MAX_AGE_MS).length;

export function buildSeedOptions(publishAtomically) {
  return {
    validateFn: (data) => data?.schema === 1 && data.sites && typeof data.sites === 'object',
    publishAtomically,
    ttlSeconds: RECORD_TTL_SECONDS,
    recordCount: freshSiteCount,
    declareRecords: (data) => Object.keys(data?.sites ?? {}).length,
    sourceVersion: 'planetary-computer-stac',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    fetchPhaseTimeoutMs: RUN_BUDGET_MS + 60_000,
    lockTtlMs: RUN_BUDGET_MS + 3 * 60_000,
  };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const searchArchive = makeArchiveSearch();
  const { fetchSites, publishAtomically } = makeFetchSites({
    store: redisSiteStore(),
    searchArchive,
    budgetMs: Number(process.env.ORBITAL_SITES_RUN_BUDGET_MS) || RUN_BUDGET_MS,
    scoring: {
      fetchStatistics: makeStatisticsFetch(),
      searchBackfill: searchArchive.backfill,
      budgetMs: Number(process.env.ORBITAL_CHANGE_BUDGET_MS) || CHANGE_BUDGET_MS,
    },
  });
  runSeed('orbital', 'sites', ORBITAL_SITES_KEY, fetchSites, buildSeedOptions(publishAtomically)).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
