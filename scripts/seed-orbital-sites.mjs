#!/usr/bin/env node
// Daily satellite evidence for every watched site and a per-country projection of it, so
// the Country Brief, risk context and the API read site evidence without a browser.
// One run evaluates as many sites as fit its budget and the next run resumes after them.
import {
  ArchiveRefusal,
  ARCHIVE_LOOKBACK_DAYS,
  archiveBackoffMs,
  acquisitionsFromStac,
  countryKey,
  evaluateSites,
  ORBITAL_SITES_ACTIVATION_KEY,
  ORBITAL_SITES_BACKOFF_KEY,
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
  CHANGE_CONCURRENCY,
  CHANGE_SHADOW,
  changeScoringExclusions,
  checkStatistics,
  flagShadowKey,
  makeChangeStage,
  ScoringHalt,
  ScoringRefusal,
  shadowExitStatus,
  statisticsUrl,
  UnexpectedStatistics,
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
import orbitalSiteAlerts from './lib/orbital-site-alerts.cjs';
import { publishNotificationEventOutcome } from './regional-snapshot/alert-emitter.mjs';
import { SITE_WATER_PERCENT } from './shared/orbital-site-water.mjs';
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
/** Archive search pages read per site; one page is 100 items, and Sentinel-2 tiles alone can fill one. */
export const MAX_SEARCH_PAGES = 5;

/**
 * The share of the run held back from the site pass for change scoring. Scoring then runs
 * until the run's own deadline, so it also gets whatever the site pass leaves unused.
 */
export const CHANGE_BUDGET_MS = 2 * 60_000;

/** Requests start at least `minIntervalMs` apart, even when several callers wait at once. */
function makeThrottle({ minIntervalMs, clock, wait }) {
  let nextSlot = -Infinity;
  return async () => {
    const slot = Math.max(clock(), nextSlot);
    nextSlot = slot + minIntervalMs;
    const gap = slot - clock();
    if (gap > 0) await wait(gap);
  };
}

/** Searches the archive for one site; `bodyFor` picks the window. Its `backfill` reads older radar scenes on the same throttle. */
export function makeArchiveSearch({ fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = ARCHIVE_MIN_INTERVAL_MS, clock = Date.now, wait = sleep } = {}) {
  const throttle = makeThrottle({ minIntervalMs, clock, wait });
  async function page(body) {
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
    return response.json();
  }
  // Follows the search's `next` link (a POST body with a token) so a busy site is not cut at one
  // page, but reads no further page once the caller's deadline has passed.
  async function search(body, deadlineMs = Infinity) {
    const features = [];
    let next = body;
    for (let pages = 0; next && pages < MAX_SEARCH_PAGES && (pages === 0 || clock() < deadlineMs); pages += 1) {
      const json = await page(next);
      if (Array.isArray(json?.features)) features.push(...json.features);
      const link = Array.isArray(json?.links) ? json.links.find((l) => l?.rel === 'next' && l.body?.token) : null;
      next = link ? { ...body, ...link.body } : null;
    }
    return acquisitionsFromStac(features);
  }
  const searchArchive = (site, nowMs, deadlineMs) => search(stacSearchBody(site, nowMs), deadlineMs);
  searchArchive.backfill = (site, nowMs, deadlineMs) => search(backfillSearchBody(site, nowMs, ARCHIVE_LOOKBACK_DAYS), deadlineMs).catch((error) => {
    throw error instanceof ArchiveRefusal ? new ScoringRefusal(error.message) : error;
  });
  return searchArchive;
}

/** Radar statistics of one scene over a footprint; a response without the requested bands fails loudly (UnexpectedStatistics). */
export function makeStatisticsFetch({ fetchImpl = (...args) => globalThis.fetch(...args), minIntervalMs = ARCHIVE_MIN_INTERVAL_MS, clock = Date.now, wait = sleep } = {}) {
  const throttle = makeThrottle({ minIntervalMs, clock, wait });
  return async function fetchStatistics(scene, feature, { stopRequested } = {}) {
    await throttle();
    // The stage may have halted while this request waited for its slot.
    if (stopRequested?.()) throw new ScoringHalt('scoring halted');
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
    let json;
    try {
      json = await response.json();
    } catch (error) {
      throw new UnexpectedStatistics(`statistics for ${scene.itemId} are not JSON: ${error.message}`);
    }
    return checkStatistics(scene, json?.properties?.statistics);
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
    async readBackoff() {
      const { url, token } = credentials();
      const { result } = await redisCommand(url, token, ['GET', ORBITAL_SITES_BACKOFF_KEY], { label: 'Redis GET orbital archive backoff' });
      return typeof result === 'string' ? JSON.parse(result) : null;
    },
    async writeBackoff(backoff) {
      const { url, token } = credentials();
      await redisCommand(url, token, backoffCommand(backoff), { label: 'Redis SET orbital archive backoff' });
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

export const BACKOFF_TTL_SECONDS = 7 * 86_400;
const backoffCommand = (backoff) => ['SET', ORBITAL_SITES_BACKOFF_KEY, JSON.stringify(backoff), 'EX', BACKOFF_TTL_SECONDS];

/** The archive backoff after one more refusal: each refusal in a row doubles the wait. */
export function nextBackoff(previous, reason, nowMs) {
  const refusals = (previous?.refusals ?? 0) + 1;
  return { refusals, reason, at: nowMs, until: nowMs + archiveBackoffMs(refusals) };
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
    ...(plan.backoff ? [backoffCommand(plan.backoff)] : plan.clearBackoff ? [['DEL', ORBITAL_SITES_BACKOFF_KEY]] : []),
    ['SET', canonicalKey, payload, 'EX', ttlSeconds],
    ['SET', ORBITAL_SITES_ACTIVATION_KEY, '1'],
  ];
}

/** Watched-site alerts over the records a run just published; their state lives beside the site keys. */
export function redisSiteAlerts({ credentials = getRedisCredentials, publish = publishNotificationEventOutcome, now = Date.now } = {}) {
  return (records, { shadow }) => {
    const { url, token } = credentials();
    return orbitalSiteAlerts.publishOrbitalSiteAlerts(records, {
      shadow,
      now,
      async readState(key, onError) {
        try {
          const { result } = await redisCommand(url, token, ['GET', key], { label: 'Redis GET orbital alert state' });
          return typeof result === 'string' ? JSON.parse(result) : null;
        } catch (error) {
          console.warn(`  Orbital alerts: state read failed: ${error.message}`);
          onError();
          return null;
        }
      },
      async writeState(key, state, ttlSeconds) {
        try {
          await redisCommand(url, token, ['SET', key, JSON.stringify(state), 'EX', ttlSeconds], { label: 'Redis SET orbital alert state' });
          return true;
        } catch (error) {
          console.warn(`  Orbital alerts: state write failed: ${error.message}`);
          return false;
        }
      },
      publish: async (event) => {
        const outcome = await publish(event);
        return outcome.enqueued || outcome.dedupHit;
      },
    });
  };
}

/**
 * `scoring` ({ fetchStatistics, searchBackfill, budgetMs, shadow }) adds the change stage;
 * without it site records pass their previous flag through. `alerts` runs after a
 * successful publish; a failure there is logged and never fails the run. An archive refusal
 * keeps the sites already evaluated, publishes them when there are any, and backs off: runs
 * inside the backoff window publish nothing and make no archive request.
 */
export function makeFetchSites({
  store, searchArchive, sites = WATCHED_SITES, registryVersion = WATCHED_SITES_VERSION, budgetMs = RUN_BUDGET_MS,
  clock = Date.now, scoring = null, alerts = null, waterPercent = SITE_WATER_PERCENT,
}) {
  let pending = null;
  let shadow = CHANGE_SHADOW;
  async function fetchSites() {
    const nowMs = clock();
    const backoff = store.readBackoff ? await store.readBackoff() : null;
    if (backoff && nowMs < backoff.until) {
      return { publishBlocked: `archive backoff after ${backoff.refusals} refusal(s) until ${new Date(backoff.until).toISOString()}: ${backoff.reason}`, sites: {} };
    }
    const catalog = await store.readCatalog();
    if (!Array.isArray(catalog?.satellites) || catalog.satellites.length === 0) {
      throw markPreservableFetchFailure(new Error('orbital catalog is missing; the catalog seeder has not published'));
    }
    const previousIndex = await store.readIndex();
    const knownIds = [...new Set([...sites.map((site) => site.id), ...Object.keys(previousIndex?.sites ?? {})])];
    const previousRecords = await store.readRecords(knownIds);
    // The site pass leaves scoring at least its reserved share; scoring runs to the run deadline.
    const runDeadlineMs = nowMs + budgetMs;
    const changeReserveMs = scoring ? Math.min(scoring.budgetMs, budgetMs / 2) : 0;
    // Shadow flags are read in live mode too: leaving shadow continues from them.
    const change = scoring && makeChangeStage({
      concurrency: CHANGE_CONCURRENCY,
      ...scoring,
      deadlineMs: runDeadlineMs,
      clock,
      previousFlags: await store.readFlags(knownIds),
      exclusions: changeScoringExclusions(sites, waterPercent),
    });
    const evaluation = await evaluateSites({
      sites, catalog, previousRecords, cursor: previousIndex?.nextSiteId ?? null, searchArchive, nowMs, deadlineMs: runDeadlineMs - changeReserveMs, clock, change,
    });
    shadow = change ? change.shadow : CHANGE_SHADOW;
    const scoringRefused = evaluation.change?.haltKind === 'refusal' ? evaluation.change.halted : null;
    const refusal = evaluation.refused ?? scoringRefused;
    // The wait counts from the refusal, which can come minutes into the run.
    const newBackoff = refusal ? nextBackoff(backoff, refusal, clock()) : null;
    if (evaluation.refused && evaluation.records.size === 0) {
      await store.writeBackoff?.(newBackoff);
      return { publishBlocked: evaluation.refused, sites: {} };
    }
    if (evaluation.evaluated > 0 && evaluation.failed.length === evaluation.evaluated) {
      throw markPreservableFetchFailure(new Error(`archive search failed for all ${evaluation.evaluated} sites: ${evaluation.failed[0].reason}`));
    }
    if (evaluation.change?.shadow) {
      const flags = new Map(change.previousFlags);
      for (const [id, flag] of evaluation.flags) flags.set(id, flag);
      const registryIds = new Set(sites.map((site) => site.id));
      evaluation.change.exit = shadowExitStatus({
        shadowSince: previousIndex?.change?.exit?.shadowSince ?? nowMs,
        flags: [...flags.entries()].filter(([id]) => registryIds.has(id)).map(([, flag]) => flag),
        nowMs,
      });
    }
    pending = { ...planPublication({ sites, registryVersion, previousIndex, previousRecords, evaluation, nowMs }), backoff: newBackoff, clearBackoff: !newBackoff && Boolean(backoff) };
    console.log(`  Sites evaluated: ${evaluation.evaluated} of ${sites.length} (${evaluation.failed.length} kept after archive failure); next: ${evaluation.nextSiteId ?? 'full pass'}; countries: ${pending.rollupWrites.length}; deleted keys: ${pending.deletes.length}`);
    if (evaluation.refused) console.warn(`  ARCHIVE REFUSED: ${evaluation.refused}; kept ${evaluation.records.size} evaluated sites, backing off until ${new Date(newBackoff.until).toISOString()}`);
    const c = evaluation.change;
    if (c) {
      console.log(`  Change scoring${c.shadow ? ' (shadow)' : ''}: ${c.scoredSites} sites, ${c.unfinishedSites} unfinished${c.lastStopReason ? ` (last: ${c.lastStopReason})` : ''}, ${c.skippedSites} skipped, ${c.excludedSites} excluded (water or duplicate), ${c.skippedScenes} scenes skipped after repeated failures, ${c.statisticsRequests} statistics requests${c.halted ? `; halted: ${c.halted}` : ''}`);
      if (c.exit) console.log(`  Shadow exit rule (R26): ${c.exit.ready ? 'met; review the confirmed flags before setting CHANGE_SHADOW to false' : `not met (${c.exit.blockers.join('; ')})`}`);
      if (c.halted && c.haltKind !== 'refusal') console.error(`  CHANGE SCORING HALTED: ${c.halted}`);
    }
    return pending.index;
  }
  async function publishAtomically(_index, context) {
    await store.write(publicationCommands(pending, context));
    if (!alerts) return;
    try {
      const summary = await alerts(pending.siteWrites, { shadow });
      if (summary) console.log(`  Orbital alerts: ${summary.published} queued, ${summary.failed} failed${shadow ? '; change alerts held (shadow)' : ''}`);
    } catch (error) {
      console.warn(`  Orbital alerts failed: ${error.message}`);
    }
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
    declareRecords: freshSiteCount,
    sourceVersion: 'planetary-computer-stac',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    fetchPhaseTimeoutMs: RUN_BUDGET_MS + 60_000,
    lockTtlMs: RUN_BUDGET_MS + 3 * 60_000,
  };
}

/** Orbital Watch ships dark (#10710): watched-site seeding waits for the launch flag. */
export const orbitalSitesEnabled = (env = process.env) => (env.ORBITAL_WATCH_ENABLED ?? '').trim().toLowerCase() === 'true';

if (isMainModule(import.meta.url, process.argv[1]) && !orbitalSitesEnabled()) {
  console.log('  SKIPPED: Orbital Watch ships dark (#10710); set ORBITAL_WATCH_ENABLED=true to seed watched sites');
} else if (isMainModule(import.meta.url, process.argv[1])) {
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
    alerts: redisSiteAlerts(),
  });
  runSeed('orbital', 'sites', ORBITAL_SITES_KEY, fetchSites, buildSeedOptions(publishAtomically)).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
