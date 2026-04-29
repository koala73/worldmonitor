#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  logSeedResult,
  readSeedSnapshot,
  resolveProxyForConnect,
  httpsProxyFetchRaw,
} from './_seed-utils.mjs';
import { createCountryResolvers } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const KEY_PREFIX = 'supply_chain:portwatch-ports:v1:';
const META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const LOCK_DOMAIN = 'supply_chain:portwatch-ports';
// 60 min — covers the widest realistic run of this standalone service.
const LOCK_TTL_MS = 60 * 60 * 1000;
const TTL = 259_200; // 3 days — 6× the 12h cron interval
const MIN_VALID_COUNTRIES = 50;

const EP3_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';
const EP4_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query';

const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 45_000;
// Two aggregation windows, hardcoded in fetchCountryAccum:
//   last30 = days  0-30 → tankerCalls30d, avg30d, import/export sums
//   prev30 = days 30-60 → trendDelta baseline
// Any change to these window sizes must update BOTH the WHERE clauses
// in paginateWindowInto callers AND the cutoff* math in fetchCountryAccum.
const MAX_PORTS_PER_COUNTRY = 50;

// Per-country budget. ArcGIS's ISO3 index makes per-country fetches O(rows-in-country),
// which is fine for most countries but heavy ones (USA ~313k historic rows, CHN/IND/RUS
// similar) can push 60-90s when the server is under load. Promise.allSettled would
// otherwise wait for the slowest, stalling the whole batch.
const PER_COUNTRY_TIMEOUT_MS = 90_000;
const CONCURRENCY = 12;
const BATCH_LOG_EVERY = 5;
// Cache hygiene: force a full refetch if the cached payload is older than 7 days
// even when upstream maxDate is unchanged. Protects against window-shift drift
// (cached aggregates were computed against a window that's now 7+ days offset
// from today's last30/prev30 cutoffs) and serves as a belt-and-braces refresh
// if the maxDate check ever silently short-circuits.
const MAX_CACHE_AGE_MS = 7 * 86_400_000;
// Concurrency for the cheap per-country maxDate preflight. These are tiny
// outStatistics queries (returns 1 row), so we can push harder than the
// expensive fetch concurrency without tripping ArcGIS 429s in practice.
const PREFLIGHT_CONCURRENCY = 24;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

async function fetchWithTimeout(url, { signal } = {}) {
  // Combine the per-call FETCH_TIMEOUT with the upstream caller signal so an
  // abort propagates into the in-flight fetch AND future pagination iterations.
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)])
    : AbortSignal.timeout(FETCH_TIMEOUT);
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: combined,
  });
  if (resp.status === 429) {
    const proxyAuth = resolveProxyForConnect();
    if (!proxyAuth) throw new Error(`ArcGIS HTTP 429 (rate limited) for ${url.slice(0, 80)}`);
    console.warn(`  [portwatch] 429 rate-limited — retrying via proxy: ${url.slice(0, 80)}`);
    const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: FETCH_TIMEOUT, signal });
    const proxied = JSON.parse(buffer.toString('utf8'));
    if (proxied.error) throw new Error(`ArcGIS error (via proxy): ${proxied.error.message}`);
    return proxied;
  }
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
  return body;
}

// ArcGIS's Daily_Ports_Data FeatureServer intermittently returns "Cannot
// perform query. Invalid query parameters." for otherwise-valid queries —
// observed in prod 2026-04-20 for BRA/IDN/NGA on per-country WHERE, and
// also for the global WHERE after the PR #3225 rollout. A single retry with
// a short back-off clears it in practice. No retry loop — one attempt
// bounded. Does not retry any other error class.
//
// IMPORTANT: a 100%-batch-rejected version of this error is NOT a flake —
// it's an upstream schema-rename (e.g. `date` → `date_` on 2026-04-29 via
// IMF's reserved-keyword sweep, see fetchAll's first-batch circuit-breaker).
// The single-retry assumption only holds for sporadic 3-of-N rejections;
// the circuit-breaker handles the global-regression case to avoid burning
// 30s of doomed work per cron tick.
async function fetchWithRetryOnInvalidParams(url, { signal } = {}) {
  try {
    return await fetchWithTimeout(url, { signal });
  } catch (err) {
    const msg = err?.message || '';
    if (!/Invalid query parameters/i.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    if (signal?.aborted) throw signal.reason ?? err;
    console.warn(`  [port-activity] retrying after "${msg}": ${url.slice(0, 80)}`);
    return await fetchWithTimeout(url, { signal });
  }
}

// Fetch ALL ports globally in one paginated pass, grouped by ISO3.
// ArcGIS server-cap: advance by actual features.length, never PAGE_SIZE.
async function fetchAllPortRefs({ signal } = {}) {
  const byIso3 = new Map();
  let offset = 0;
  let body;
  let page = 0;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    page++;
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'portid,ISO3,lat,lon',
      returnGeometry: 'false',
      orderByFields: 'portid ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithRetryOnInvalidParams(`${EP4_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (a?.portid == null || !a?.ISO3) continue;
      const iso3 = String(a.ISO3);
      const portId = String(a.portid);
      let ports = byIso3.get(iso3);
      if (!ports) { ports = new Map(); byIso3.set(iso3, ports); }
      ports.set(portId, { lat: Number(a.lat ?? 0), lon: Number(a.lon ?? 0) });
    }
    console.log(`  [port-activity]   ref page ${page}: +${features.length} ports (${byIso3.size} countries so far)`);
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
  return byIso3;
}

// Paginate a single ArcGIS EP3 window into per-port accumulators. Called
// twice per country — once for each aggregation window (last30, prev30) —
// in parallel so heavy countries no longer have to serialise through both
// windows inside a single 90s cap.
async function paginateWindowInto(portAccumMap, iso3, where, windowKind, { signal } = {}) {
  let offset = 0;
  let body;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const params = new URLSearchParams({
      where,
      // IMF PortWatch renamed `date` → `date_` on 2026-04-29 (reserved-keyword
      // sweep, see ARCGIS_DATE_FIELD comment below). Field alias is still
      // "date" but the queryable name is `date_` — alias ≠ name in ArcGIS.
      outFields: 'portid,portname,ISO3,date_,portcalls_tanker,import_tanker,export_tanker',
      returnGeometry: 'false',
      orderByFields: 'portid ASC,date_ ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithRetryOnInvalidParams(`${EP3_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (!a || a.portid == null || a.date_ == null) continue;
      const portId = String(a.portid);
      const calls = Number(a.portcalls_tanker ?? 0);
      const imports = Number(a.import_tanker ?? 0);
      const exports_ = Number(a.export_tanker ?? 0);

      // JS is single-threaded; two concurrent paginateWindowInto calls never
      // hit the `get`/`set` pair here in interleaved fashion because there's
      // no `await` between them. So this is safe without a mutex.
      let acc = portAccumMap.get(portId);
      if (!acc) {
        acc = {
          portname: String(a.portname || ''),
          last30_calls: 0, last30_count: 0, last30_import: 0, last30_export: 0,
          prev30_calls: 0,
        };
        portAccumMap.set(portId, acc);
      }
      if (windowKind === 'last30') {
        acc.last30_calls += calls;
        acc.last30_count += 1;
        acc.last30_import += imports;
        acc.last30_export += exports_;
      } else {
        // windowKind === 'prev30'
        acc.prev30_calls += calls;
      }
    }
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
}

// Parse a "YYYY-MM-DD" string (from ArcGIS outStatistics max(date)) into an
// epoch-ms anchor used as the upper bound of the last30 window. Uses the
// END of the day (23:59:59.999 UTC) so rows dated exactly maxDate still
// satisfy `date <= anchor`. Returns null on parse failure; callers fall
// back to `Date.now()` when anchor is null.
function parseMaxDateToAnchor(maxDateStr) {
  if (!maxDateStr || typeof maxDateStr !== 'string') return null;
  const ts = Date.parse(maxDateStr + 'T23:59:59.999Z');
  return Number.isFinite(ts) ? ts : null;
}

// Fetch ONE country's activity rows, streaming into per-port accumulators.
// Splits into TWO parallel windowed queries:
//   - Q1 (last30): WHERE ISO3='X' AND date_ > cutoff30
//   - Q2 (prev30): WHERE ISO3='X' AND date_ > cutoff60 AND date_ <= cutoff30
// Each returns ~half the rows a single 60-day query would. Heavy countries
// (USA/CHN/etc.) drop from ~90s → ~30s because max(Q1,Q2) < Q1+Q2.
//
// The window ANCHOR is upstream max(date), not `Date.now()`. This makes the
// aggregate stable across cron runs whenever upstream hasn't advanced —
// which is essential for the H-path cache (see fetchAll). Without the
// anchor, rolling `now - 30d` windows shift every day even when upstream
// is frozen, so `tankerCalls30d` would drift day-over-day and cache reuse
// would serve stale aggregates. PR #3299 review P1.
//
// `last7` aggregation was removed: ArcGIS's Daily_Ports_Data max date lags
// ~10 days behind real-time, so the last-7-day window was always empty and
// anomalySignal always false. Not a feature regression — it was already dead.
//
// Returns Map<portId, PortAccum>. Memory per country is O(unique ports) ≈ <200.
async function fetchCountryAccum(iso3, { signal, anchorEpochMs } = {}) {
  const anchor = anchorEpochMs ?? Date.now();
  const cutoff30 = anchor - 30 * 86400000;
  const cutoff60 = anchor - 60 * 86400000;

  const portAccumMap = new Map();

  // ARCGIS_DATE_FIELD: queryable column is `date_`, not `date` — see comment
  // on outFields above. The `timestamp 'YYYY-MM-DD HH:MM:SS'` literal still
  // works on the new esriFieldTypeDateOnly column (verified 2026-04-29).
  await Promise.all([
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND date_ > ${epochToTimestamp(cutoff30)}`,
      'last30',
      { signal },
    ),
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND date_ > ${epochToTimestamp(cutoff60)} AND date_ <= ${epochToTimestamp(cutoff30)}`,
      'prev30',
      { signal },
    ),
  ]);

  return portAccumMap;
}

// Cheap preflight: single outStatistics query returning max(date) for one
// country. Used to skip the expensive fetch when upstream data hasn't
// advanced since the last cached run. ~1-2s per call at ArcGIS's current
// steady-state. Returns ISO date string "YYYY-MM-DD" or null on any error
// (we then fall through to the expensive path, which has its own retry).
async function fetchMaxDate(iso3, { signal } = {}) {
  const outStats = JSON.stringify([{
    statisticType: 'max',
    // See ARCGIS_DATE_FIELD comment in fetchCountryAccum: queryable name is
    // `date_`, not `date`. outStatisticFieldName is the response key —
    // unchanged on purpose so callers keep reading `attrs.max_date`.
    onStatisticField: 'date_',
    outStatisticFieldName: 'max_date',
  }]);
  const params = new URLSearchParams({
    where: `ISO3='${iso3}'`,
    outStatistics: outStats,
    f: 'json',
  });
  try {
    const body = await fetchWithRetryOnInvalidParams(`${EP3_BASE}?${params}`, { signal });
    const attrs = body.features?.[0]?.attributes;
    if (!attrs) return null;
    const raw = attrs.max_date;
    if (raw == null) return null;
    // ArcGIS may return max(date) as epoch ms OR ISO string depending on field type
    // (esriFieldTypeDate vs esriFieldTypeDateOnly). Normalize to YYYY-MM-DD.
    if (typeof raw === 'number') {
      const d = new Date(raw);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    return String(raw).slice(0, 10);
  } catch {
    return null;
  }
}

export function finalisePortsForCountry(portAccumMap, refMap) {
  const ports = [];
  for (const [portId, a] of portAccumMap) {
    // anomalySignal dropped: ArcGIS dataset max date lags 10+ days behind
    // real-time, so the last-7-day window always returned 0 rows and
    // anomalySignal was always false. Removed the dead aggregation in the
    // H+F refactor rather than plumbing a now-always-false field.
    const trendDelta = a.prev30_calls > 0
      ? Math.round(((a.last30_calls - a.prev30_calls) / a.prev30_calls) * 1000) / 10
      : 0;
    const coords = refMap.get(portId) || { lat: 0, lon: 0 };
    ports.push({
      portId,
      portName: a.portname,
      lat: coords.lat,
      lon: coords.lon,
      tankerCalls30d: a.last30_calls,
      trendDelta,
      importTankerDwt30d: a.last30_import,
      exportTankerDwt30d: a.last30_export,
      // Preserve field for downstream consumers but always false now.
      // TODO: Remove once UI stops reading it; ports.proto already tolerates
      // the missing field in future responses.
      anomalySignal: false,
    });
  }
  return ports
    .sort((x, y) => y.tankerCalls30d - x.tankerCalls30d)
    .slice(0, MAX_PORTS_PER_COUNTRY);
}

// Runs `doWork(signal)` but rejects if the per-country timer fires first,
// aborting the controller so the in-flight fetch (and its pagination loop)
// actually stops instead of orphaning. Keeps the CONCURRENCY cap real.
// Exported with an injectable timeoutMs so runtime tests can exercise the
// abort path at 40ms instead of the production 90s.
export function withPerCountryTimeout(doWork, iso3, timeoutMs = PER_COUNTRY_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`per-country timeout after ${timeoutMs / 1000}s (${iso3})`);
      try { controller.abort(err); } catch {}
      reject(err);
    }, timeoutMs);
  });
  const work = doWork(controller.signal);
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// MGET-style batch read via the Upstash REST /pipeline endpoint. Returns an
// array aligned with `keys` where each element is either the parsed JSON
// payload or null (for missing/unparseable/errored keys). Used to prime the
// per-country cache lookup in one round-trip instead of 174 sequential GETs.
async function redisMgetJson(keys) {
  if (keys.length === 0) return [];
  const commands = keys.map((k) => ['GET', k]);
  const results = await redisPipeline(commands);
  return results.map((r, idx) => {
    if (r?.error) return null;
    const raw = r?.result;
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch {
      console.warn(`  [port-activity] redisMget: skipping unparseable cached payload for ${keys[idx]}`);
      return null;
    }
  });
}

// fetchAll() — pure data collection, no Redis writes.
// Returns { countries: string[], countryData: Map<iso2, payload>, fetchedAt: string }.
//
// `progress` (optional) is mutated in-place so a SIGTERM handler in main()
// can report which batch / country we died on.
export async function fetchAll(progress, { signal } = {}) {
  const { iso3ToIso2 } = createCountryResolvers();

  if (progress) progress.stage = 'refs';
  console.log('  [port-activity] Fetching global port reference (EP4)...');
  const t0 = Date.now();
  const refsByIso3 = await fetchAllPortRefs({ signal });
  console.log(`  [port-activity] Refs loaded: ${refsByIso3.size} countries with ports (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const eligibleIso3 = [...refsByIso3.keys()].filter(iso3 => iso3ToIso2.has(iso3));
  const skipped = refsByIso3.size - eligibleIso3.length;

  // ─────────────────────────────────────────────────────────────────────────
  // Preflight: load every country's previous payload in one MGET pipeline.
  // Payloads written by this script since the H+F refactor carry an `asof`
  // (upstream max(date) at the time of the last successful fetch) and a
  // `cacheWrittenAt` (ms epoch). We re-use them as-is when both of the
  // following hold:
  //   1. upstream max(date) for the country is unchanged since `asof`
  //   2. `cacheWrittenAt` is within MAX_CACHE_AGE_MS
  // Either check failing → fall through to the expensive paginated fetch.
  //
  // Cold run (no cache / legacy payloads without asof) always falls through.
  // ─────────────────────────────────────────────────────────────────────────
  if (progress) progress.stage = 'cache-lookup';
  const cacheT0 = Date.now();
  const prevKeys = eligibleIso3.map((iso3) => `${KEY_PREFIX}${iso3ToIso2.get(iso3)}`);
  // A transient Upstash outage at run-start must NOT abort the seed before
  // any ArcGIS data is fetched — that's a regression from the previous
  // behaviour where Redis was only required at the final write. On MGET
  // failure, degrade to cold-path: treat every country as a cache miss
  // and re-fetch. The write at run-end will retry its own Redis calls
  // and fail loudly if Redis is genuinely down then too. PR #3299 review P1.
  const prevPayloads = await redisMgetJson(prevKeys).catch((err) => {
    console.warn(`  [port-activity] cache MGET failed (${err?.message || err}) — treating all countries as cache miss`);
    return new Array(prevKeys.length).fill(null);
  });
  console.log(`  [port-activity] Loaded ${prevPayloads.filter(Boolean).length}/${prevKeys.length} cached payloads (${((Date.now() - cacheT0) / 1000).toFixed(1)}s)`);

  // Preflight: maxDate check for every eligible country in parallel.
  // Each request is tiny (1 row outStatistics), so we push to PREFLIGHT_CONCURRENCY
  // which is higher than the expensive-fetch CONCURRENCY.
  if (progress) progress.stage = 'preflight';
  const preflightT0 = Date.now();
  const maxDates = new Array(eligibleIso3.length).fill(null);
  for (let i = 0; i < eligibleIso3.length; i += PREFLIGHT_CONCURRENCY) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const slice = eligibleIso3.slice(i, i + PREFLIGHT_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((iso3) => fetchMaxDate(iso3, { signal })),
    );
    for (let j = 0; j < slice.length; j++) {
      const r = settled[j];
      maxDates[i + j] = r.status === 'fulfilled' ? r.value : null;
    }
  }
  console.log(`  [port-activity] Preflight maxDate for ${eligibleIso3.length} countries (${((Date.now() - preflightT0) / 1000).toFixed(1)}s)`);

  // Partition: cache hits (reusable) vs misses (need expensive fetch).
  const countryData = new Map();
  const needsFetch = [];
  let cacheHits = 0;
  const now = Date.now();
  for (let i = 0; i < eligibleIso3.length; i++) {
    const iso3 = eligibleIso3[i];
    const iso2 = iso3ToIso2.get(iso3);
    const upstreamMaxDate = maxDates[i];
    const prev = prevPayloads[i];
    const cacheFresh = prev && typeof prev === 'object'
      && prev.asof === upstreamMaxDate
      && upstreamMaxDate != null
      && typeof prev.cacheWrittenAt === 'number'
      && (now - prev.cacheWrittenAt) < MAX_CACHE_AGE_MS;
    if (cacheFresh) {
      countryData.set(iso2, prev);
      cacheHits++;
    } else {
      needsFetch.push({ iso3, iso2, upstreamMaxDate });
    }
  }
  console.log(`  [port-activity] Cache: ${cacheHits} hits, ${needsFetch.length} misses`);

  // ─────────────────────────────────────────────────────────────────────────
  // Expensive path: paginated fetch for cache misses only.
  // ─────────────────────────────────────────────────────────────────────────
  if (progress) progress.stage = 'activity';
  const batches = Math.ceil(needsFetch.length / CONCURRENCY);
  if (progress) progress.totalBatches = batches;
  console.log(`  [port-activity] Activity queue: ${needsFetch.length} countries (skipped ${cacheHits} via cache, ${skipped} unmapped, concurrency ${CONCURRENCY}, per-country cap ${PER_COUNTRY_TIMEOUT_MS / 1000}s)`);

  const errors = progress?.errors ?? [];
  const activityStart = Date.now();

  for (let i = 0; i < needsFetch.length; i += CONCURRENCY) {
    const batch = needsFetch.slice(i, i + CONCURRENCY);
    const batchIdx = Math.floor(i / CONCURRENCY) + 1;
    if (progress) progress.batchIdx = batchIdx;

    const promises = batch.map(({ iso3, upstreamMaxDate }) => {
      // Anchor the rolling windows to upstream max(date) so the aggregate
      // is stable day-over-day when upstream is frozen (required for cache
      // reuse to be semantically correct — see PR #3299 review P1).
      // Falls back to Date.now() when preflight returned null.
      const anchorEpochMs = parseMaxDateToAnchor(upstreamMaxDate);
      const p = withPerCountryTimeout(
        (childSignal) => fetchCountryAccum(iso3, { signal: childSignal, anchorEpochMs }),
        iso3,
      );
      // Eager error flush so a SIGTERM mid-batch captures rejections that
      // have already fired, not only those that settled after allSettled.
      p.catch(err => errors.push(`${iso3}: ${err?.message || err}`));
      return p;
    });
    const settled = await Promise.allSettled(promises);

    for (let j = 0; j < batch.length; j++) {
      const { iso3, iso2, upstreamMaxDate } = batch[j];
      const outcome = settled[j];
      if (outcome.status === 'rejected') continue; // already recorded via .catch
      const portAccumMap = outcome.value;
      if (!portAccumMap || portAccumMap.size === 0) continue;
      const ports = finalisePortsForCountry(portAccumMap, refsByIso3.get(iso3));
      if (!ports.length) continue;
      countryData.set(iso2, {
        iso2,
        ports,
        fetchedAt: new Date().toISOString(),
        // Cache fields. `asof` may be null if preflight failed; that's fine —
        // next run will always be a miss (null !== any string) so we'll
        // re-fetch and repopulate.
        asof: upstreamMaxDate,
        cacheWrittenAt: Date.now(),
      });
    }

    if (progress) progress.seeded = countryData.size;
    if (batchIdx === 1 || batchIdx % BATCH_LOG_EVERY === 0 || batchIdx === batches) {
      const elapsed = ((Date.now() - activityStart) / 1000).toFixed(1);
      console.log(`  [port-activity]   batch ${batchIdx}/${batches}: ${countryData.size} countries published, ${errors.length} errors (${elapsed}s)`);
    }

    // Circuit-breaker: if batch 1 is ≥80% rejected with the SAME class of
    // error, treat it as an upstream global regression (schema rename, policy
    // change, dataset moved) — not a flake that more retries will clear.
    // Skip the remaining batches and let the catch-path extendExistingTtl
    // preserve prior payloads. Cuts failure cost ~30s → ~2s and keeps Sentry
    // signal-to-noise sane during incidents like the 2026-04-29 IMF
    // PortWatch `date` → `date_` rename.
    if (batchIdx === 1 && batches > 1 && batch.length >= 5) {
      const sameClassRate = errors.filter(e => /Invalid query parameters/i.test(e)).length / batch.length;
      if (sameClassRate >= 0.8) {
        console.error(
          `  [port-activity] CIRCUIT-BREAKER: ${(sameClassRate * 100).toFixed(0)}% of batch 1 rejected with "Invalid query parameters" — ` +
          `assuming upstream schema/policy regression. Skipping remaining ${batches - 1} batches; ` +
          `catch-path will extend TTLs on prior payloads. First error: ${errors[0]}`,
        );
        break;
      }
    }
  }

  if (errors.length) {
    console.warn(`  [port-activity] ${errors.length} country errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' ...' : ''}`);
  }

  if (countryData.size === 0) throw new Error('No country port data returned from ArcGIS');
  return { countries: [...countryData.keys()], countryData, fetchedAt: new Date().toISOString() };
}

export function validateFn(data) {
  return data && Array.isArray(data.countries) && data.countries.length >= MIN_VALID_COUNTRIES;
}

async function main() {
  const startedAt = Date.now();
  const runId = `portwatch-ports:${startedAt}`;

  console.log('=== supply_chain:portwatch-ports Seed ===');
  console.log(`  Run ID: ${runId}`);
  console.log(`  Key prefix: ${KEY_PREFIX}`);

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log(`  SKIPPED: another seed run in progress (lock: seed-lock:${LOCK_DOMAIN}, held up to ${LOCK_TTL_MS / 60000}min — will retry at next cron trigger)`);
    return;
  }

  // Hoist so the catch block can extend TTLs even when the error occurs before these are resolved.
  let prevCountryKeys = [];
  let prevCount = 0;

  // Shared progress object so the SIGTERM handler can report which batch /
  // stage we died in and what per-country errors have fired so far.
  const progress = { stage: 'starting', batchIdx: 0, totalBatches: 0, seeded: 0, errors: [] };

  // AbortController threaded through fetchAll → fetchCountryAccum → fetchWithTimeout
  // → _proxy-utils so a SIGTERM kill (or bundle-runner grace-window escalation)
  // actually stops any in-flight HTTP work.
  const shutdownController = new AbortController();

  let sigHandled = false;
  const onSigterm = async () => {
    if (sigHandled) return;
    sigHandled = true;
    try { shutdownController.abort(new Error('SIGTERM')); } catch {}
    console.error(
      `  [port-activity] SIGTERM at batch ${progress.batchIdx}/${progress.totalBatches} (stage=${progress.stage}) — ${progress.seeded} seeded, ${progress.errors.length} errors`,
    );
    if (progress.errors.length) {
      console.error(`  [port-activity] First errors: ${progress.errors.slice(0, 10).join('; ')}`);
    }
    console.error('  [port-activity] Releasing lock + extending TTLs');
    try {
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL);
    } catch {}
    try { await releaseLock(LOCK_DOMAIN, runId); } catch {}
    process.exit(1);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  try {
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
    prevCountryKeys = Array.isArray(prevIso2List) ? prevIso2List.map(iso2 => `${KEY_PREFIX}${iso2}`) : [];
    prevCount = Array.isArray(prevIso2List) ? prevIso2List.length : 0;

    console.log(`  Fetching port activity data (60d: last30 + prev30 windows)...`);
    const { countries, countryData } = await fetchAll(progress, { signal: shutdownController.signal });

    console.log(`  Fetched ${countryData.size} countries`);

    if (!validateFn({ countries })) {
      console.error(`  COVERAGE GATE FAILED: only ${countryData.size} countries, need >=${MIN_VALID_COUNTRIES}`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

    if (prevCount > 0 && countryData.size < prevCount * 0.8) {
      console.error(`  DEGRADATION GUARD: ${countryData.size} countries vs ${prevCount} previous — refusing to overwrite (need ≥${Math.ceil(prevCount * 0.8)})`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

    const metaPayload = { fetchedAt: Date.now(), recordCount: countryData.size };

    const commands = [];
    for (const [iso2, payload] of countryData) {
      commands.push(['SET', `${KEY_PREFIX}${iso2}`, JSON.stringify(payload), 'EX', TTL]);
    }
    commands.push(['SET', CANONICAL_KEY, JSON.stringify(countries), 'EX', TTL]);
    commands.push(['SET', META_KEY, JSON.stringify(metaPayload), 'EX', TTL]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('supply_chain', countryData.size, Date.now() - startedAt, { source: 'portwatch-ports' });
    console.log(`  Seeded ${countryData.size} countries`);
    console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
  } catch (err) {
    console.error(`  SEED FAILED: ${err.message}`);
    await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-port-activity.mjs');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
