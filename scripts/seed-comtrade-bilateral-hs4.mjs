#!/usr/bin/env node

// @ts-check

import { createRequire } from 'node:module';
import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  sleep,
} from './_seed-utils.mjs';
import { HS4_CODES, HS4_BATCHES, PREVIEW_MAX_RECORDS, parseRecords, groupByProduct, groupWorldExports, toCanonicalProduct, toPartnersProduct, comtradeFailureState } from './shared/comtrade.mjs';
export { HS4_CODES, MAX_HS4_CODES_PER_BATCH, groupByProduct } from './shared/comtrade.mjs';
import { candidatePeriods, periodWindow, recentPeriod } from './shared/comtrade-period.mjs';

// Re-exported so existing importers (tests, sibling seeders) keep one source.
export { recentPeriod, candidatePeriods };

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);

const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
// Sibling of the canonical key, holding the threshold partner list with weight
// and quantity. It exists because three scorers sum over every canonical
// `topExporters` row and two bulk readers pull all 197 canonical keys in one
// pipeline under a 4.5 MB ceiling, so the deeper evidence cannot ride along.
// Only get-country-products reads it.
const PARTNERS_KEY_PREFIX = 'comtrade:bilateral-hs4-partners:';
// One key for the whole run: every reporter's exports of every reviewed heading,
// so the brief can state a supplier's absolute scale and its world rank.
const WORLD_EXPORTS_KEY = 'comtrade:world-exports-hs4:v1';
const TTL_SECONDS = 3456000; // 40d: monthly cadence + 9d deploy/missed-tick slack
const LOCK_DOMAIN = 'comtrade:bilateral-hs4';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

// Freshness gate: skip the run if seed-meta says we re-seeded recently.
// Mirrors _bundle-runner.mjs:240's `elapsed < intervalMs * 0.8` pattern so
// the gate lives in code regardless of the Railway cron cadence or any
// future Watch-Paths filter changes.
//
// VERIFIED 2026-07-27 against the Railway API: the `seed-comtrade-bilateral-hs4`
// service's cronSchedule is `0 6 1 * *` — 06:00 on the 1st, monthly. So the
// real gap between ticks is 28-31 days and this 24d gate always clears before
// the next scheduled run; it never blocks one. Re-check this if the schedule
// is ever edited, because every constant here is sized against it:
//   gate 24d < shortest month 28d      -> a scheduled run is never skipped
//   maxStaleMin 35d > longest month 31d -> no false STALE_SEED between runs
//   ~394 calls x 1 run/month           -> fits the 500/month quota
//
// Belt-and-suspenders against the UN Comtrade Free APIs 500 calls/month quota
// (~394 calls per run with a single COMTRADE_API_KEYS entry). Also verified
// 2026-07-27: this is the ONLY scheduled consumer of that keyed quota.
// seed-trade-flows runs daily but on the unauthenticated
// `public/v1` preview route, and seed-recovery-import-hhi /
// seed-recovery-reexport-share do use the keyed `data/v1/get` route but have
// no Railway service running them.
// Override for force-reseed scenarios: FORCE_RESEED=true bypasses the gate.
export const FRESHNESS_GATE_MS = 24 * 24 * 60 * 60 * 1000;

// seed-meta TTL must outlive the freshness gate by at least one cron tick
// of slack. Otherwise Redis evicts the key between SEED_META_TTL_SECONDS
// and FRESHNESS_GATE_MS / 1000, opening a fail-open window where the gate
// silently lets every cron tick through. Pre-fix (Greptile review on
// PR #3661): meta TTL was TTL_SECONDS * 3 = 9d while gate = 24d, leaving
// days 9-24 unprotected — if the cron ever flipped back to daily, those
// 15 days would burn ~6,000 calls against the 500/mo quota.
//
// Keep metadata for the same 40-day continuity window as the country shards.
// Health turns stale at 35d, leaving five days where a missed run is visible
// as STALE_SEED while the last good country payloads remain queryable.
export const SEED_META_TTL_SECONDS = Math.max(
  TTL_SECONDS,
  Math.ceil(FRESHNESS_GATE_MS / 1000) + 86_400,
);

// Coverage floor: below this many seeded countries a run is "partial", not a
// success. seed-meta records status 'partial', and /api/health declares the
// same number as minRecordCount so a shrunken snapshot reads COVERAGE_PARTIAL
// instead of OK — without it, 3-of-197 and 197-of-197 were indistinguishable
// for the whole 35-day staleness window.
//
// Deliberately NOT wired to the freshness gate. Letting a partial run reopen
// the gate looks like faster recovery but is a quota trap: quota exhaustion is
// itself a cause of 'partial', so the degraded state would feed itself and
// retrigger a full ~394-call run on every tick.
//
// 110 of the 197 country-port-clusters entries (~56%). Deliberately loose: the
// true healthy count is unmeasured, and a floor above it would warn forever —
// the trap that makes operators ignore a signal. Sized to catch a collapse,
// not to certify full coverage. Keep in step with api/health.js + seed-health.js.
export const MIN_COUNTRY_COVERAGE = 110;

/**
 * The run's verdict on its own coverage, as a pure predicate so the decision is
 * unit-testable without driving all of main().
 * @param {number} writtenCount
 * @returns {'ok' | 'partial'}
 */
export function coverageStatus(writtenCount) {
  return writtenCount >= MIN_COUNTRY_COVERAGE ? 'ok' : 'partial';
}

// How many consecutive runs a country's payload may be kept alive by TTL
// refresh alone. Past this it is allowed to expire, so the on-demand lazy
// fallback can re-probe instead of being short-circuited by an immortal
// payload that no consumer age-checks.
export const MAX_PRESERVE_RUNS = 2;

// Pipeline flush ceilings, whichever is reached first. The command count alone
// was enough while a country wrote one ~20 KB payload; the sibling partner key
// roughly triples that, so 50 commands would post a multi-megabyte body.
export const MAX_PIPELINE_COMMANDS = 50;
export const MAX_PIPELINE_BYTES = 1_048_576; // 1 MB of accumulated payload

const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
function getNextKey() {
  if (COMTRADE_KEYS.length === 0) return '';
  const key = COMTRADE_KEYS[keyIndex % COMTRADE_KEYS.length];
  keyIndex++;
  return key;
}

const usePublicApi = COMTRADE_KEYS.length === 0;
const COMTRADE_API_CLASSIFIER = 'HS'; // API route family; metadata tracks the active H6/HS2022 revision separately.
const COMTRADE_FETCH_URL = usePublicApi
  ? `https://comtradeapi.un.org/public/v1/preview/C/A/${COMTRADE_API_CLASSIFIER}`
  : `https://comtradeapi.un.org/data/v1/get/C/A/${COMTRADE_API_CLASSIFIER}`;
const INTER_REQUEST_DELAY_MS = usePublicApi ? 3500 : 1500;
// One cap for the request and the truncation check: a response that fills it
// may be truncated, so it is recorded as incomplete instead of published.
const MAX_RECORDS = usePublicApi ? PREVIEW_MAX_RECORDS : 100_000;

// A full country pass at 2 requests/country is ~396 authenticated calls against
// UN Comtrade's 500/mo Free APIs quota. The (y-3) fallback below doubles that
// for any reporter empty on (y-2), so cap total requests with slack under the
// cap rather than risk a bad month (e.g. many slow filers) blowing the quota.
export const REQUEST_BUDGET = Number(process.env.COMTRADE_REQUEST_BUDGET) || 480;

// Comtrade annual data lags across reporters. Without an explicit period the
// API currently returns HTTP 200 with count=0, so every country is silently
// dropped. Pin the newest safely-final year, matching seed-trade-flows.mjs.

// Which periods a run tries, per route.
//
// Authenticated route: ONE request carrying a 4-year window. Late filers (UAE,
// Oman, Bahrain) and the Jan-1 rollover are covered without a second call, so
// the request budget below never binds and every reporter benefits — not just
// the first few that fit the spare quota.
//
// Public preview route: that route answers HTTP 400 to a comma-separated
// period (probed 2026-07-26), so it falls back sequentially instead. The loop
// in main() and REQUEST_BUDGET bound the doubled cost there.
export function periodCandidates(isPublicRoute, now = new Date()) {
  return isPublicRoute ? candidatePeriods(now) : [periodWindow(now)];
}

// A catalogue of at most one batch has no second request.
const [BATCH_1, BATCH_2 = []] = HS4_BATCHES;


/** @type {Record<string, {nearestRouteIds: string[], coastSide: string}>} */
const COUNTRY_PORT_CLUSTERS = require('./shared/country-port-clusters.json');
/** @type {Record<string, string>} */
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');
/** @type {Record<string, string>} */
const COMTRADE_REPORTER_OVERRIDES = require('./shared/comtrade-reporter-overrides.json');

const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);

/**
 * @param {Array<string[]>} commands
 */
async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Returns { fresh, ageMs, reason } for the existing seed-meta record.
 * Fail-open: any read error or parse error reports fresh=false so the
 * caller can fall through to the regular fetch path. The cron schedule
 * (monthly) is the primary quota guard; this gate is the secondary one.
 */
export async function checkSeedMetaFreshness(now = Date.now()) {
  try {
    const result = await redisPipeline([['GET', META_KEY]]);
    const raw = Array.isArray(result) ? result[0]?.result : null;
    if (!raw || typeof raw !== 'string') return { fresh: false, ageMs: null, reason: 'no-meta' };
    const parsed = JSON.parse(raw);
    const fetchedAt = Number(parsed?.fetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      return { fresh: false, ageMs: null, reason: 'no-fetchedAt' };
    }
    const ageMs = now - fetchedAt;
    if (ageMs < FRESHNESS_GATE_MS) return { fresh: true, ageMs, reason: 'within-gate' };
    return { fresh: false, ageMs, reason: 'stale' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bilateral-hs4] seed-meta freshness check failed (fail-open): ${message}`);
    return { fresh: false, ageMs: null, reason: 'read-error' };
  }
}

/**
 * Consecutive TTL-refresh streak per ISO2 from the previous run's seed-meta.
 * Fail-open: any read/parse error yields {} so every streak restarts at zero,
 * which only ever grants MORE grace before a payload expires, never less.
 * @returns {Promise<Record<string, number>>}
 */
export async function readPreserveStreaks() {
  try {
    const result = await redisPipeline([['GET', META_KEY]]);
    const raw = Array.isArray(result) ? result[0]?.result : null;
    if (!raw || typeof raw !== 'string') return {};
    const streaks = JSON.parse(raw)?.preserveStreaks;
    if (!streaks || typeof streaks !== 'object' || Array.isArray(streaks)) return {};
    return streaks;
  } catch {
    return {};
  }
}

/**
 * @param {number} status
 * @returns {boolean}
 */
// Comtrade's API regularly returns transient 5xx (500/502/503/504) on otherwise
// valid reporter fetches — observed 2026-04-14 with India (699) 503×2 and
// Iran (364) 500. Without a 5xx retry those reporters silently drop from
// the snapshot and the panel shows missing countries for a full cycle.
export function isTransientComtrade(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

// Circuit breaker for an exhausted quota. fetchBilateral waits 60s on the first
// 429 of every call, so once the quota is gone a full pass sits through ~394 of
// those waits — about 6.6 hours against a 30-minute LOCK_TTL_MS. The lock would
// expire mid-run and the next tick could start a second run on top of it. Five
// consecutive rate-limited batch fetches is ~5 minutes plus normal request
// pacing, well inside the lock, and by then the quota verdict is not in doubt.
export const MAX_CONSECUTIVE_RATE_LIMITED_FETCHES = 5;
let consecutiveRateLimited = 0;
/** Reset at the start of every run; also lets tests isolate module state. */
export function resetRateLimitStreak() { consecutiveRateLimited = 0; }

// Retry sleep is indirected through a module-local binding so unit tests can
// swap in a no-op without changing production cadence. Production defaults
// to the real sleep import; tests call __setSleepForTests(() => Promise.resolve()).
let _retrySleep = sleep;
// The inter-request pacing sleep is indirected too. Without it main() is
// untestable by construction: 197 countries x 2 batches x INTER_REQUEST_DELAY_MS
// is over 20 minutes of real waiting, so the whole write path could only be
// checked by reading the diff. Production still gets the real cadence.
let _paceSleep = sleep;
export function __setSleepForTests(fn) {
  const next = typeof fn === 'function' ? fn : sleep;
  _retrySleep = next;
  _paceSleep = next;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {(() => void) | undefined} [reserveRequest]
 */
async function fetchBilateralOnce(url, timeoutMs = 45_000, reserveRequest) {
  // Reserve immediately before the network call so retries count against the
  // same hard quota budget as first attempts. A logical batch fetch may issue
  // up to four upstream requests (one 429 retry plus two transient-5xx
  // retries), so counting only fetchBilateral() calls can exceed the cap.
  reserveRequest?.();
  return fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * @param {string} reporterCode empty for a world-exports request, which asks
 *   every reporter at once — the one call shape that omits the parameter.
 * @param {string[]} hs4Batch
 * @param {string} key
 * @param {string} period
 * @param {'M' | 'X'} [flowCode] 'M' is the per-reporter import pull; 'X' with
 *   partnerCode=0 is each reporter's exports of the heading to the World.
 */
function buildFetchUrl(reporterCode, hs4Batch, key, period, flowCode = 'M') {
  const url = new URL(COMTRADE_FETCH_URL);
  if (reporterCode) url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', hs4Batch.join(','));
  url.searchParams.set('flowCode', flowCode);
  // Pinning the partner to World is what turns an all-reporter export request
  // into one row per reporter instead of one row per corridor.
  if (flowCode === 'X') url.searchParams.set('partnerCode', '0');
  url.searchParams.set('period', period);
  // Aggregate-only rows, mirroring seed-recovery-import-hhi.mjs. Without these
  // Comtrade returns one row per partner x second partner x transport mode x
  // customs procedure — about 9x — which fills the public preview's 500-row cap
  // and inflates authenticated payloads. groupByProduct already kept only the
  // aggregate row per partner, so the result is unchanged and only the row
  // count falls.
  url.searchParams.set('partner2Code', '0');
  url.searchParams.set('motCode', '0');
  url.searchParams.set('customsCode', 'C00');
  url.searchParams.set('maxRecords', String(MAX_RECORDS));
  if (key) url.searchParams.set('subscription-key', key);
  return url.toString();
}

/**
 * Single classification loop so a post-429 5xx still consumes the bounded
 * 5xx retries (and vice versa). Caps: one 429 wait (60s), then up to two
 * transient-5xx retries (5s, 15s). Any non-transient non-OK status exits.
 *
 * @param {string} reporterCode
 * @param {string[]} hs4Batch
 * @param {string} [period]
 * @param {(() => void) | undefined} [reserveRequest]
 * @param {((rawRowCount: number) => void) | undefined} [onRawRowCount] called with the
 *   provider's raw row count before parsing, so a batch that ends `incomplete`
 *   still reports the number of rows it saw.
 * @param {'M' | 'X'} [flowCode] 'X' builds the all-reporter world-exports
 *   request, which reuses this function purely for its retry and 429 handling.
 * @returns {Promise<Array<{cmdCode: string, partnerCode: string, reporterCode?: string, primaryValue: number, year: number}>>}
 */
export async function fetchBilateral(reporterCode, hs4Batch, period = recentPeriod(), reserveRequest, onRawRowCount, flowCode = 'M') {
  let rateLimitedOnce = false;
  let transientRetries = 0;
  const MAX_TRANSIENT_RETRIES = 2;
  // A world-exports request has no reporter to name in the logs.
  const label = reporterCode || 'world exports';

  let resp;
  while (true) {
    resp = await fetchBilateralOnce(
      buildFetchUrl(reporterCode, hs4Batch, getNextKey(), period, flowCode),
      45_000,
      reserveRequest,
    );

    if (resp.status === 429 && !rateLimitedOnce) {
      console.warn(`  429 rate-limited for reporter ${label}, waiting 60s...`);
      await _retrySleep(60_000);
      rateLimitedOnce = true;
      continue;
    }

    if (isTransientComtrade(resp.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
      const delay = transientRetries === 0 ? 5_000 : 15_000;
      console.warn(`    transient HTTP ${resp.status} for reporter ${label}, retrying in ${delay / 1000}s...`);
      await _retrySleep(delay);
      transientRetries++;
      continue;
    }

    break;
  }

  if (!resp.ok) {
    const tag = (rateLimitedOnce || transientRetries > 0) ? ' (after retries)' : '';
    console.warn(`    HTTP ${resp.status} for reporter ${label}${tag}`);
    if (resp.status === 429) consecutiveRateLimited++;
    throw new Error(`Comtrade upstream HTTP ${resp.status}`);
  }

  consecutiveRateLimited = 0;

  const data = await resp.json();
  // Report the count before parseRecords, which drops zero-value rows and
  // throws outright on a capped response — the one case where knowing how many
  // rows arrived matters most.
  if (Array.isArray(data?.data)) onRawRowCount?.(data.data.length);
  const parsed = parseRecords(data, MAX_RECORDS);
  if (parsed.length === 0 && data?.count > 0) {
    console.warn(`    Reporter ${label}: API returned count=${data.count} but parseRecords produced 0 — response shape may have changed`);
  }
  return parsed;
}



/**
 * @param {{ requestBudget?: number }} [options]
 */
export async function main({ requestBudget = REQUEST_BUDGET } = {}) {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const effectiveRequestBudget = Number.isFinite(requestBudget) && requestBudget > 0
    ? Math.floor(requestBudget)
    : REQUEST_BUDGET;

  // Freshness gate: skip if seed-meta says we re-seeded < 24d ago.
  // One run = ~396 authenticated UN Comtrade calls; their Free APIs tier is
  // 500/month, so a stuck-on cron schedule used to put us 24× over quota
  // before this gate landed. FORCE_RESEED=true bypasses (used by ad-hoc
  // refresh scripts like post-pr*-force-refresh.mjs).
  if (!process.env.FORCE_RESEED) {
    const freshness = await checkSeedMetaFreshness();
    if (freshness.fresh) {
      const ageDays = freshness.ageMs != null ? (freshness.ageMs / 86_400_000).toFixed(1) : '?';
      const gateDays = (FRESHNESS_GATE_MS / 86_400_000).toFixed(0);
      console.log(`[bilateral-hs4] seed-meta is ${ageDays}d old (gate=${gateDays}d) — skipping (set FORCE_RESEED=true to override)`);
      return;
    }
  }

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });

  const PERIODS = periodCandidates(usePublicApi);
  const countries = Object.entries(COUNTRY_PORT_CLUSTERS)
    .filter(([k]) => k !== '_comment' && k.length === 2);
  const canonicalKey = (iso2) => `${KEY_PREFIX}${iso2}:v1`;
  const partnersKey = (iso2) => `${PARTNERS_KEY_PREFIX}${iso2}:v1`;
  // Both keys of every country. They describe one observation, so every
  // lifetime decision below — TTL extension, preservation, expiry — covers the
  // pair; a sibling left behind would outlive the payload it details.
  const allKeys = countries.flatMap(([iso2]) => [canonicalKey(iso2), partnersKey(iso2)]);

  if (lock.skipped) {
    await extendExistingTtl([...allKeys, WORLD_EXPORTS_KEY, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[bilateral-hs4] Lock held, skipping');
    return;
  }

  const countryCoverage = Object.fromEntries(countries.map(([iso2]) => [iso2, { state: 'not_attempted' }]));
  // The run's world-exports outcome. Null until the reserved fetch is attempted,
  // which is also what a snapshot written before this field existed reads as —
  // api/seed-health.js treats that absence as "no evidence", not as a failure.
  let worldExports = null;
  const writeMeta = async (count, status = 'ok', preserveStreaks = {}) => {
    const meta = JSON.stringify({ fetchedAt: Date.now(), recordCount: count, status, preserveStreaks, requestedHs4s: HS4_CODES, countryCoverage, worldExports });
    // TTL ≥ FRESHNESS_GATE_MS so the gate's "fresh" answer cannot be silently
    // invalidated by Redis eviction. See the SEED_META_TTL_SECONDS comment.
    await redisPipeline([['SET', META_KEY, meta, 'EX', String(SEED_META_TTL_SECONDS)]])
      .catch(e => console.warn('[bilateral-hs4] Failed to write seed-meta:', e.message));
  };

  const priorStreaks = await readPreserveStreaks();
  resetRateLimitStreak();

  try {
    const apiMode = usePublicApi ? 'public preview (no COMTRADE_API_KEYS)' : `authenticated (${COMTRADE_KEYS.length} key(s), ${INTER_REQUEST_DELAY_MS}ms delay)`;
    console.log(`[bilateral-hs4] Fetching bilateral HS4 data for ${countries.length} countries × ${HS4_CODES.length} products [${apiMode}]...`);

    const commands = [];
    const writtenKeys = new Set();
    let writtenCount = 0;
    let failedCount = 0;
    let requestCount = 0;
    let requestBudgetExhausted = false;
    const reserveRequest = () => {
      if (requestCount >= effectiveRequestBudget) {
        requestBudgetExhausted = true;
        throw new Error(`Comtrade request budget reached (${requestCount}/${effectiveRequestBudget})`);
      }
      requestCount++;
    };

    // Sibling keys roughly triple the bytes a country contributes, so the
    // 50-command flush alone would post multi-megabyte bodies. Track the payload
    // bytes queued and flush on whichever ceiling is reached first.
    let pendingBytes = 0;
    const queueWrite = (key, payload) => {
      commands.push(['SET', key, payload, 'EX', String(TTL_SECONDS)]);
      pendingBytes += payload.length;
      writtenKeys.add(key);
    };
    const flushIfFull = async () => {
      if (commands.length < MAX_PIPELINE_COMMANDS && pendingBytes < MAX_PIPELINE_BYTES) return;
      await redisPipeline(commands.splice(0));
      pendingBytes = 0;
    };

    // R10/KTD7: the two world-export requests are reserved BEFORE the country
    // loop. Reserving them after it would let a budget abort drop them entirely,
    // and would leave the per-reporter pre-check committing a remainder it does
    // not have. One request per catalogue batch covers every reporter at once.
    // On the keyless preview route the all-reporter answer (~2,300 rows per
    // batch) exceeds the 500-row cap, so this ends `incomplete` there and the
    // previous snapshot is kept; production runs keyed.
    try {
      const worldPeriod = PERIODS[0];
      const worldRecords = [];
      for (let b = 0; b < HS4_BATCHES.length; b++) {
        if (requestCount > 0) await _paceSleep(INTER_REQUEST_DELAY_MS);
        console.log(`[bilateral-hs4] world exports batch ${b + 1}/${HS4_BATCHES.length} (period ${worldPeriod})...`);
        worldRecords.push(...await fetchBilateral('', HS4_BATCHES[b], worldPeriod, reserveRequest, undefined, 'X'));
      }
      const headings = groupWorldExports(worldRecords);
      const fetchedAt = new Date().toISOString();
      if (Object.keys(headings).length === 0) {
        // A valid empty answer, like a reporter with no products: recorded,
        // never written over the last good snapshot.
        console.warn('[bilateral-hs4] world exports: no usable rows, keeping the previous snapshot');
        worldExports = { state: 'no_records', attemptedAt: fetchedAt };
      } else {
        queueWrite(WORLD_EXPORTS_KEY, JSON.stringify({
          fetchedAt,
          period: worldPeriod,
          source: usePublicApi ? 'UN Comtrade public preview' : 'UN Comtrade data API',
          headings,
        }));
        const reporters = new Set();
        for (const heading of Object.values(headings)) {
          for (const exporter of heading.exporters) reporters.add(exporter.reporterCode);
        }
        worldExports = {
          state: 'observed',
          fetchedAt,
          headingCount: Object.keys(headings).length,
          reporterCount: reporters.size,
        };
        console.log(`[bilateral-hs4] world exports: ${worldExports.headingCount} headings, ${worldExports.reporterCount} reporters`);
      }
    } catch (err) {
      // The reporters do not depend on this key; degrade the brief's supplier
      // scale rather than the country coverage.
      console.warn(`[bilateral-hs4] world exports unavailable, continuing with reporters: ${err.message}`);
      worldExports = { state: comtradeFailureState(err), attemptedAt: new Date().toISOString() };
    }

    for (let i = 0; i < countries.length; i++) {
      const [iso2] = countries[i];
      const unCode = COMTRADE_REPORTER_OVERRIDES[iso2] ?? ISO2_TO_UN[iso2];
      if (!unCode) {
        console.warn(`  ${iso2}: no UN code, skipping`);
        continue;
      }

      // A complete reporter needs two batch requests. Avoid starting one when
      // the remaining budget cannot cover both; reserveRequest is the hard
      // backstop when retries consume the remaining slack mid-reporter.
      if (requestCount + 2 > effectiveRequestBudget) {
        requestBudgetExhausted = true;
        console.warn(`[bilateral-hs4] Request budget reached (${requestCount}/${effectiveRequestBudget}) before ${iso2}; writing the partial result.`);
        break;
      }

      if (requestCount > 0) await _paceSleep(INTER_REQUEST_DELAY_MS);

      // Raw provider row counts for the batches of the period actually used.
      // Declared outside the try so a batch that throws still reports the rows
      // it saw, and reset per period attempt so a fallback does not append the
      // empty counts of the period it replaced.
      let rowCounts = [];
      const recordRowCount = n => rowCounts.push(n);

      try {
        let batch1 = [];
        let batch2 = [];
        let usedPeriod = PERIODS[0];

        for (let p = 0; p < PERIODS.length; p++) {
          if (p > 0 && requestCount + 2 > effectiveRequestBudget) {
            console.warn(`    ${iso2}: skipping fallback period ${PERIODS[p]} — request budget reached (${requestCount}/${effectiveRequestBudget})`);
            break;
          }
          usedPeriod = PERIODS[p];
          rowCounts = [];

          console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 1/2 (period ${usedPeriod})...`);
          batch1 = await fetchBilateral(unCode, BATCH_1, usedPeriod, reserveRequest, recordRowCount);
          if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) break;

          if (BATCH_2.length > 0) {
            await _paceSleep(INTER_REQUEST_DELAY_MS);

            console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 2/2 (period ${usedPeriod})...`);
            batch2 = await fetchBilateral(unCode, BATCH_2, usedPeriod, reserveRequest, recordRowCount);
            if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) break;
          }

          if (batch1.length > 0 || batch2.length > 0) break;
          if (p < PERIODS.length - 1) {
            console.warn(`    ${iso2}: no records for period ${usedPeriod}, retrying with fallback period ${PERIODS[p + 1]}...`);
            await _paceSleep(INTER_REQUEST_DELAY_MS);
          }
        }

        const products = groupByProduct([...batch1, ...batch2], Number(String(usedPeriod).split(',')[0]));
        countryCoverage[iso2] = { state: products.length ? 'observed' : 'no_records', attemptedAt: new Date().toISOString(), missingHs4s: HS4_CODES.filter(code => !products.some(p => p.hs4 === code)), rowCounts };
        if (products.length === 0) {
          console.warn(`    ${iso2}: no products after grouping, skipping write`);
        } else {
          const fetchedAt = new Date().toISOString();
          const source = usePublicApi ? 'UN Comtrade public preview' : 'UN Comtrade data API';
          // The canonical payload keeps exactly the shape every derived scorer
          // and both bulk readers have always seen: the leading five origins,
          // with none of the new per-partner detail.
          // Both row shapes come from the shared catalogue module, which the
          // lazy fetch also uses to write the same two keys.
          const payload = JSON.stringify({
            iso2,
            products: products.map(toCanonicalProduct),
            fetchedAt,
            source,
            requestedHs4s: HS4_CODES,
          });
          queueWrite(canonicalKey(iso2), payload);
          // The sibling carries the evidence the brief needs and no consumer of
          // the canonical key reads.
          queueWrite(partnersKey(iso2), JSON.stringify({
            iso2,
            fetchedAt,
            source,
            requestedHs4s: HS4_CODES,
            products: products.map(toPartnersProduct),
          }));
          writtenCount++;
          console.log(`    ${iso2}: ${products.length} products, ${batch1.length + batch2.length} records`);
        }
      } catch (err) {
        console.warn(`  [bilateral-hs4] ${iso2}: fetch failed, preserving existing data: ${err.message}`);
        countryCoverage[iso2] = { state: comtradeFailureState(err), attemptedAt: new Date().toISOString(), rowCounts };
        failedCount++;
      }

      await flushIfFull();

      if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) {
        console.warn(`[bilateral-hs4] ABORTING after ${consecutiveRateLimited} consecutive rate-limited batch fetches — the monthly quota looks exhausted. Writing the partial result rather than grinding through ~${countries.length - i - 1} more 60s waits and outliving the ${LOCK_TTL_MS / 60_000}min lock.`);
        break;
      }
      if (requestBudgetExhausted) {
        console.warn(`[bilateral-hs4] ABORTING at the hard request budget (${requestCount}/${effectiveRequestBudget}). Writing the partial result.`);
        break;
      }
    }

    if (commands.length > 0) {
      await redisPipeline(commands);
    }

    // Countries that returned nothing keep their last good payload — but only
    // if the TTL is refreshed, else the key still expires TTL_SECONDS after its
    // last SUCCESSFUL write. Two bounds, both from review:
    //   1. Only keys that ALREADY EXIST. extendExistingTtl warns per missing
    //      key, so extending the whole 197-country roster (most never written
    //      while the feed recovers) fires a ~190-key "manual seed required"
    //      alarm every run — the alarm fatigue the coverage floor avoids.
    //   2. Only for MAX_PRESERVE_RUNS consecutive runs, so an abandoned
    //      reporter ages out instead of becoming immortal and permanently
    //      short-circuiting the lazy fallback that would re-probe it.
    /** @type {Record<string, number>} iso2 -> consecutive preserved runs */
    const preserveStreaks = {};
    // Probed per country, two keys at a time: the canonical key decides whether
    // the country is preserved at all, and the sibling rides that decision so
    // the pair cannot drift apart. A country seeded before the sibling existed
    // simply has none to extend.
    const staleCountries = countries
      .map(([iso2]) => iso2)
      .filter(iso2 => !writtenKeys.has(canonicalKey(iso2)));
    const staleKeys = staleCountries.flatMap(iso2 => [canonicalKey(iso2), partnersKey(iso2)]);
    const existing = staleKeys.length > 0
      ? await redisPipeline(staleKeys.map(k => ['EXISTS', k]))
          .catch(e => {
            console.warn('[bilateral-hs4] preserved-key EXISTS probe failed:', e.message);
            return null;
          })
      : null;

    const preservedKeys = [];
    for (let c = 0; c < staleCountries.length; c++) {
      if (!existing || Number(existing[c * 2]?.result) !== 1) continue;
      const iso2 = staleCountries[c];
      const streak = (priorStreaks[iso2] ?? 0) + 1;
      if (streak > MAX_PRESERVE_RUNS) continue; // let it age out
      preserveStreaks[iso2] = streak;
      preservedKeys.push(canonicalKey(iso2));
      if (Number(existing[c * 2 + 1]?.result) === 1) preservedKeys.push(partnersKey(iso2));
    }
    // A run that could not rewrite the world-exports snapshot keeps the previous
    // one alive, exactly as a failed reporter keeps its previous shard.
    if (worldExports?.state !== 'observed') preservedKeys.push(WORLD_EXPORTS_KEY);
    if (preservedKeys.length > 0) {
      await extendExistingTtl(preservedKeys, TTL_SECONDS)
        .catch(e => console.warn('[bilateral-hs4] TTL extension (preserved) failed:', e.message));
    }

    const status = coverageStatus(writtenCount);
    await writeMeta(writtenCount, status, preserveStreaks);

    logSeedResult('comtrade:bilateral-hs4', writtenCount, Date.now() - startedAt, {
      countries: countries.length,
      failed: failedCount,
      hs4Codes: HS4_CODES.length,
      requests: requestCount,
      ttlH: TTL_SECONDS / 3600,
      preserved: preservedKeys.length,
      status,
    });
    if (status === 'partial') {
      console.warn(`[bilateral-hs4] PARTIAL: seeded ${writtenCount} of ${countries.length} countries (floor ${MIN_COUNTRY_COVERAGE})`);
    }
    console.log(`[bilateral-hs4] Seeded ${writtenCount} country keys (${failedCount} failed, ${preservedKeys.length} preserved)`);
  } catch (err) {
    console.error('[bilateral-hs4] Seed failed:', err.message || err);
    await extendExistingTtl([...allKeys, WORLD_EXPORTS_KEY, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4] TTL extension failed:', e.message));
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-comtrade-bilateral-hs4.mjs');
if (isMain) {
  // Terminal success marker. Emitted from .then() so it can ONLY print after main() has fully
  // resolved — a throw anywhere inside, including a late publish step, skips it. A marker written
  // INSIDE main() would print before later work and could vouch for a run that then died (exactly
  // how #6092 stayed invisible). Format matches the shared runner so the crash diagnostic
  // recognises it; without it a clean run is indistinguishable from a silent death.
  const __runStartedAt = Date.now();
  main()
    .then(() => console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
