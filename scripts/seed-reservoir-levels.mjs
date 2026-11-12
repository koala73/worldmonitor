#!/usr/bin/env node
// Strategic reservoir and lake water levels from NASA ICESat-2 lidar (ATL13, or ATL06 for
// entries with product "atl06").
//
// Daily bundle member of seed-bundle-climate. Each run starts from the committed
// backfill baseline (scripts/data/reservoir-levels-baseline.json) merged with the
// per-pass state kept in Redis, asks NASA CMR for granules newer than each reservoir's
// cursor, fetches a bounded number of them from SlideRule Earth, and recomputes the
// metrics for the whole watchlist.
//
// Observations arrive 50-70 days after acquisition and revisit varies by reservoir
// (a few days to about a month), so the age of the latest observation is a property of
// the data, not of this seeder. Health watches only the seeder's own run age.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DAY_MS,
  MISSION_START_ISO,
  bboxToPolygon,
  classifyPasses,
  computeChange,
  createPassAccumulator,
  fetchSegments,
  granuleDate,
  granuleRevision,
  granuleRgt,
  listGranules,
  mergePasses,
  passToTuple,
  productOf,
  tupleToPass,
} from './_reservoir-levels.mjs';
import {
  loadEnvFile,
  markPreservableFetchFailure,
  readCanonicalValue,
  runSeed,
} from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

export const RESERVOIR_LEVELS_KEY = 'climate:reservoir-levels:v1';
export const RESERVOIR_LEVELS_STATE_KEY = 'climate:reservoir-levels:passes:v1';
export const WATCHLIST_PATH = join(__dirname, 'data', 'strategic-reservoirs.json');
export const BASELINE_PATH = join(__dirname, 'data', 'reservoir-levels-baseline.json');
// Durable, no TTL: health reads it to end the first-publication grace for this new probe.
export const RESERVOIR_LEVELS_ACTIVATION_KEY = 'seed-activated:climate:reservoir-levels';

// Canonical TTL outlives the health budget (3 days) so last-good stays readable while
// health reports the outage. The state key lives longer: losing it only costs re-fetching
// granules since the baseline, but that takes several budget-limited runs.
export const CACHE_TTL_SECONDS = 7 * 24 * 3600;
export const STATE_TTL_SECONDS = 45 * 24 * 3600;
export const MAX_STALE_MIN = 4320; // 3x the daily cadence
export const STATE_SCHEMA = 1;

// Discovery searches acquisition dates this far behind the cursor, because NASA publishes
// granules 50-70 days after acquisition and not in acquisition order: a granule acquired
// before the newest processed one can appear weeks later. Already-processed names are
// skipped, so the wide window costs only CMR listing. Retention of processed names must
// exceed the window, or a pruned granule would be fetched again.
export const DISCOVERY_LOOKBACK_DAYS = 120;
export const PROCESSED_RETENTION_DAYS = 150;
export const MAX_GRANULE_FAILURES = 3;
// A reservoir whose CMR discovery fails this many consecutive runs is listed in the
// payload's discoveryFailing and left out of the health record count, so health reports
// partial coverage instead of staying green while that reservoir misses new granules.
export const DISCOVERY_ALERT_RUNS = 3;
export const MAX_GRANULES_PER_RUN = 150;
// ATL06 granules are budgeted separately: the box returns land as well as water, so a
// granule carries about 10x the rows of ATL13 and takes longer to subset. Measured on the
// public cluster (2026-11-11, 5-granule batches, 3 streams at once, 8 boxes): median
// 1.2 s per granule, 90th percentile 3.6 s, maximum 4.6 s. 20 granules therefore cost
// at most about 90 s of one stream inside the 7-minute fetch budget, while an ATL06 box
// gains only about 8 granules a year.
export const MAX_ATL06_GRANULES_PER_RUN = 20;
export const CMR_CONCURRENCY = 4;
export const CMR_RUN_TIMEOUT_MS = 20_000;
export const SLIDERULE_CONCURRENCY = 3;
export const RUN_FETCH_BUDGET_MS = 7 * 60 * 1000;
export const MIN_LATEST_SHARE = 0.8;

export const SOURCE = Object.freeze({
  name: 'NASA ICESat-2 ATL13 and ATL06 (NSIDC), processed via SlideRule Earth',
  product: 'ATL13 v007 inland water surface height; ATL06 v007 land ice height for reservoirs ATL13 covers poorly',
  // ICESat-2 product catalog: it lists both ATL13 and ATL06.
  url: 'https://nsidc.org/data/icesat-2',
  processing: 'https://slideruleearth.io',
});

export const METHODOLOGY = 'Water-surface height from ICESat-2 laser altimetry (ATL13), in metres above the EGM2008 geoid. '
  + 'Each value is the median of the segments one satellite overpass records inside a fixed open-water box on the reservoir. '
  + 'A few reservoirs that ATL13 covers poorly use ATL06 instead, read from the lowest flat cluster of heights in the box. '
  + 'Passes with fewer than 5 segments, a median absolute deviation above 0.25 m, beams disagreeing by more than 0.3 m, '
  + 'or a jump from the line through their neighbours are dropped. This is a lake level, not a storage volume. '
  + 'Data reach NASA 50 to 70 days after the overpass and revisit ranges from a few days to about a month by reservoir. '
  + 'Validated against the USBR Lake Mead gauge.';

export function loadWatchlist(path = WATCHLIST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).reservoirs;
}

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
//
// State shape (Redis key climate:reservoir-levels:passes:v1):
//   { schema, updatedAt, byId: { <id>: {
//       passes: [[timeIso, rgt, levelM, madM, n, beamSpreadM|null], ...],  raw pass stats
//       cursor: 'YYYY-MM-DD' | null,       newest processed granule acquisition date
//       processed: [granule, ...],         processed granules newer than cursor - 120 d
//       failures: { granule: count },      failed runs per granule still being retried
//       gaveUp: [granule, ...]             granules dropped after 3 failed runs (pruned like processed)
//   } } }

function emptyReservoirState() {
  return { passes: [], cursor: null, processed: [], failures: {}, gaveUp: [] };
}

function maxDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Merge two per-reservoir states. Commutative and idempotent. */
export function mergeReservoirState(a, b) {
  const x = { ...emptyReservoirState(), ...(a || {}) };
  const y = { ...emptyReservoirState(), ...(b || {}) };
  const passes = mergePasses(x.passes.map(tupleToPass), y.passes.map(tupleToPass)).map(passToTuple);
  const processed = new Set([...x.processed, ...y.processed]);
  const gaveUp = new Set([...x.gaveUp, ...y.gaveUp].filter((g) => !processed.has(g)));
  const failures = {};
  for (const src of [x.failures, y.failures]) {
    for (const [g, c] of Object.entries(src || {})) {
      if (processed.has(g) || gaveUp.has(g)) continue;
      failures[g] = Math.max(failures[g] || 0, Number(c) || 0);
    }
  }
  const out = {
    passes,
    cursor: maxDate(x.cursor, y.cursor),
    processed: [...processed].sort(),
    failures,
    gaveUp: [...gaveUp].sort(),
  };
  const discoveryFailedRuns = Math.max(Number(x.discoveryFailedRuns) || 0, Number(y.discoveryFailedRuns) || 0);
  if (discoveryFailedRuns > 0) out.discoveryFailedRuns = discoveryFailedRuns;
  return out;
}

export function baselineToState(baseline, watchlist) {
  const byId = {};
  for (const e of watchlist) {
    const r = baseline?.reservoirs?.[e.id];
    byId[e.id] = r
      ? { ...emptyReservoirState(), passes: r.passes || [], cursor: r.processedThrough ?? null, failures: { ...(r.failedGranules || {}) } }
      : emptyReservoirState();
  }
  return byId;
}

/** Combine the committed baseline with the previous Redis state for every watchlist entry. */
export function mergeState(baseline, previous, watchlist) {
  const base = baselineToState(baseline, watchlist);
  const prev = previous && previous.schema === STATE_SCHEMA && previous.byId ? previous.byId : {};
  const byId = {};
  for (const e of watchlist) byId[e.id] = mergeReservoirState(base[e.id], prev[e.id]);
  return byId;
}

/** Drop bookkeeping that can no longer matter: granules older than cursor - retention. */
export function pruneReservoirState(s) {
  if (!s.cursor) return s;
  const floor = new Date(Date.parse(s.cursor) - PROCESSED_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const keep = (g) => (granuleDate(g) || '') >= floor;
  return { ...s, processed: s.processed.filter(keep), gaveUp: s.gaveUp.filter(keep) };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Pick granules to fetch this run: per reservoir, retries of failed granules first, then
 * new granules oldest first. Round-robin across reservoirs so none starves, capped at
 * `budget` granules in total.
 */
export function planFetches(queues, budget = MAX_GRANULES_PER_RUN) {
  const picked = new Map();
  const ids = [...queues.keys()];
  const cursors = new Map(ids.map((id) => [id, 0]));
  let total = 0;
  let progress = true;
  while (total < budget && progress) {
    progress = false;
    for (const id of ids) {
      if (total >= budget) break;
      const q = queues.get(id);
      const i = cursors.get(id);
      if (i >= q.length) continue;
      if (!picked.has(id)) picked.set(id, []);
      picked.get(id).push(q[i]);
      cursors.set(id, i + 1);
      total++;
      progress = true;
    }
  }
  return picked;
}

export function granuleQueue(state, listed) {
  const processed = new Set(state.processed);
  const gaveUp = new Set(state.gaveUp);
  const retries = Object.keys(state.failures || {}).filter((g) => !processed.has(g) && !gaveUp.has(g)).sort();
  const fresh = listed.filter((g) => !processed.has(g) && !gaveUp.has(g) && !(g in (state.failures || {})));
  return [...retries, ...fresh];
}

// ---------------------------------------------------------------------------
// Summary payload
// ---------------------------------------------------------------------------

/** Per-entry despike override (see classifyPasses); absent means the shared default. */
export const despikeOpts = (e) => (e.despikePerGapDayM != null ? { perGapDayM: e.despikePerGapDayM } : {});

const WATCHLIST_FIELDS = ['id', 'name', 'country', 'riparians', 'river', 'lat', 'lon', 'tags', 'why'];

export function buildSummary(watchlist, byId, nowMs) {
  const reservoirs = watchlist.map((e) => {
    const passes = classifyPasses((byId[e.id]?.passes || []).map(tupleToPass), despikeOpts(e));
    const m = computeChange(passes, nowMs);
    const out = {};
    for (const f of WATCHLIST_FIELDS) out[f] = e[f];
    return { ...out, ...m };
  });
  return {
    reservoirs,
    fetchedAt: nowMs,
    source: SOURCE,
    methodology: METHODOLOGY,
    discoveryFailing: watchlist
      .filter((e) => (byId[e.id]?.discoveryFailedRuns || 0) >= DISCOVERY_ALERT_RUNS)
      .map((e) => e.id),
  };
}

export function countWithLatest(data) {
  return Array.isArray(data?.reservoirs) ? data.reservoirs.filter((r) => r?.latest).length : 0;
}

/** Health record count: reservoirs with a level whose granule discovery is not failing. */
export function countTracked(data) {
  const failing = new Set(Array.isArray(data?.discoveryFailing) ? data.discoveryFailing : []);
  return Array.isArray(data?.reservoirs) ? data.reservoirs.filter((r) => r?.latest && !failing.has(r.id)).length : 0;
}

export function makeValidate(watchlistSize) {
  return (data) => countWithLatest(data) >= Math.ceil(MIN_LATEST_SHARE * watchlistSize);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

// An upstream outage: runSeed keeps last-good, does not refresh seed-meta, and does not
// retry the whole run (nonRetryable), since every request already retried.
function outage(message) {
  const err = markPreservableFetchFailure(new Error(message));
  err.nonRetryable = true;
  return err;
}

/**
 * Tag each new pass with the release revision of the granule it came from (same RGT,
 * acquisition date within a day), so a reprocessed granule replaces the older values.
 */
export function withRevisions(passes, granules) {
  return passes.map((p) => {
    let revision = 1;
    for (const g of granules) {
      if (granuleRgt(g) !== p.rgt) continue;
      const gd = granuleDate(g);
      if (gd && Math.abs(Date.parse(gd) - Date.parse(p.date)) <= DAY_MS) revision = Math.max(revision, granuleRevision(g) ?? 1);
    }
    return { ...p, revision };
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * One seeder run. Injectable for tests: fetchImpl (CMR + SlideRule), readState (previous
 * Redis state or null; must throw if Redis cannot be read), nowMs, baseline, watchlist.
 * Returns the raw payload: summary fields plus `_state` (written to the state key and
 * stripped from the canonical key). Throws a preservable failure when the upstreams were
 * unreachable, so runSeed keeps last-good and does not refresh seed-meta.
 */
export async function fetchReservoirLevels({
  fetchImpl = (...a) => globalThis.fetch(...a),
  readState = () => readCanonicalValue(RESERVOIR_LEVELS_STATE_KEY, { strict: true }),
  nowMs = Date.now(),
  baseline = loadBaseline(),
  watchlist = loadWatchlist(),
  budget = MAX_GRANULES_PER_RUN,
  atl06Budget = MAX_ATL06_GRANULES_PER_RUN,
  deadlineAtMs = Date.now() + RUN_FETCH_BUDGET_MS,
  log = console.log,
} = {}) {
  const previous = await readState();
  const byId = mergeState(baseline, previous, watchlist);
  const priorDiscoveryFailedRuns = new Map(watchlist.map((e) => [e.id, byId[e.id].discoveryFailedRuns || 0]));

  // 1. Discover granules per reservoir. The first reservoir doubles as a reachability
  // probe so a CMR outage fails in one timeout instead of one per reservoir.
  let cmrFailures = 0;
  const queues = new Map();
  const discoveryFailed = new Set();
  const discover = async (e) => {
    const s = byId[e.id];
    const since = s.cursor
      ? new Date(Date.parse(s.cursor) - DISCOVERY_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10)
      : MISSION_START_ISO;
    try {
      const listed = await listGranules(e.core, since, fetchImpl, { retries: 2, retryDelayMs: 1000, timeoutMs: CMR_RUN_TIMEOUT_MS, product: productOf(e).id });
      queues.set(e.id, granuleQueue(s, listed));
      return true;
    } catch (err) {
      cmrFailures++;
      discoveryFailed.add(e.id);
      log(`  [${e.id}] CMR failed: ${err?.message || err}`);
      queues.set(e.id, granuleQueue(s, []));
      return false;
    }
  };
  if (watchlist.length && !(await discover(watchlist[0]))) {
    throw outage(`CMR unreachable (first reservoir ${watchlist[0].id})`);
  }
  await mapLimit(watchlist.slice(1), CMR_CONCURRENCY, discover);
  if (cmrFailures === watchlist.length) throw outage(`CMR unreachable for all ${watchlist.length} reservoirs`);

  // 2. Fetch a bounded, round-robin selection from SlideRule, with separate budgets for
  // ATL13 and the larger ATL06 granules.
  const queuesFor = (productId) => new Map(watchlist.filter((e) => productOf(e).id === productId).map((e) => [e.id, queues.get(e.id) || []]));
  const plan = new Map([...planFetches(queuesFor('atl13'), budget), ...planFetches(queuesFor('atl06'), atl06Budget)]);
  const planned = [...plan.values()].reduce((n, g) => n + g.length, 0);
  let okBatches = 0;
  let failedBatches = 0;
  let attempted = 0;
  let succeeded = 0;
  let skippedForTime = 0;
  // ATL06 entries start first: they are few and capped by their own budget, and in
  // watchlist order they would sit behind ATL13 work that can run past the deadline.
  const planned06 = (e) => productOf(e).id === 'atl06';
  const entries = [...watchlist.filter((e) => plan.has(e.id) && planned06(e)), ...watchlist.filter((e) => plan.has(e.id) && !planned06(e))];
  await mapLimit(entries, SLIDERULE_CONCURRENCY, async (e) => {
    const granules = plan.get(e.id);
    if (Date.now() > deadlineAtMs) { skippedForTime += granules.length; return; }
    const product = productOf(e).id;
    const acc = createPassAccumulator({ refid: e.refid ?? null, product, levelWindow: e.levelWindowM ?? null });
    const r = await fetchSegments(bboxToPolygon(e.core), granules, (row) => acc.add(row), fetchImpl, {
      product,
      deadlineAtMs,
      log: (m) => log(`  [${e.id}]${m}`),
    });
    skippedForTime += r.skipped.length;
    okBatches += r.okBatches;
    failedBatches += r.failedBatches;
    attempted += r.processed.length + r.failed.length;
    succeeded += r.processed.length;
    const s = byId[e.id];
    const fresh = withRevisions(acc.finish(), r.processed);
    const processed = new Set([...s.processed, ...r.processed]);
    const failures = { ...s.failures };
    const gaveUp = new Set(s.gaveUp);
    for (const g of r.processed) delete failures[g];
    for (const g of r.failed) {
      failures[g] = (failures[g] || 0) + 1;
      if (failures[g] >= MAX_GRANULE_FAILURES) { gaveUp.add(g); delete failures[g]; }
    }
    let cursor = s.cursor;
    for (const g of r.processed) cursor = maxDate(cursor, granuleDate(g));
    byId[e.id] = pruneReservoirState({
      passes: mergePasses(s.passes.map(tupleToPass), fresh).map(passToTuple),
      cursor,
      processed: [...processed].sort(),
      failures,
      gaveUp: [...gaveUp].sort(),
    });
    log(`  [${e.id}] ${r.processed.length}/${granules.length} granules, +${fresh.length} passes`);
  });
  // Outage = no request reached a working SlideRule. Per-granule server errors inside a
  // completed request are partial success (retried next run, dropped after three runs).
  if (failedBatches > 0 && okBatches === 0) throw outage(`SlideRule failed for all ${failedBatches} requests`);
  // Planned work that never started (slow discovery spent the run deadline) is not a
  // refresh: publishing would advance freshness and the completion marker on unchanged
  // data and delay the next attempt.
  if (planned > 0 && attempted === 0) throw outage(`no SlideRule request started for ${planned} planned granules before the run deadline`);
  log(`  granules: planned ${planned}, fetched ${succeeded}/${attempted}, deferred for time ${skippedForTime}`);

  // Consecutive discovery failures per reservoir; one successful listing resets the count.
  for (const e of watchlist) {
    const { discoveryFailedRuns: _drop, ...rest } = byId[e.id];
    byId[e.id] = discoveryFailed.has(e.id) ? { ...rest, discoveryFailedRuns: priorDiscoveryFailedRuns.get(e.id) + 1 } : rest;
  }
  const summary = buildSummary(watchlist, byId, nowMs);
  return {
    ...summary,
    _state: { schema: STATE_SCHEMA, updatedAt: nowMs, byId },
  };
}

export function stripState(data) {
  if (!data || typeof data !== 'object') return data;
  const { _state, ...rest } = data;
  return rest;
}

export function declareRecords(data) {
  return countTracked(data);
}

export function buildSeedOptions(watchlistSize = loadWatchlist().length) {
  return {
    validateFn: makeValidate(watchlistSize),
    ttlSeconds: CACHE_TTL_SECONDS,
    recordCount: countTracked,
    publishTransform: stripState,
    declareRecords,
    sourceVersion: 'icesat2-atl13-atl06-v007-sliderule-core-box-v2',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    lockTtlMs: 9 * 60 * 1000,
    extraKeys: [{
      key: RESERVOIR_LEVELS_STATE_KEY,
      ttl: STATE_TTL_SECONDS,
      transform: (data) => data._state,
      declareRecords: (state) => Object.keys(state?.byId || {}).length,
    }],
    // runSeed calls this only after the canonical key, the state key and seed-meta are written.
    afterFreshness: async () => {
      const creds = getOptionalUpstashCreds();
      if (!creds) throw new Error('Missing reservoir levels activation credentials');
      await upstashCommand(creds, ['SET', RESERVOIR_LEVELS_ACTIVATION_KEY, '1']);
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed('climate', 'reservoir-levels', RESERVOIR_LEVELS_KEY, ({ fetchDeadlineAtMs } = {}) => fetchReservoirLevels({
    // Leave room for publishing after the last SlideRule batch returns.
    deadlineAtMs: Math.min(Date.now() + RUN_FETCH_BUDGET_MS, (fetchDeadlineAtMs ?? Infinity) - 3 * 60 * 1000),
  }), buildSeedOptions()).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
