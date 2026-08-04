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
import { candidatePeriods, periodWindow, recentPeriod } from './shared/comtrade-period.mjs';

// Re-exported so existing importers (tests, sibling seeders) keep one source.
export { recentPeriod, candidatePeriods };

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);

const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const KEY_PREFIX = 'comtrade:bilateral-hs4:';
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

const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
function getNextKey() {
  if (COMTRADE_KEYS.length === 0) return '';
  const key = COMTRADE_KEYS[keyIndex % COMTRADE_KEYS.length];
  keyIndex++;
  return key;
}

const usePublicApi = COMTRADE_KEYS.length === 0;
const STRATEGIC_PRODUCT_METADATA = require('./shared/comtrade-strategic-products.json');
const COMTRADE_API_CLASSIFIER = 'HS'; // API route family; metadata tracks the active H6/HS2022 revision separately.
const COMTRADE_FETCH_URL = usePublicApi
  ? `https://comtradeapi.un.org/public/v1/preview/C/A/${COMTRADE_API_CLASSIFIER}`
  : `https://comtradeapi.un.org/data/v1/get/C/A/${COMTRADE_API_CLASSIFIER}`;
const INTER_REQUEST_DELAY_MS = usePublicApi ? 3500 : 1500;

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

const BILATERAL_PRODUCTS = STRATEGIC_PRODUCT_METADATA.products.filter((product) => product.bilateralHs4Code);
const HS4_CODES = Array.from(new Set(BILATERAL_PRODUCTS.map((product) => product.bilateralHs4Code)));
const HS4_LABELS = Object.fromEntries(BILATERAL_PRODUCTS.map((product) => [
  product.bilateralHs4Code,
  product.bilateralLabel ?? product.label,
]));

const BATCH_1 = HS4_CODES.slice(0, 10);
const BATCH_2 = HS4_CODES.slice(10);

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

function buildFetchUrl(reporterCode, hs4Batch, key, period) {
  const url = new URL(COMTRADE_FETCH_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('cmdCode', hs4Batch.join(','));
  url.searchParams.set('flowCode', 'M');
  url.searchParams.set('period', period);
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
 * @returns {Promise<Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>>}
 */
export async function fetchBilateral(reporterCode, hs4Batch, period = recentPeriod(), reserveRequest) {
  let rateLimitedOnce = false;
  let transientRetries = 0;
  const MAX_TRANSIENT_RETRIES = 2;

  let resp;
  while (true) {
    resp = await fetchBilateralOnce(
      buildFetchUrl(reporterCode, hs4Batch, getNextKey(), period),
      45_000,
      reserveRequest,
    );

    if (resp.status === 429 && !rateLimitedOnce) {
      console.warn(`  429 rate-limited for reporter ${reporterCode}, waiting 60s...`);
      await _retrySleep(60_000);
      rateLimitedOnce = true;
      continue;
    }

    if (isTransientComtrade(resp.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
      const delay = transientRetries === 0 ? 5_000 : 15_000;
      console.warn(`    transient HTTP ${resp.status} for reporter ${reporterCode}, retrying in ${delay / 1000}s...`);
      await _retrySleep(delay);
      transientRetries++;
      continue;
    }

    break;
  }

  if (!resp.ok) {
    const tag = (rateLimitedOnce || transientRetries > 0) ? ' (after retries)' : '';
    console.warn(`    HTTP ${resp.status} for reporter ${reporterCode}${tag}`);
    if (resp.status === 429) consecutiveRateLimited++;
    return [];
  }

  consecutiveRateLimited = 0;

  const data = await resp.json();
  const parsed = parseRecords(data);
  if (parsed.length === 0 && data?.count > 0) {
    console.warn(`    Reporter ${reporterCode}: API returned count=${data.count} but parseRecords produced 0 — response shape may have changed`);
  }
  return parsed;
}

/**
 * @param {unknown} data
 * @returns {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>}
 */
function parseRecords(data) {
  const records = /** @type {any[]} */ (/** @type {any} */ (data)?.data ?? []);
  if (!Array.isArray(records)) return [];
  return records
    .filter(r => r && Number(r.primaryValue ?? 0) > 0)
    .map(r => ({
      cmdCode: String(r.cmdCode ?? ''),
      partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
      primaryValue: Number(r.primaryValue ?? 0),
      year: Number(r.period ?? r.refYear ?? 0),
    }));
}

/**
 * @param {Array<{cmdCode: string, partnerCode: string, primaryValue: number, year: number}>} records
 * @param {number} [fallbackYear] year to report when no record carries a usable period/refYear
 * @returns {Array<{hs4: string, description: string, totalValue: number, topExporters: Array<{partnerCode: number, partnerIso2: string, value: number, share: number}>, year: number}>}
 */
export function groupByProduct(records, fallbackYear = Number(recentPeriod())) {
  /** @type {Map<string, Map<string, {value: number, year: number}>>} */
  const byCode = new Map();
  for (const r of records) {
    if (!byCode.has(r.cmdCode)) byCode.set(r.cmdCode, new Map());
    const partners = byCode.get(r.cmdCode);
    const existing = partners.get(r.partnerCode);
    // Newest year first, then largest value within it. With a single-period
    // response every r.year is equal, so this reduces to the previous
    // largest-value behaviour.
    if (!existing || r.year > existing.year
      || (r.year === existing.year && r.primaryValue > existing.value)) {
      partners.set(r.partnerCode, { value: r.primaryValue, year: r.year });
    }
  }

  const products = [];
  for (const [hs4, partners] of byCode) {
    const ranked = [...partners.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .filter(([pc]) => pc !== '0' && pc !== '000');

    // Collapse the product to ONE year before aggregating. Newest-year-per-
    // partner is not enough on the multi-year window: a partner that traded in
    // an older window year but not the newest would otherwise be summed into
    // totalValue and ranked into topExporters, so a lapsed relationship could
    // hold most of the share of a snapshot labelled a year it did not trade in.
    // A late filer is unaffected — all its rows sit at the same older year.
    const years = ranked.map(([, v]) => v.year).filter(y => y > 0);
    // Math.max(...[]) is -Infinity, which is TRUTHY — so `latestYear || fallback`
    // would return -Infinity and serialize as null, never reaching the fallback.
    const latestYear = years.length > 0 ? Math.max(...years) : 0;
    const sorted = latestYear > 0
      ? ranked.filter(([, v]) => v.year === latestYear)
      : ranked;

    const totalValue = sorted.reduce((s, [, v]) => s + v.value, 0);
    if (totalValue <= 0) continue;
    const top5 = sorted.slice(0, 5);
    products.push({
      hs4,
      description: HS4_LABELS[hs4] ?? hs4,
      totalValue,
      topExporters: top5.map(([pc, v]) => ({
        partnerCode: Number(pc),
        partnerIso2: UN_TO_ISO2[pc.padStart(3, '0')] ?? '',
        value: v.value,
        share: Math.round((v.value / totalValue) * 1000) / 1000,
      })),
      year: latestYear > 0 ? latestYear : fallbackYear,
    });
  }
  return products.sort((a, b) => b.totalValue - a.totalValue);
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
  const allKeys = countries.map(([iso2]) => `${KEY_PREFIX}${iso2}:v1`);

  if (lock.skipped) {
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[bilateral-hs4] Lock held, skipping');
    return;
  }

  const writeMeta = async (count, status = 'ok', preserveStreaks = {}) => {
    const meta = JSON.stringify({ fetchedAt: Date.now(), recordCount: count, status, preserveStreaks });
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

          console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 1/2 (period ${usedPeriod})...`);
          batch1 = await fetchBilateral(unCode, BATCH_1, usedPeriod, reserveRequest);
          if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) break;

          await _paceSleep(INTER_REQUEST_DELAY_MS);

          console.log(`  [${i + 1}/${countries.length}] ${iso2} batch 2/2 (period ${usedPeriod})...`);
          batch2 = await fetchBilateral(unCode, BATCH_2, usedPeriod, reserveRequest);
          if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) break;

          if (batch1.length > 0 || batch2.length > 0) break;
          if (p < PERIODS.length - 1) {
            console.warn(`    ${iso2}: no records for period ${usedPeriod}, retrying with fallback period ${PERIODS[p + 1]}...`);
            await _paceSleep(INTER_REQUEST_DELAY_MS);
          }
        }

        const products = groupByProduct([...batch1, ...batch2], Number(String(usedPeriod).split(',')[0]));
        if (products.length === 0) {
          console.warn(`    ${iso2}: no products after grouping, skipping write`);
        } else {
          const payload = JSON.stringify({
            iso2,
            products,
            fetchedAt: new Date().toISOString(),
          });
          commands.push(['SET', `${KEY_PREFIX}${iso2}:v1`, payload, 'EX', String(TTL_SECONDS)]);
          writtenKeys.add(`${KEY_PREFIX}${iso2}:v1`);
          writtenCount++;
          console.log(`    ${iso2}: ${products.length} products, ${batch1.length + batch2.length} records`);
        }
      } catch (err) {
        console.warn(`  [bilateral-hs4] ${iso2}: fetch failed, preserving existing data: ${err.message}`);
        failedCount++;
      }

      if (commands.length >= 50) {
        await redisPipeline(commands.splice(0));
      }

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
    const staleKeys = allKeys.filter(k => !writtenKeys.has(k));
    const existing = staleKeys.length > 0
      ? await redisPipeline(staleKeys.map(k => ['EXISTS', k]))
          .catch(e => {
            console.warn('[bilateral-hs4] preserved-key EXISTS probe failed:', e.message);
            return null;
          })
      : null;

    const preservedKeys = [];
    for (let k = 0; k < staleKeys.length; k++) {
      if (!existing || Number(existing[k]?.result) !== 1) continue;
      const iso2 = staleKeys[k].slice(KEY_PREFIX.length, -3);
      const streak = (priorStreaks[iso2] ?? 0) + 1;
      if (streak > MAX_PRESERVE_RUNS) continue; // let it age out
      preserveStreaks[iso2] = streak;
      preservedKeys.push(staleKeys[k]);
    }
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
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
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
