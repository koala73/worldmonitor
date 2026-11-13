#!/usr/bin/env node
// Daily satellite evidence for every watched site and a per-country projection of it, so
// the Country Brief, risk context and the API read site evidence without a browser.
// One run evaluates as many sites as fit its budget and the next run resumes after them.
import {
  ArchiveRefusal,
  acquisitionsFromStac,
  countryKey,
  evaluateSites,
  ORBITAL_SITES_ACTIVATION_KEY,
  ORBITAL_SITES_KEY,
  planPublication,
  siteKey,
  STAC_SEARCH_URL,
  stacSearchBody,
} from './_orbital-sites.mjs';
import { ORBITAL_CATALOG_KEY } from './_orbital-catalog.mjs';
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

export function makeArchiveSearch({ fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = ARCHIVE_MIN_INTERVAL_MS, clock = Date.now, wait = sleep } = {}) {
  let lastRequestAt = -Infinity;
  return async function searchArchive(site, nowMs) {
    const gap = lastRequestAt + minIntervalMs - clock();
    if (gap > 0) await wait(gap);
    lastRequestAt = clock();
    const response = await fetchImpl(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify(stacSearchBody(site, nowMs)),
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
    const body = await response.json();
    return acquisitionsFromStac(body?.features);
  };
}

export function redisSiteStore({ credentials = getRedisCredentials, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    readIndex: () => readCanonicalValue(ORBITAL_SITES_KEY, { strict: true }),
    readCatalog: () => readCanonicalValue(ORBITAL_CATALOG_KEY, { strict: true }),
    async readRecords(siteIds) {
      const { url, token } = credentials();
      const records = new Map();
      for (let start = 0; start < siteIds.length; start += MGET_CHUNK) {
        const chunk = siteIds.slice(start, start + MGET_CHUNK);
        const { result } = await redisCommand(url, token, ['MGET', ...chunk.map(siteKey)], { label: 'Redis MGET orbital site records' });
        chunk.forEach((id, i) => {
          const raw = Array.isArray(result) ? result[i] : null;
          if (typeof raw === 'string') records.set(id, JSON.parse(raw));
        });
      }
      return records;
    },
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
    ...plan.rollupWrites.map((rollup) => ['SET', countryKey(rollup.countryCode), JSON.stringify(rollup), 'EX', RECORD_TTL_SECONDS]),
    ...plan.deletes.map((key) => ['DEL', key]),
    ['SET', canonicalKey, payload, 'EX', ttlSeconds],
    ['SET', ORBITAL_SITES_ACTIVATION_KEY, '1'],
  ];
}

export function makeFetchSites({ store, searchArchive, sites = WATCHED_SITES, registryVersion = WATCHED_SITES_VERSION, budgetMs = RUN_BUDGET_MS, clock = Date.now }) {
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
    const evaluation = await evaluateSites({
      sites, catalog, previousRecords, cursor: previousIndex?.nextSiteId ?? null, searchArchive, nowMs, deadlineMs: nowMs + budgetMs, clock,
    });
    if (evaluation.refused) return { publishBlocked: evaluation.refused, sites: {} };
    if (evaluation.evaluated > 0 && evaluation.failed.length === evaluation.evaluated) {
      throw markPreservableFetchFailure(new Error(`archive search failed for all ${evaluation.evaluated} sites: ${evaluation.failed[0].reason}`));
    }
    pending = planPublication({ sites, registryVersion, previousIndex, previousRecords, evaluation, nowMs });
    console.log(`  Sites evaluated: ${evaluation.evaluated} of ${sites.length} (${evaluation.failed.length} kept after archive failure); next: ${evaluation.nextSiteId ?? 'full pass'}; countries: ${pending.rollupWrites.length}; deleted keys: ${pending.deletes.length}`);
    return pending.index;
  }
  async function publishAtomically(_index, context) {
    await store.write(publicationCommands(pending, context));
  }
  return { fetchSites, publishAtomically };
}

export function buildSeedOptions(publishAtomically) {
  return {
    validateFn: (data) => data?.schema === 1 && data.sites && typeof data.sites === 'object',
    publishAtomically,
    ttlSeconds: RECORD_TTL_SECONDS,
    recordCount: (data) => Object.keys(data?.sites ?? {}).length,
    declareRecords: (data) => Object.keys(data?.sites ?? {}).length,
    sourceVersion: 'planetary-computer-stac',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    fetchPhaseTimeoutMs: RUN_BUDGET_MS + 60_000,
    lockTtlMs: RUN_BUDGET_MS + 3 * 60_000,
  };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { fetchSites, publishAtomically } = makeFetchSites({
    store: redisSiteStore(),
    searchArchive: makeArchiveSearch(),
    budgetMs: Number(process.env.ORBITAL_SITES_RUN_BUDGET_MS) || RUN_BUDGET_MS,
  });
  runSeed('orbital', 'sites', ORBITAL_SITES_KEY, fetchSites, buildSeedOptions(publishAtomically)).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
