#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  extendExistingTtlDetailed,
  logSeedResult,
  readSeedSnapshot,
  resolveProxyForConnect,
  httpsProxyFetchRaw,
  PUBLISH_BLOCKED_EXIT_CODE,
} from './_seed-utils.mjs';
import { createCountryResolvers } from './_country-resolver.mjs';
import {
  buildPortActivityMetaPayload,
  contentClockFor,
  isCriticalContentRefreshDue,
  orderColdFetchQueue,
  PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
  PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES,
  PORTWATCH_DECISION_CRITICAL_COUNTRIES,
  PORTWATCH_MAX_CACHE_AGE_MS,
} from './_portwatch-content-freshness.mjs';

export {
  buildContentFreshnessReport,
  buildPortActivityMetaPayload,
  contentClockFor,
  isCriticalContentRefreshDue,
  orderColdFetchQueue,
  PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY,
  PORTWATCH_CONTENT_FRESHNESS_BUDGET_MINUTES,
  PORTWATCH_DECISION_CRITICAL_COUNTRIES,
  PORTWATCH_EXPIRY_PRIORITY_LEAD_MINUTES,
  PORTWATCH_MAX_REPORTED_STALE_COUNTRIES,
} from './_portwatch-content-freshness.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const KEY_PREFIX = 'supply_chain:portwatch-ports:v1:';
const META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const LOCK_DOMAIN = 'supply_chain:portwatch-ports';
// 60 min — covers the widest realistic run of this standalone service.
const LOCK_TTL_MS = 60 * 60 * 1000;
const TTL = 259_200; // 3 days — 24× the 3h cron interval
// PortWatch currently has 174 ISO2-mapped countries with port references.
// This is the issue #3613 health target. Runs below this count must stay
// non-green in /api/health and /api/seed-health. Only a complete validated
// run may advance the canonical list and last-success metadata.
export const PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES = 174;

const EP3_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';
// Schema introspection URL — same FeatureServer, no /query suffix. Used by
// resolveArcgisDateField to resolve the queryable date-column name at run
// start so the seeder survives IMF flapping the rename (`date` → `date_`
// → `date` observed within ~9h on 2026-04-29).
const EP3_SCHEMA = EP3_BASE.replace('/query', '?f=json');
// Fallback when schema introspection fails. `date` is the historical default
// (and the state observed at 12:09 UTC 2026-04-29 after IMF reverted the
// rename); the resolver also accepts `date_` as a discovered name.
const ARCGIS_DATE_FIELD_FALLBACK = 'date';
const EP4_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query';

const PAGE_SIZE = 2000;
// WM 2026-05-18 re-measurement: live response-time probe from a residential
// laptop on today's failing-country set (SLB, CMR, BHS, KWT, PAK, VIR, SEN,
// PRT, CHN, JPN, USA, POL) shows ArcGIS responds in 1.8-28.4s direct, with
// 6 of 12 countries between 16-29s — exceeding the PR #3711 FETCH_TIMEOUT=15s
// that was sized for "Railway-direct never returns". Upstream behavior has
// shifted from "fully blocked" to "slow but reachable", so the 15s budget
// now kills ~50% of recoverable direct fetches, forcing them through the
// degraded proxy where many fail with Decodo CONNECT 522s.
//
// Bumped to 30s: covers ~95% of the observed residential response range
// (only PRT at 28.4s is close to the edge). Paired with PROXY_FETCH_TIMEOUT
// dropping 70→50s so the per-country budget (direct + proxy) stays under
// the 90s wrap with 10s slack: 30 + 50 = 80s ≤ 90s ✓.
const FETCH_TIMEOUT = 30_000;
// Proxy leg now gets 50s. Earlier PR #3711 sized this at 70s when direct
// was assumed dead and the proxy was the ONLY path that could return —
// today's probe through Decodo's gate pool typically returns in 7-13s for
// success and 30-50s for "Invalid query parameters" error bodies. 50s
// covers the success class comfortably and most of the error-body class.
// Per-country budget: FETCH_TIMEOUT (30s) + PROXY_FETCH_TIMEOUT (50s) =
// 80s within the 90s wrap, leaves 10s slack for Decodo TCP/CONNECT setup.
const PROXY_FETCH_TIMEOUT = 50_000;
// Preflight-specific direct timeout. The fetchMaxDate preflight runs once
// per eligible country (174 today) at PREFLIGHT_CONCURRENCY=24 BEFORE the
// cold-fetch cap partitions countries into refresh-now vs serve-stale, so
// without a tighter budget the preflight phase alone could blow the 570s
// container budget under ArcGIS degradation:
//   ceil(174/24)=8 waves × (FETCH_TIMEOUT + PROXY_FETCH_TIMEOUT)
//   At current 30+50=80s split, that'd be 640s — over the 570s bundle
//   budget BEFORE any useful work. At pre-#3711 45+35=80s same result.
// Empirically TODAY preflight outStatistics queries return in <1s even
// from Railway IPs (small response, different upstream behavior than the
// paginated data queries), so this protection is preventative not curative.
// Greptile PR #3711 P1: protects against the day ArcGIS starts throttling
// outStatistics queries too.
//
// Companion lever: fetchMaxDate skips the proxy fallback entirely so a
// timing-out preflight is a CHEAP fail (~5s) that falls through to the
// expensive per-country activity path, where the full direct+proxy budget
// is available. Preflight is best-effort (cache invalidation only).
const PREFLIGHT_FETCH_TIMEOUT = 5_000;
// Diagnostic re-fetch budget for capturing the actual error body when the
// initial direct fetch times out at FETCH_TIMEOUT. The original incident
// (WM 2026-05-15) found ArcGIS Daily_Ports_Data returning HTTP 200 with a
// 400 error body (`{"error":{"code":400,"message":"Cannot perform query.
// Invalid query parameters."}}`) after 30-56s of server processing. In
// that mode, a direct FETCH_TIMEOUT that fires before the body lands
// causes the upstream circuit-breaker (which matches
// `/Invalid query parameters/i` on the error message) to never see the
// real message — it sees a generic AbortError instead.
//
// 40s was sized for the original FETCH_TIMEOUT=45s split: direct (45s
// timeout) + capture (40s budget) = 85s, fits the 90s per-country wrap
// with 5s slack.
//
// Currently the WHOLE capture path is DISABLED via
// MAX_BODY_CAPTURE_ATTEMPTS=0 (see that constant for rationale). The
// post-#3711 budgets (today 30s direct + 50s proxy, was 15+70) let the
// proxy leg receive the body directly, and arcgisProxyRetry throws an
// "ArcGIS error (via proxy after ...)" message that the circuit-breaker
// matches — so the capture re-fetch is no longer load-bearing. This constant stays at 40s for the day the
// attempt cap is bumped back > 0 (e.g. non-Railway egress where direct
// works), with the proviso that any caller re-enabling capture should
// re-derive the budget against the FETCH_TIMEOUT in effect at that time.
const ERROR_BODY_CAPTURE_EXTRA_MS = 40_000;
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
export const PER_COUNTRY_TIMEOUT_MS = 90_000;
// Concurrency for the per-country activity fetch. Halved from 12 → 6 on
// 2026-05-14 to ease pressure on both ArcGIS direct AND Decodo proxy paths,
// which were each hitting their own rate-limits in the post-3676/3681 runs
// (24/30 successes on run #1, 5/30 on run #2 as Decodo throttled us).
// Math at concurrency 6 + cold-fetch cap 30:
//   5 batches × ~60s realistic (90s worst-case per country) + 4×5s backoff
//   ≈ 320s realistic, 470s worst case — fits the 570s bundle budget.
export const CONCURRENCY = 6;
// Cooldown between activity-fetch batches. Spaces out per-batch bursts so
// neither ArcGIS-direct nor Decodo-proxy hits its rate-limit window from
// our run alone. 5s × 4 inter-batch gaps = 20s total added to a 30-country
// run — negligible against the 570s bundle budget.
const BATCH_BACKOFF_MS = 5_000;
// Ceiling for a single rate-limit-escalated inter-batch gap.
const MAX_RATE_LIMITED_BATCH_BACKOFF_MS = 40_000;
// Total EXTRA backoff (above the 5s baseline) one run may spend on rate limits.
//
// This cap is what keeps the fix from reintroducing the crash it removes: a
// section timeout is a hard bundle FAILURE — the same Railway "Deploy Crashed!"
// this change exists to stop, except the SIGTERM destroys in-flight work
// instead of writing recovery state.
//
// The static cap alone is NOT the safety argument. The activity loop's own
// worst case (5 batches x PER_COUNTRY_TIMEOUT_MS + four baseline gaps = 470s)
// is only part of what the 540s section timeout covers; the run also pays for
// the canonical/meta/174-country snapshot read, schema introspection, the
// paginated reference fetch (no per-page wrap: direct 30s + proxy 50s per
// page), the 174-country preflight (observed at 360s during the 2026-05-13
// incident — see MAX_COLD_FETCH_PER_RUN), and the final ~176-key publication.
// So the budget is additionally clamped at the call site against a real
// wall-clock deadline (RUN_BACKOFF_DEADLINE_MS), which is what actually makes
// the overrun unreachable. This constant just bounds the escalation itself.
const RATE_LIMIT_BACKOFF_BUDGET_MS = 60_000;
// Wall-clock point in the run past which no further batch is DISPATCHED and no
// extra rate-limit backoff is spent, measured from main()'s startedAt.
//
// Derived backwards from the 540s section timeout, because the deadline has to
// leave room for everything that still happens after the last batch is
// admitted: the batch itself can run a full PER_COUNTRY_TIMEOUT_MS (90s), and
// the publication that follows is a Redis multi-exec at AbortSignal.timeout
// (30s), plus TTL extension. 540 - 90 - 30 = 420s, taken down to 390s so the
// arithmetic has slack rather than sitting on the boundary.
//
// An earlier 480s was wrong in exactly this way: a batch admitted at 479s runs
// to 569s and then still has to publish, overrunning the section timeout — a
// hard bundle failure, i.e. the crash this whole change exists to remove.
const RUN_DISPATCH_DEADLINE_MS = 390_000;
// The reference fetch runs before any country work and has no page cap, so it
// gets its own slice rather than the whole run deadline. Without this it could
// legally spend the entire dispatch budget and leave nothing for the countries
// it exists to describe.
const REF_FETCH_DEADLINE_MS = 120_000;
// Escalation steps from BATCH_BACKOFF_MS to MAX_RATE_LIMITED_BATCH_BACKOFF_MS.
// Used to jump straight to the widest gap when a whole batch comes back
// rate-limited, instead of climbing to it one batch at a time.
const RATE_LIMIT_ESCALATION_STEPS_TO_MAX =
  Math.ceil(Math.log2(MAX_RATE_LIMITED_BATCH_BACKOFF_MS / BATCH_BACKOFF_MS));
const BATCH_LOG_EVERY = 5;
// #8501: 2s was one token retry against an ArcGIS rate-limit window measured in
// minutes. The ceiling is the 90s per-country wrap, which must still hold a
// direct attempt (30s) plus its proxy fallback (50s); the deadline guard in
// retryRateLimited declines the retry when the cooldown cannot fit, so this
// can be sized for the fast-failure case that dominates a rate-limited run
// (24 country errors inside a 60s five-batch run on 2026-09-22 => ~10s each).
const RATE_LIMIT_RETRY_DELAY_MS = 8_000;
// A retry is only worth starting if the cooldown AND a full direct attempt fit
// before the per-country wrap. Without this, a late retry is aborted mid-flight
// and the country's failure is recorded as `timeout`, hiding the rate limiting
// from the circuit-breaker and from the persisted refreshFailure code.
//
// Sized at FETCH_TIMEOUT, the direct leg's own budget — NOT at the ~10s a
// rate-limited response actually takes. A retry that only clears the observed
// fast-failure time can still be killed mid-flight by the 90s wrap when the
// upstream stops failing fast, which is the exact misclassification this guard
// exists to prevent. The proxy fallback leg (PROXY_FETCH_TIMEOUT) is not
// included: a retry that gets through its direct leg has already produced the
// truthful classification.
const RATE_LIMIT_RETRY_MIN_ATTEMPT_MS = FETCH_TIMEOUT;
const MAX_RATE_LIMIT_RETRIES = 1;
// Hard publication expiry: reject cached payloads at seven days. Queue a full
// refetch earlier so the bounded rotation can finish before this deadline,
// even when upstream maxDate is unchanged. Protects against window-shift drift
// (cached aggregates were computed against a window that's now 7+ days offset
// from today's last30/prev30 cutoffs) and serves as a belt-and-braces refresh
// if the maxDate check ever silently short-circuits.
//
// Defined in _portwatch-content-freshness.mjs because orderColdFetchQueue needs
// it to rank the expiring tail; re-exported here so this module stays the one
// name the seeder's callers and tests import.
export const MAX_CACHE_AGE_MS = PORTWATCH_MAX_CACHE_AGE_MS;
// Cap how many countries can be cold-fetched in a single run. When upstream
// advances its data (asof mismatch on a sync'd cache), all 174 countries
// become "cache miss" at once. Cold-fetching 174 against ArcGIS exceeds the
// 570s bundle budget (observed 2026-05-13: preflight alone took 360s, batch 1
// of 15 hit 12 errors in 45s before container died at the budget cap).
//
// With this cap, an "everything stale" run refreshes the 30 countries with
// the oldest persisted attempt timestamps and serves the remainder from prior
// cache (marked staleAsof=true so downstream can see they're a window behind).
// A full attempt sweep completes in 6 runs = 3 days at the 12h cron cadence,
// well within the 7-day MAX_CACHE_AGE_MS.
//
// 30 is sized so the cold-fetch path (30 × ~3-5s/country with concurrency
// 6 ≈ 15-25s, plus 20s of backoff) easily fits the 570s budget even when
// ArcGIS is slow.
export const MAX_COLD_FETCH_PER_RUN = 30;
// Concurrency for the cheap per-country maxDate preflight. These are tiny
// outStatistics queries (returns 1 row), so we can push harder than the
// expensive fetch concurrency without tripping ArcGIS 429s in practice.
const PREFLIGHT_CONCURRENCY = 24;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

export function createArcgisProxyError(reason, errInfo) {
  const error = new Error(`ArcGIS error (via proxy after ${reason}): ${errInfo}`);
  error.refreshFailureCode = refreshFailureCode(errInfo);
  return error;
}

// ArcGIS error envelopes are inconsistent: usually `message`, sometimes only
// `code` (see PR #3681), and in principle neither. One ladder shared by all
// three parsers — direct, proxy, and diagnostic capture — so they cannot
// drift apart.
function arcgisErrorInfo(err) {
  return err?.message ?? err?.code ?? JSON.stringify(err);
}

// Retry an ArcGIS request through the Decodo proxy. Used as the fallback
// path when the direct request returns 429 OR silently times out — both
// are signals that ArcGIS is rate-limiting our seed-server IP. Returns the
// parsed JSON body or throws.
//
// Uses PROXY_FETCH_TIMEOUT. Direct FETCH_TIMEOUT + PROXY_FETCH_TIMEOUT
// must total under PER_COUNTRY_TIMEOUT_MS with slack for Decodo's TCP
// handshake / CONNECT setup. Today: 30+50=80s under the 90s wrap with
// 10s slack (see those constants for the per-tweak rationale + the
// dated re-measurements that justified each shift).
async function arcgisProxyRetry(url, reason, { signal } = {}) {
  const proxyAuth = resolveProxyForConnect();
  if (!proxyAuth) throw new Error(`ArcGIS direct ${reason} + no proxy configured for ${url.slice(0, 80)}`);
  console.warn(`  [portwatch] ${reason} — retrying via proxy: ${url.slice(0, 80)}`);
  const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: PROXY_FETCH_TIMEOUT, signal });
  const proxied = JSON.parse(buffer.toString('utf8'));
  if (proxied?.error) {
    // Greptile PR #3681 review P2: ArcGIS can return `{"error":{"code":400}}`
    // with no message field. Fall back to code, then JSON.stringify so the
    // thrown error message stays informative on unexpected error shapes.
    const errInfo = arcgisErrorInfo(proxied.error);
    throw createArcgisProxyError(reason, errInfo);
  }
  return proxied;
}

const defaultFetch = (...args) => globalThis.fetch(...args);

async function fetchWithTimeout(url, {
  signal,
  timeoutMs = FETCH_TIMEOUT,
  noProxyFallback = false,
  forceProxy = false,
  fetchFn = defaultFetch,
  proxyRetryFn = arcgisProxyRetry,
} = {}) {
  // Combine the per-call timeoutMs with the upstream caller signal so an
  // abort propagates into the in-flight fetch AND future pagination iterations.
  //
  // Options:
  //   timeoutMs        — defaults to FETCH_TIMEOUT. Caller can override
  //                       for tighter/looser budgets (preflight uses 5s).
  //   noProxyFallback  — if true, timeout/429 throws instead of routing to
  //                       arcgisProxyRetry. Used by preflight so a degraded
  //                       upstream can't burn the container budget on
  //                       best-effort cache-invalidation probes (PR #3711 P1).
  //   forceProxy       — skip the direct leg for the one bounded recovery
  //                       after an unverified empty country response.
  //   fetchFn          — optional direct transport seam for boundary tests.
  //   proxyRetryFn     — optional proxy transport seam for boundary tests.
  if (forceProxy) {
    if (noProxyFallback) throw new Error('ArcGIS forceProxy conflicts with noProxyFallback');
    return await proxyRetryFn(url, 'unverified empty activity', { signal });
  }
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let resp;
  try {
    resp = await fetchFn(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: combined,
    });
  } catch (err) {
    // If the CALLER signal aborted (real cancellation request from SIGTERM
    // / per-country timeout), propagate as-is. Only the internal
    // FETCH_TIMEOUT or transient network errors fall through to the proxy
    // retry below.
    if (signal?.aborted) throw err;
    // WM 2026-05-13 incident: ArcGIS rate-limited our seed-server by
    // silently stalling responses instead of returning HTTP 429. Every
    // direct per-country fetch hit the 45s FETCH_TIMEOUT, none reached
    // the existing 429 retry branch. Result: 30/30 timeouts on the
    // cold-fetch path, coverage gate failed at 27/50.
    //
    // Detect timeout / transient network errors and fall through to the
    // same proxy retry that 429 uses. The proxy path has its own
    // FETCH_TIMEOUT so one stalled call can't accumulate indefinitely.
    const errName = err?.name || '';
    const errMsg = err?.message || '';
    const isTimeoutLike = errName === 'TimeoutError'
      || errName === 'AbortError'
      || /timeout|aborted|fetch failed|ECONNRESET|UND_ERR_/i.test(errMsg);
    if (!isTimeoutLike) throw err;
    // Greptile PR #3711 P1: best-effort callers (e.g. preflight maxDate)
    // opt out of proxy fallback so a degraded upstream can't burn the
    // container budget on probes that are tolerant of failure. Preflight
    // failures fall through to the expensive per-country path which has
    // its own direct+proxy budget. With PREFLIGHT_FETCH_TIMEOUT=5s and
    // ~8 preflight waves at concurrency 24, this caps the preflight
    // phase at ~40s wall-clock even when every probe fails.
    if (noProxyFallback) throw err;
    // WM 2026-05-15: before routing to proxy, make ONE diagnostic
    // re-fetch with an extra ERROR_BODY_CAPTURE_EXTRA_MS budget to
    // capture the actual response body. ArcGIS Daily_Ports_Data in
    // degradation mode returns HTTP 200 with a 400 error body after
    // 30-56s; in the original (FETCH_TIMEOUT=45s) configuration the
    // direct timeout fired before the body landed, so the upstream
    // country circuit-breaker never saw the
    // real message. If THIS re-fetch lands a body with `body.error`,
    // surface its message so the circuit-breaker can fire on the
    // upstream-degradation signal.
    //
    // Currently DISABLED via MAX_BODY_CAPTURE_ATTEMPTS=0 — see the
    // constant comment for rationale. Today's budgets (FETCH_TIMEOUT=15s,
    // PROXY_FETCH_TIMEOUT=70s) make this path redundant: the proxy leg
    // has enough budget to receive ArcGIS's 51-56s slow response
    // directly, including the 400 error body, which arcgisProxyRetry
    // throws as a message that the country circuit-breaker matches.
    // The gate code stays in place (and the once-per-run semantics) so
    // bumping the attempt cap re-enables the path for any future
    // scenario where direct-fetch lands close enough to a body to be
    // worth capturing (non-Railway egress, etc.). Net cost when enabled:
    // ≤MAX_BODY_CAPTURE_ATTEMPTS × ERROR_BODY_CAPTURE_EXTRA_MS wall-clock
    // per run, naturally bounded by withPerCountryTimeout's 90s wrap.
    // Best-effort: any failure falls through to proxy retry as before.
    if (_bodyCaptureSuccessCount < MAX_BODY_CAPTURE_SUCCESSES
        && _bodyCaptureAttemptCount < MAX_BODY_CAPTURE_ATTEMPTS) {
      _bodyCaptureAttemptCount += 1;
      const captured = await _captureErrorBodyAfterTimeout(url, signal, fetchFn);
      if (captured?.error) {
        _bodyCaptureSuccessCount += 1;
        throw new Error(`ArcGIS error: ${arcgisErrorInfo(captured.error)}`);
      }
      if (captured?.body) {
        _bodyCaptureSuccessCount += 1;
        return captured.body;
      }
      // captured=null: capture also timed out / errored. Don't count as
      // success — fall through to proxy retry, leaving attempts budget
      // for the next timing-out country in case that one settles faster.
    }
    return await proxyRetryFn(url, `direct ${errName || 'timeout'}`, { signal });
  }
  if (resp.status === 429) {
    // Preflight (noProxyFallback) treats 429 as a soft failure: throw and
    // let the caller fall through to the expensive per-country path.
    if (noProxyFallback) throw new Error(`ArcGIS HTTP 429 (preflight, no proxy fallback)`);
    return await proxyRetryFn(url, 'HTTP 429 rate-limited', { signal });
  }
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  // A raw `body.error.message` interpolation threw "ArcGIS error: undefined"
  // for a message-less envelope — unusable in logs, and invisible to both
  // the rate-limit classifier and the invalid-params circuit breaker, which
  // read this message.
  if (body?.error) {
    const errInfo = arcgisErrorInfo(body.error);
    const error = new Error(`ArcGIS error: ${errInfo}`);
    if (!noProxyFallback && refreshFailureCode(error) === 'rate_limited') {
      return await proxyRetryFn(url, 'HTTP 200 rate-limited', { signal });
    }
    throw error;
  }
  return body;
}

// Module-local: tracks SUCCESSFUL diagnostic body-captures this run.
// Greptile PR #3701 P2: pre-fix the gate fired on first ATTEMPT, so a
// failed first capture (capture also timing out at +20s during
// consistent degradation) locked out every subsequent attempt — the
// diagnostic value could be lost for an entire run. New behavior: gate
// on successful captures, bound total ATTEMPTS to
// MAX_BODY_CAPTURE_ATTEMPTS so we don't pay the +20s on every timing-out
// country in a fully-degraded run.
let _bodyCaptureSuccessCount = 0;
let _bodyCaptureAttemptCount = 0;
const MAX_BODY_CAPTURE_SUCCESSES = 1;
// Currently DISABLED (set to 0). PR #3701 added the capture path to
// surface ArcGIS's slow 400 body when the direct fetch timed out before
// the body could land. Today's rebalanced budgets (FETCH_TIMEOUT=15s,
// PROXY_FETCH_TIMEOUT=70s) make the capture path redundant: the proxy
// retry now has enough budget (70s) to catch ArcGIS's 51-56s response
// directly, and arcgisProxyRetry already throws the parsed
// `body.error.message` as an `ArcGIS error (via proxy after ...)` Error.
// The country circuit-breaker's regex matches that, so the threshold
// circuit-breaker (PR #3701) fires on proxy-returned errors without
// needing a separate diagnostic capture re-fetch. Setting attempts=0
// keeps the code path intact (and the once-per-run gate code) for any
// future scenario where direct-fetch DOES land close to a body (e.g. a
// non-Railway egress where direct works), but skips the 40s overhead
// during the current Railway-throttled-direct + proxy-works mode.
const MAX_BODY_CAPTURE_ATTEMPTS = 0;

// Best-effort body capture when the initial fetch times out at
// FETCH_TIMEOUT. Used to surface the actual ArcGIS error body during
// degradation episodes (see ERROR_BODY_CAPTURE_EXTRA_MS comment).
// Returns `{error}` if the response body contains an ArcGIS error,
// `{body}` if it contains a normal response, or null if the re-fetch
// itself failed (caller falls through to proxy retry as before).
async function _captureErrorBodyAfterTimeout(url, signal, fetchFn) {
  if (signal?.aborted) return null;
  const captureSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ERROR_BODY_CAPTURE_EXTRA_MS)])
    : AbortSignal.timeout(ERROR_BODY_CAPTURE_EXTRA_MS);
  try {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: captureSignal,
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    if (body?.error) {
      console.warn(`  [port-activity] degraded ArcGIS response captured: ${JSON.stringify(body.error).slice(0, 160)} (${url.slice(0, 80)})`);
      return { error: body.error };
    }
    return { body };
  } catch {
    return null;
  }
}

// Fetch ALL ports globally in one paginated pass, grouped by ISO3.
// ArcGIS server-cap: advance by actual features.length, never PAGE_SIZE.
export async function fetchAllPortRefs({
  signal,
  fetchFn,
  proxyRetryFn,
  sleepFn = waitForRetry,
  // Run-level wall-clock deadline. This loop has no per-page timeout wrap, so
  // without it a rate-limit cooldown on every page would be unbounded against
  // the bundle's section timeout.
  deadlineAt,
} = {}) {
  const byIso3 = new Map();
  let offset = 0;
  let body;
  let page = 0;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    // This loop has no page cap and no per-page wrap: `while
    // (body.exceededTransferLimit)` will keep going as long as ArcGIS keeps
    // saying there is more, at up to FETCH_TIMEOUT + PROXY_FETCH_TIMEOUT per
    // page. Two such pages eat most of the run's non-activity headroom. Stop
    // before a page that cannot finish inside the run's budget, so the failure
    // is this explicit error — which retains last-good state through main()'s
    // catch — rather than a SIGTERM partway through page N.
    if (Number.isFinite(deadlineAt)
      && Date.now() + FETCH_TIMEOUT + PROXY_FETCH_TIMEOUT > deadlineAt) {
      throw Object.assign(
        new Error(`ArcGIS reference fetch exceeded its run budget after ${page} page(s)`),
        { refreshFailureCode: 'timeout' },
      );
    }
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
    const url = `${EP4_BASE}?${params}`;
    body = await retryRateLimited(
      (attemptSignal) => fetchWithTimeout(url, {
        signal: attemptSignal,
        fetchFn,
        proxyRetryFn,
      }),
      { signal, sleepFn, label: `reference page ${page}`, deadlineAt },
    );
    const features = validatedPage(body, `reference page ${page}`, offset);
    for (const f of features) {
      const a = f?.attributes;
      if (a?.portid == null || !/^[A-Z]{3}$/.test(a?.ISO3)) {
        throw incompletePage(`invalid reference row on page ${page}`);
      }
      const iso3 = String(a.ISO3);
      const portId = String(a.portid);
      let ports = byIso3.get(iso3);
      if (!ports) { ports = new Map(); byIso3.set(iso3, ports); }
      if (ports.has(portId)) throw incompletePage(`duplicate reference port ${portId}`);
      ports.set(portId, { lat: Number(a.lat ?? 0), lon: Number(a.lon ?? 0) });
    }
    console.log(`  [port-activity]   ref page ${page}: +${features.length} ports (${byIso3.size} countries so far)`);
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
  return byIso3;
}

function incompletePage(message) {
  return Object.assign(new Error(`ArcGIS incomplete page: ${message}`), {
    refreshFailureCode: 'incomplete_page',
  });
}

function validatedPage(body, label, offset = 0) {
  if (!Array.isArray(body?.features)
    || (body.exceededTransferLimit !== undefined && typeof body.exceededTransferLimit !== 'boolean')
    || ((body.exceededTransferLimit === true || offset > 0) && body.features.length === 0)) {
    throw incompletePage(label);
  }
  return body.features;
}

// Resolve the queryable date-column name on Daily_Ports_Data. ArcGIS treats
// alias and name as separate concepts — alias stays "date" forever (it's
// metadata, displayed in catalogs), but `name` is what WHERE / outFields /
// orderByFields / outStatistics actually accept, and IMF has flapped the
// `name` between `date` and `date_` (reserved-keyword sweep on 2026-04-29
// flipped to `date_` at ~02:54 UTC, then reverted to `date` by ~12:09 UTC,
// so a hardcoded literal breaks twice in the same incident).
//
// Strategy: introspect the layer schema once per process, find the field
// whose alias is "date" (alias is the stable signal), use its `name` for
// the rest of the run. Falls back to ARCGIS_DATE_FIELD_FALLBACK on error
// so transient schema-endpoint failures don't kill the whole seed run.
//
// Memoisation: cache the in-flight PROMISE, not the resolved value, so
// concurrent first-callers share one schema round-trip. The
// fetchAll-driven flow awaits the resolver before any parallel work, so
// in practice only one call ever races — but the defensive fall-throughs
// in paginateWindowInto / fetchMaxDate / fetchCountryAccum can be invoked
// from outside fetchAll (tests, future callers), so the once-inflight
// pattern is the load-bearing safety. Greptile P2 on PR #3496.
let _arcgisDateFieldPromise = null;
export function resolveArcgisDateField({ signal } = {}) {
  if (!_arcgisDateFieldPromise) {
    _arcgisDateFieldPromise = _doResolveArcgisDateField({ signal });
  }
  return _arcgisDateFieldPromise;
}

async function _doResolveArcgisDateField({ signal } = {}) {
  try {
    const body = await fetchWithTimeout(EP3_SCHEMA, { signal });
    const fields = Array.isArray(body?.fields) ? body.fields : [];
    // Prefer alias-match (canonical: alias is what humans named it, name is
    // what the SQL parser eats). Fall back to a name-equality match if no
    // alias hit, in case IMF ever reverses the alias too.
    const byAlias = fields.find((f) => f && f.alias === 'date' &&
      (f.type === 'esriFieldTypeDateOnly' || f.type === 'esriFieldTypeDate'));
    const byName = fields.find((f) => f && (f.name === 'date' || f.name === 'date_') &&
      (f.type === 'esriFieldTypeDateOnly' || f.type === 'esriFieldTypeDate'));
    const resolved = byAlias?.name || byName?.name || ARCGIS_DATE_FIELD_FALLBACK;
    if (!byAlias && !byName) {
      console.warn(`  [port-activity] schema introspection found no date field — using fallback "${ARCGIS_DATE_FIELD_FALLBACK}"`);
    } else if (resolved !== ARCGIS_DATE_FIELD_FALLBACK) {
      console.log(`  [port-activity] resolved ArcGIS date field name: "${resolved}" (alias=date)`);
    }
    return resolved;
  } catch (err) {
    console.warn(`  [port-activity] schema introspection failed (${err?.message || err}) — using fallback "${ARCGIS_DATE_FIELD_FALLBACK}"`);
    return ARCGIS_DATE_FIELD_FALLBACK;
  }
}

// Test-only helper: clears the module-level cache so unit tests can
// re-exercise the resolver with different mocked schemas.
export function _resetArcgisDateFieldCache() {
  _arcgisDateFieldPromise = null;
}

// Paginate a single ArcGIS EP3 window into per-port accumulators. Called
// twice per country — once for each aggregation window (last30, prev30) —
// in parallel so heavy countries no longer have to serialise through both
// windows inside a single 90s cap.
async function paginateWindowInto(portAccumMap, _iso3, where, windowKind, {
  signal,
  dateField,
  forceProxy = false,
  fetchFn,
  proxyRetryFn,
} = {}) {
  // Defensive: callers should always thread dateField through, but if a
  // future caller forgets, fall back to the resolver (idempotent + cached).
  const df = dateField || (await resolveArcgisDateField({ signal }));
  let offset = 0;
  let acceptedRowCount = 0;
  const seenRows = new Set();
  let body;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const params = new URLSearchParams({
      where,
      // ArcGIS treats alias and name as separate — alias stays "date" but
      // the queryable name has flapped between `date` and `date_`. Resolved
      // dynamically via resolveArcgisDateField() at run start.
      outFields: `portid,portname,ISO3,${df},portcalls_tanker,import_tanker,export_tanker`,
      returnGeometry: 'false',
      // NO orderByFields — DateOnly sort cliff (WM 2026-05-06 trap).
      // ArcGIS migrated Daily_Ports_Data's `date` column to
      // `esriFieldTypeDateOnly`. Server-side sort on DateOnly is 10-15×
      // slower than no-sort: BRA 60d page = 46.6s with `portid ASC,date ASC`
      // vs 4.0s with no orderBy. With 174 countries × ≥3 pages each + a 90s
      // per-country cap, every per-country fetch was timing out (36+ errors
      // per bundle run, container SIGTERM'd at the 540s budget).
      //
      // The aggregation below (paginateWindowInto's portAccumMap) is
      // ORDER-INDEPENDENT — it sums portcalls/import/export per portId
      // without caring about row order. So we don't even need a client-side
      // sort fallback. ArcGIS still provides a consistent default order
      // (ObjectId ASC) across pages, so resultOffset pagination remains
      // correct.
      //
      // If a future caller of this endpoint genuinely needs ordered output
      // (e.g. for a "latest N" tail query), do the sort client-side after
      // pagination completes — orderBy on the request side is a 10× tax.
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithTimeout(`${EP3_BASE}?${params}`, {
      signal,
      forceProxy,
      fetchFn,
      proxyRetryFn,
    });
    const features = validatedPage(body, `${_iso3} ${windowKind} offset ${offset}`, offset);
    for (const f of features) {
      const a = f?.attributes;
      if (!a || a.portid == null || a[df] == null || !Number.isFinite(new Date(a[df]).getTime())) {
        throw incompletePage(`invalid activity row for ${_iso3}`);
      }
      const rowId = `${a.portid}:${a[df]}`;
      if (seenRows.has(rowId)) throw incompletePage(`duplicate activity row for ${_iso3}`);
      seenRows.add(rowId);
      acceptedRowCount += 1;
      const portId = String(a.portid);
      const calls = Number(a.portcalls_tanker ?? 0);
      const imports = Number(a.import_tanker ?? 0);
      const exports_ = Number(a.export_tanker ?? 0);
      if (![calls, imports, exports_].every((value) => Number.isFinite(value) && value >= 0)) {
        throw incompletePage(`invalid activity metrics for ${_iso3}`);
      }

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

  return acceptedRowCount;
}

// Parse a "YYYY-MM-DD" string (from ArcGIS outStatistics max(date)) into an
// epoch-ms anchor used as the upper bound of the last30 window. Uses the
// END of the day (23:59:59.999 UTC) so rows dated exactly maxDate still
// satisfy `date <= anchor`. Returns null on parse failure; callers fall
// back to `Date.now()` when anchor is null.
// Where the dataset actually ends this run: the newest preflight that answered.
// Free — these are calls the preflight already made — and it is the anchor a
// country whose own preflight errored should inherit.
//
// The alternative, Date.now(), silently asserts upstream is current, and that
// assertion is the failure mode this exists to stop. ArcGIS's max(date) lags
// real-time by ~10 days even when healthy, and on 2026-08-21 the feed stopped
// entirely: 1,481 rows/day through the 21st, then 0/day. A now-anchored 30-day
// window still catches the 21st today, so the bug is invisible — but once the
// stall passes 30 days every now-anchored country returns zero rows, scores
// `empty_activity`, stops refreshing, and drops out at the 7-day cache wall: a
// fleet-wide collapse to 0/174 caused by our own fallback, not by upstream.
// Anchored on the real max date the same countries keep serving indefinitely,
// which is what the anchor was introduced for (#3299).
export function deriveRunAnchorMs(maxDateStrings) {
  const list = Array.isArray(maxDateStrings) ? maxDateStrings : [];
  let newest = null;
  for (const value of list) {
    const parsed = parseMaxDateToAnchor(value);
    if (parsed === null) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest;
}

// A country's own observed max date wins. On a failed preflight, its last known
// max date wins over the run anchor because country maxima can publish at
// different times. undefined (not null) is returned when nothing is known, so
// fetchCountryAccum's `?? Date.now()` still applies when no preflight answered.
export function resolveCountryAnchorMs(upstreamMaxDate, runAnchorMs, priorAsof) {
  const own = parseMaxDateToAnchor(upstreamMaxDate);
  if (own !== null) return own;
  const prior = parseMaxDateToAnchor(priorAsof);
  if (prior !== null) return prior;
  return Number.isFinite(runAnchorMs) ? runAnchorMs : undefined;
}

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
export async function fetchCountryAccum(iso3, {
  signal,
  anchorEpochMs,
  dateField,
  forceProxy = false,
  fetchFn,
  proxyRetryFn,
} = {}) {
  const anchor = anchorEpochMs ?? Date.now();
  const cutoff30 = anchor - 30 * 86400000;
  const cutoff60 = anchor - 60 * 86400000;
  const df = dateField || (await resolveArcgisDateField({ signal }));

  const portAccumMap = new Map();

  // ARCGIS_DATE_FIELD: queryable column name is resolved dynamically at run
  // start via resolveArcgisDateField. The `timestamp 'YYYY-MM-DD HH:MM:SS'`
  // literal works on both the esriFieldTypeDateOnly and esriFieldTypeDate
  // shapes ArcGIS may serve.
  const [currentWindowRowCount] = await Promise.all([
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND ${df} > ${epochToTimestamp(cutoff30)}`,
      'last30',
      { signal, dateField: df, forceProxy, fetchFn, proxyRetryFn },
    ),
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND ${df} > ${epochToTimestamp(cutoff60)} AND ${df} <= ${epochToTimestamp(cutoff30)}`,
      'prev30',
      { signal, dateField: df, forceProxy, fetchFn, proxyRetryFn },
    ),
  ]);

  return { portAccumMap, currentWindowRowCount };
}

// A direct empty feature set is not proof that a country has no activity.
// ArcGIS returned empty sets for active countries during the 2026-09-02
// rate-limit incident. Only an explicit null max-date observation with current
// EP4 references can publish zero. Every other empty gets one proxy-only retry
// inside the caller's existing per-country timeout.
export async function fetchCountryActivityWithRecovery(iso3, {
  signal,
  anchorEpochMs,
  dateField,
  preflightObservation,
  refMap,
  fetchAccumFn = fetchCountryAccum,
  sleepFn = waitForRetry,
  // When the caller's per-country wrap fires (withPerCountryTimeout), so a
  // rate-limit cooldown that would outlive it is declined rather than started.
  deadlineAt,
} = {}) {
  const currentWindowExpected = preflightObservation?.status === 'observed'
    && preflightObservation.maxDate !== null;
  const isUsableActivity = (result) => result?.portAccumMap instanceof Map
    && result.portAccumMap.size > 0
    && (!currentWindowExpected || result.currentWindowRowCount > 0);

  const directResult = await retryRateLimited(
    (attemptSignal) => fetchAccumFn(iso3, {
      signal: attemptSignal,
      anchorEpochMs,
      dateField,
      forceProxy: false,
    }),
    { signal, sleepFn, label: iso3, deadlineAt },
  );
  if (isUsableActivity(directResult)) {
    return { portAccumMap: directResult.portAccumMap, verifiedZero: false };
  }

  const verifiedZero = directResult?.portAccumMap instanceof Map
    && directResult.portAccumMap.size === 0
    && preflightObservation?.status === 'observed'
    && preflightObservation.maxDate === null
    && refMap instanceof Map
    && refMap.size > 0;
  if (verifiedZero) {
    return { portAccumMap: new Map(), verifiedZero: true };
  }

  console.warn(`  [port-activity] ${iso3}: unverified empty activity — retrying via proxy`);
  const proxiedResult = await retryRateLimited(
    (attemptSignal) => fetchAccumFn(iso3, {
      signal: attemptSignal,
      anchorEpochMs,
      dateField,
      forceProxy: true,
    }),
    {
      signal,
      maxRetries: 0,
      sleepFn,
      label: `${iso3} proxy empty recovery`,
    },
  );
  if (isUsableActivity(proxiedResult)) {
    return { portAccumMap: proxiedResult.portAccumMap, verifiedZero: false };
  }

  throw Object.assign(new Error('unverified empty activity after proxy retry'), {
    refreshFailureCode: 'invalid_empty',
  });
}

// Cheap preflight: single outStatistics query returning max(date) for one
// country. Used to skip the expensive fetch when upstream data hasn't
// advanced since the last cached run. ~1-2s per call at ArcGIS's current
// steady-state. Keeps an explicit null max date separate from a failed or
// malformed observation so the publication path cannot turn failure into zero.
export function parseMaxDateObservation(body) {
  const attrs = body?.features?.[0]?.attributes;
  if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, 'max_date')) {
    return { status: 'failed', maxDate: null };
  }
  const raw = attrs.max_date;
  if (raw === null) return { status: 'observed', maxDate: null };

  let maxDate;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      maxDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
  } else if (typeof raw === 'string') {
    const candidate = raw.slice(0, 10);
    const parsedCandidate = Date.parse(`${candidate}T00:00:00Z`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)
        && Number.isFinite(parsedCandidate)
        && new Date(parsedCandidate).toISOString().slice(0, 10) === candidate) {
      maxDate = candidate;
    }
  }

  return maxDate
    ? { status: 'observed', maxDate }
    : { status: 'failed', maxDate: null };
}

async function fetchMaxDate(iso3, { signal, dateField } = {}) {
  const df = dateField || (await resolveArcgisDateField({ signal }));
  const outStats = JSON.stringify([{
    statisticType: 'max',
    // See ARCGIS_DATE_FIELD comment in fetchCountryAccum: the queryable
    // column name is resolved dynamically (alias=date, name flaps).
    // outStatisticFieldName is the response key — unchanged on purpose so
    // callers keep reading `attrs.max_date`.
    onStatisticField: df,
    outStatisticFieldName: 'max_date',
  }]);
  const params = new URLSearchParams({
    where: `ISO3='${iso3}'`,
    outStatistics: outStats,
    f: 'json',
  });
  try {
    // Preflight uses a tight direct timeout and SKIPS proxy fallback so the
    // 174-country preflight phase can't blow the 570s container budget
    // under ArcGIS degradation (Greptile PR #3711 P1). Failures fall
    // through to the expensive per-country activity path which has the
    // full direct+proxy budget. Preflight is best-effort cache invalidation.
    const body = await fetchWithTimeout(`${EP3_BASE}?${params}`, {
      signal,
      timeoutMs: PREFLIGHT_FETCH_TIMEOUT,
      noProxyFallback: true,
    });
    return parseMaxDateObservation(body);
  } catch {
    return { status: 'failed', maxDate: null };
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

export async function publishPortActivitySnapshot(
  {
    countryData,
    retryState = new Map(),
    countries,
    metaPayload,
    canonicalAdvances,
  },
  {
    fetchFn = fetch,
    credentials = getRedisCredentials(),
  } = {},
) {
  // State-only entries retain the last successful payload (or a bounded
  // failure marker for a never-cached country) without adding that country to
  // the published canonical list. Published data wins if a key appears in
  // both maps.
  const stateByCountry = new Map(retryState);
  for (const entry of countryData) stateByCountry.set(...entry);

  const commands = [...stateByCountry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iso2, payload]) => [
      'SET',
      `${KEY_PREFIX}${iso2}`,
      JSON.stringify(payload),
      'EX',
      TTL,
    ]);
  if (canonicalAdvances) {
    commands.push(['SET', CANONICAL_KEY, JSON.stringify(countries), 'EX', TTL]);
  }
  if (metaPayload) commands.push(['SET', META_KEY, JSON.stringify(metaPayload), 'EX', TTL]);
  if (canonicalAdvances) {
    // No EX: "this producer can publish content freshness" must survive the
    // 3-day payload TTL, otherwise health would silently re-enter its
    // pending-activation grace every time a run is skipped.
    commands.push(['SET', PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY, '1']);
  }
  if (commands.length === 0) return [];

  // Upstash /pipeline preserves command order but is explicitly non-atomic.
  // The canonical list and seed-meta are the publication pointers, so they
  // must commit in the same transaction as the per-country state they name.
  const resp = await fetchFn(`${credentials.url}/multi-exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis transaction failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  const results = await resp.json();
  if (!Array.isArray(results) || results.length !== commands.length) {
    throw new Error(`Redis transaction failed: ${results?.error || 'invalid response'}`);
  }
  const failures = results.filter((result) => result?.error || result?.result === 'ERR');
  if (failures.length > 0) {
    throw new Error(`Redis transaction: ${failures.length}/${commands.length} commands failed`);
  }
  return results;
}

const CORRUPT_COUNTRY_CACHE = Symbol('corrupt country cache');

// MGET-style batch read via the Upstash REST /pipeline endpoint. Returns an
// array aligned with `keys` where each element is either the parsed JSON
// payload, explicit miss, or confirmed corrupt value. Transport/envelope errors
// remain fatal: only a validated upstream replacement may overwrite corruption.
// Primes the per-country cache lookup in one round-trip instead of 174 GETs.
async function redisMgetJson(keys) {
  if (keys.length === 0) return [];
  const commands = keys.map((k) => ['GET', k]);
  const results = await redisPipeline(commands);
  if (!Array.isArray(results) || results.length !== keys.length) {
    throw new Error('PortWatch cache read returned incomplete results');
  }
  return results.map((r) => {
    if (r?.error || !Object.hasOwn(r ?? {}, 'result')) throw new Error('PortWatch cache read failed');
    if (r.result === null) return null;
    if (typeof r.result !== 'string') throw new Error('PortWatch cache read returned invalid result');
    try {
      const payload = JSON.parse(r.result);
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload : CORRUPT_COUNTRY_CACHE;
    } catch {
      return CORRUPT_COUNTRY_CACHE;
    }
  });
}

// fetchAll() — pure data collection, no Redis writes.
// Returns { countries: string[], countryData: Map<iso2, payload>, fetchedAt: string }.
//
// `progress` (optional) is mutated in-place so a SIGTERM handler in main()
// can report which batch / country we died on.
//
// Orders cold-fetches by the oldest ATTEMPT, using the last successful cache
// write as the legacy fallback. This is the durable rotation cursor:
//
//   - never-attempted countries have no timestamp and go first;
//   - a successful fetch updates cacheWrittenAt + refreshAttemptedAt;
//   - a failed fetch updates only refreshAttemptedAt, so it stays truthfully
//     stale but cannot monopolise every subsequent 30-country batch.
//
// The previous random shuffle did not encode progress. A deterministic
// reproduction that supplied the same RNG selected the same 30 countries in
// all six runs, and production dropped 21 seven-day-old cached countries while
// refreshing younger misses. Oldest-attempt-first guarantees one complete
// attempt sweep in ceil(174 / 30) = 6 runs, independent of process restarts.
// ISO2 is the deterministic tie-breaker so equal-age cohorts do not depend on
// ArcGIS row order. Pure + exported for unit testing.
export function classifyDeferredPayload(
  prevPayload,
  now = Date.now(),
  maxCacheAgeMs = MAX_CACHE_AGE_MS,
) {
  if (!prevPayload || typeof prevPayload !== 'object'
    || !Array.isArray(prevPayload.ports)
    || !prevPayload.ports.every((port) => port && typeof port.portId === 'string' && port.portId.length > 0)
    || (prevPayload.ports.length === 0 && prevPayload.zeroActivity !== true)
    || !Number.isFinite(prevPayload.cacheWrittenAt)
    || prevPayload.cacheWrittenAt > now) {
    return { status: 'missing', payload: null };
  }
  if ((now - prevPayload.cacheWrittenAt) >= maxCacheAgeMs) {
    return { status: 'expired', payload: null };
  }
  return { status: 'stale', payload: { ...prevPayload, staleAsof: true } };
}

// Shared by refreshFailureCode (which classifies an error object) and
// classifyBatchCircuitBreak (which classifies the rendered diagnostic strings).
// One definition so a breaker arm can never drift from the failure code that
// the same upstream response persists onto the country.
const INVALID_QUERY_PATTERN = /invalid query parameters/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i;

function refreshFailureCode(reason) {
  if (reason?.refreshFailureCode) return reason.refreshFailureCode;
  const text = `${reason?.code || ''} ${reason?.message || reason || ''}`;
  if (INVALID_QUERY_PATTERN.test(text)) return 'invalid_query';
  if (RATE_LIMIT_PATTERN.test(text)) return 'rate_limited';
  if (/timeout|timed out|abort/i.test(text)) return 'timeout';
  return 'fetch_error';
}

// Batch-1 circuit-breaker classification. A batch that is overwhelmingly one
// failure class is an upstream posture, not a set of flakes: `invalid_query` is
// a schema/policy regression (the 2026-04-29 `date` -> `date_` rename) and
// `rate_limited` is a throttle window (#8501) that the rest of the run would
// only deepen. Both mean "stop spending the budget", so both get an arm.
// Pure + exported so the trip thresholds are testable without a live run.
export const CIRCUIT_BREAKER_TRIP_RATE = 0.8;
export function classifyBatchCircuitBreak(
  errors,
  batchSize,
  tripRate = CIRCUIT_BREAKER_TRIP_RATE,
) {
  if (!Array.isArray(errors) || !Number.isFinite(batchSize) || batchSize <= 0) return null;
  // invalid_query is tested first so a batch carrying both classes reports the
  // one that no amount of backing off can recover.
  for (const [code, pattern] of [
    ['invalid_query', INVALID_QUERY_PATTERN],
    ['rate_limited', RATE_LIMIT_PATTERN],
  ]) {
    const rate = errors.filter((entry) => pattern.test(String(entry))).length / batchSize;
    if (rate >= tripRate) return { code, rate };
  }
  return null;
}

// What a tripped breaker should DO — the two classes need opposite responses.
//
// `invalid_query` is unrecoverable within the run (schema/policy regression):
// the remaining batches would fail identically, so abort and keep last-good.
//
// `rate_limited` is NOT. The 2026-09-22 incident landed 6 of 30 countries while
// 24 were throttled, so batch 1 sits right at the 80% trip rate — aborting
// there would abandon 24 of the 30 cold-fetch slots and cut the run's recovery
// rate roughly fivefold, at exactly the moment the expiring-tail priority tier
// needs those slots to pull countries back from the seven-day cliff. The right
// response to a throttle is to stop hammering, not to stop working: jump
// straight to the widest inter-batch gap and keep the remaining batches.
export function circuitBreakerAction(tripped) {
  if (!tripped) return 'continue';
  return tripped.code === 'invalid_query' ? 'abort' : 'slow-down';
}

// Inter-batch gap, doubled for each CONSECUTIVE batch that saw rate limiting and
// capped both per-gap (MAX_RATE_LIMITED_BATCH_BACKOFF_MS) and per-run
// (RATE_LIMIT_BACKOFF_BUDGET_MS, via `spentExtraMs`). Batch-level is the right
// place for this lever: ArcGIS throttles the source, not the country, so spacing
// the next six concurrent fetches does more than retrying one country sooner. A
// clean batch resets the escalation. Never returns less than the baseline gap.
export function rateLimitedBatchBackoffMs(
  consecutiveRateLimitedBatches,
  {
    baseMs = BATCH_BACKOFF_MS,
    maxMs = MAX_RATE_LIMITED_BATCH_BACKOFF_MS,
    spentExtraMs = 0,
    extraBudgetMs = RATE_LIMIT_BACKOFF_BUDGET_MS,
    // Wall-clock room the caller still has for extra backoff, already net of
    // whatever the next batch needs. Infinity when the caller has no deadline.
    availableMs = Number.POSITIVE_INFINITY,
  } = {},
) {
  const escalations = Number.isFinite(consecutiveRateLimitedBatches)
    && consecutiveRateLimitedBatches > 0
    ? Math.floor(consecutiveRateLimitedBatches)
    : 0;
  const wanted = Math.min(maxMs, baseMs * 2 ** escalations);
  const remainingBudget = Math.max(0, extraBudgetMs - Math.max(0, spentExtraMs));
  const wallClockRoom = Math.max(0, availableMs);
  return baseMs + Math.min(wanted - baseMs, remainingBudget, wallClockRoom);
}

function waitForRetry(delayMs, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('aborted'));
    };
    const done = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry only the rate-limit failure class. Other ArcGIS errors (invalid query,
// timeout, empty result) must retain their existing failure semantics so a
// global upstream regression still reaches the circuit-breaker and coverage
// gates without being hidden by a generic retry loop.
export async function retryRateLimited(
  operation,
  {
    signal,
    delayMs = RATE_LIMIT_RETRY_DELAY_MS,
    maxRetries = MAX_RATE_LIMIT_RETRIES,
    sleepFn = waitForRetry,
    label = 'country',
    // Per-country wrap deadline (epoch ms). Omitted by callers that have no
    // wrap, in which case the budget check below is inert.
    deadlineAt,
    minAttemptMs = RATE_LIMIT_RETRY_MIN_ATTEMPT_MS,
  } = {},
) {
  let retries = 0;
  while (true) {
    const attemptController = new AbortController();
    const attemptSignal = signal
      ? AbortSignal.any([signal, attemptController.signal])
      : attemptController.signal;
    try {
      return await operation(attemptSignal);
    } catch (reason) {
      // fetchCountryAccum runs its two windows in parallel. Abort the sibling
      // window before retrying so one fast 429 cannot overlap a second full
      // country attempt and amplify the upstream rate limit.
      attemptController.abort(reason);
      if (
        retries >= maxRetries
        || refreshFailureCode(reason) !== 'rate_limited'
        || signal?.aborted
      ) {
        throw reason;
      }
      // Declining a retry that cannot finish keeps the failure truthfully
      // `rate_limited`. Starting one anyway hands the country back as
      // `timeout`, which the batch circuit-breaker cannot read as throttling.
      if (Number.isFinite(deadlineAt) && Date.now() + delayMs + minAttemptMs > deadlineAt) {
        console.warn(
          `  [port-activity] ${label}: rate-limited — skipping retry, ` +
          `${Math.max(0, Math.round((deadlineAt - Date.now()) / 1000))}s left is under the ` +
          `${(delayMs + minAttemptMs) / 1000}s cooldown-plus-attempt budget`,
        );
        throw reason;
      }
      retries += 1;
      console.warn(
        `  [port-activity] ${label}: rate-limited — retrying ` +
        `after ${delayMs}ms (${retries}/${maxRetries})`,
      );
      await sleepFn(delayMs, signal);
    }
  }
}

export function buildRefreshFailureState(item, reason, attemptedAt = Date.now()) {
  const prev = item?.prevPayload && typeof item.prevPayload === 'object'
    ? item.prevPayload
    : { iso2: item?.iso2 };
  const previousFailures = Number(prev.refreshFailure?.consecutiveFailures);
  return {
    ...prev,
    iso2: item?.iso2 || prev.iso2,
    refreshAttemptedAt: attemptedAt,
    refreshFailure: {
      code: refreshFailureCode(reason),
      consecutiveFailures: Number.isFinite(previousFailures) ? previousFailures + 1 : 1,
      lastAttemptAt: attemptedAt,
    },
  };
}

export function buildCoverageReport({
  eligibleCountries,
  expectedCountries = [],
  countryData,
  retryState = new Map(),
  refreshFailures = [],
}) {
  const eligible = [...new Set(eligibleCountries)].sort();
  const expected = [...new Set([...expectedCountries, ...eligible])].sort();
  const target = Math.max(PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES, expected.length);
  const missingCountries = expected.filter((iso2) => !countryData.has(iso2));
  const unidentifiedMissingCount = Math.max(0, target - expected.length);
  const failureByCountry = new Map();
  // Deferred failures remain actionable until that country is recovered or
  // positively revalidated; another country's success must not hide them.
  for (const [iso2, state] of [...countryData, ...retryState]) {
    if (typeof state?.refreshFailure?.code === 'string') {
      failureByCountry.set(iso2, state.refreshFailure.code);
    }
  }
  for (const { iso2, code } of refreshFailures) {
    if (typeof code === 'string') failureByCountry.set(iso2, code);
  }
  const failures = [...failureByCountry]
    .map(([iso2, code]) => ({ iso2, code }))
    .sort((a, b) => a.iso2.localeCompare(b.iso2));
  const payloads = [...countryData.values()];
  const retainedCountryCount = payloads.filter((payload) => payload.staleAsof === true).length;
  const cacheTimes = payloads.map((payload) => payload.cacheWrittenAt).filter(Number.isFinite);
  return {
    target,
    referenceCountryCount: eligible.length,
    published: countryData.size,
    currentCountryCount: countryData.size - retainedCountryCount,
    retainedCountryCount,
    oldestCountryCacheWrittenAt: cacheTimes.length ? Math.min(...cacheTimes) : null,
    complete: missingCountries.length === 0 && unidentifiedMissingCount === 0,
    missingCountries,
    unidentifiedMissingCount,
    refreshFailures: failures,
  };
}

// fetchAll is the orchestrator (refs → schema → preflight → cache-partition
// → batched fetch → finalise); splitting it would move complexity into a
// hidden seam and obscure the linear pipeline. Each stage is short and
// well-commented.
export async function fetchAll(progress, {
  signal,
  expectedCountries = [],
  // Wall-clock point past which no further batch is dispatched and no extra
  // rate-limit backoff is spent. main() supplies both; omitted in unit tests,
  // which then have no deadline.
  runDeadlineAt,
  refsDeadlineAt,
} = {}) {
  const { iso3ToIso2 } = createCountryResolvers();

  // Resolve the queryable date-column name once per run, before any
  // country-level work. Threaded through to fetchMaxDate, fetchCountryAccum,
  // and paginateWindowInto so a single name flap on the upstream side
  // can't half-break the run.
  if (progress) progress.stage = 'schema';
  const dateField = await resolveArcgisDateField({ signal });

  if (progress) progress.stage = 'refs';
  console.log('  [port-activity] Fetching global port reference (EP4)...');
  const t0 = Date.now();
  const refsByIso3 = await fetchAllPortRefs({
    signal,
    deadlineAt: refsDeadlineAt ?? runDeadlineAt,
  });
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
  //   2. `cacheWrittenAt` leaves enough time for a bounded refresh rotation
  // Either check failing → fall through to the expensive paginated fetch.
  //
  // Cold run (no cache / legacy payloads without asof) always falls through.
  // ─────────────────────────────────────────────────────────────────────────
  if (progress) progress.stage = 'cache-lookup';
  const cacheT0 = Date.now();
  const prevKeys = eligibleIso3.map((iso3) => `${KEY_PREFIX}${iso3ToIso2.get(iso3)}`);
  // An unreadable prior payload is not a cache miss: a failed refresh must
  // never overwrite unknown last-good data with a scheduler-only marker.
  const prevPayloads = await redisMgetJson(prevKeys);
  console.log(`  [port-activity] Loaded ${prevPayloads.filter(Boolean).length}/${prevKeys.length} cached payloads (${((Date.now() - cacheT0) / 1000).toFixed(1)}s)`);

  // Preflight: maxDate check for every eligible country in parallel.
  // Each request is tiny (1 row outStatistics), so we push to PREFLIGHT_CONCURRENCY
  // which is higher than the expensive-fetch CONCURRENCY.
  if (progress) progress.stage = 'preflight';
  const preflightT0 = Date.now();
  const preflightObservations = new Array(eligibleIso3.length).fill(null);
  for (let i = 0; i < eligibleIso3.length; i += PREFLIGHT_CONCURRENCY) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const slice = eligibleIso3.slice(i, i + PREFLIGHT_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((iso3) => fetchMaxDate(iso3, { signal, dateField })),
    );
    for (let j = 0; j < slice.length; j++) {
      const r = settled[j];
      preflightObservations[i + j] = r.status === 'fulfilled'
        ? r.value
        : { status: 'failed', maxDate: null };
    }
  }
  console.log(`  [port-activity] Preflight maxDate for ${eligibleIso3.length} countries (${((Date.now() - preflightT0) / 1000).toFixed(1)}s)`);

  // See deriveRunAnchorMs for why Date.now() is not the fallback.
  const maxDates = preflightObservations.map((observation) =>
    observation?.status === 'observed' ? observation.maxDate : null,
  );
  const runAnchorFallbackMs = deriveRunAnchorMs(maxDates);
  if (runAnchorFallbackMs === null) {
    console.warn('  [port-activity] No preflight returned a max date — per-country windows fall back to now, which is only correct if upstream really is current.');
  }

  // Partition: cache hits (reusable) vs misses (need expensive fetch).
  // For misses, capture `prevPayload` (may be null) so that if we end up
  // deferring this country to a later run we can still serve its previous
  // (slightly-stale) data — better than dropping it entirely.
  const countryData = new Map();
  let needsFetch = [];
  let cacheHits = 0;
  const now = Date.now();
  // Reserve a full sweep plus one missed cron before the seven-day expiry.
  // Critical countries can consume their slots on every run. Without this
  // lead, unchanged upstream dates keep a synchronized cohort cached until
  // all countries expire together, when only 30 can recover per run.
  const rotationSlots = MAX_COLD_FETCH_PER_RUN - PORTWATCH_DECISION_CRITICAL_COUNTRIES.length;
  const refreshLeadMs = (Math.ceil(eligibleIso3.length / rotationSlots) + 1)
    * PORTWATCH_CONTENT_FRESHNESS_CADENCE_MINUTES * 60_000;
  const refreshAgeMs = Math.max(0, MAX_CACHE_AGE_MS - refreshLeadMs);
  for (let i = 0; i < eligibleIso3.length; i++) {
    const iso3 = eligibleIso3[i];
    const iso2 = iso3ToIso2.get(iso3);
    const preflightObservation = preflightObservations[i];
    const upstreamMaxDate = preflightObservation?.status === 'observed'
      ? preflightObservation.maxDate
      : null;
    const prev = prevPayloads[i];
    const criticalRefreshDue = isCriticalContentRefreshDue({
      iso2,
      prevPayload: prev,
      now,
    });
    const observationMatches = preflightObservation?.status === 'observed'
      && (upstreamMaxDate !== null
        ? prev?.asof === upstreamMaxDate
        : prev?.asof === null && prev?.zeroActivity === true);
    const cacheFresh = !criticalRefreshDue
      && classifyDeferredPayload(prev, now).status === 'stale'
      && now - prev.cacheWrittenAt < refreshAgeMs
      && observationMatches;
    if (cacheFresh) {
      const { refreshFailure: _failure, staleAsof: _stale, ...confirmed } = prev;
      countryData.set(iso2, confirmed);
      cacheHits++;
    } else {
      needsFetch.push({
        iso3,
        iso2,
        upstreamMaxDate,
        preflightObservation,
        prevPayload: prev,
      });
    }
  }
  console.log(`  [port-activity] Cache: ${cacheHits} hits, ${needsFetch.length} misses`);

  // Cold-fetch cap (WM 2026-05-13 incident): when needsFetch exceeds the
  // per-run cap, refresh the oldest-attempt subset and serve the rest from
  // prior cache marked staleAsof=true. Prevents the catastrophic "everything
  // stale → 174 cold-fetches → bundle SIGTERM" failure mode that produced
  // 37h of stale data after a single upstream-advance event. A nominal attempt
  // sweep takes ceil(174/30) = 6 runs (3d); allow a seventh run when
  // critical countries reserve repeat slots.
  let servedStaleCount = 0;
  let droppedTooOldCount = 0;
  let droppedNoCacheCount = 0;
  // Payloads retained for scheduler state but intentionally excluded from the
  // canonical publication (expired last-good data or a failed never-cached
  // attempt). Writing these keeps the durable attempt cursor alive without
  // claiming the country is covered.
  const retryState = new Map();
  const refreshFailures = [];
  const retainPriorState = (iso2, payload, evaluatedAt) => {
    const deferredState = classifyDeferredPayload(payload, evaluatedAt);
    if (deferredState.status === 'stale') {
      countryData.set(iso2, deferredState.payload);
      servedStaleCount++;
      return;
    }
    if (payload && typeof payload === 'object') retryState.set(iso2, payload);
    if (deferredState.status === 'expired') droppedTooOldCount++;
    else droppedNoCacheCount++;
  };
  // Counts fresh upstream successes this run (fetched-fresh path, line ~904).
  // cacheHits also counts as a current upstream observation.
  // Served-stale entries do NOT count: they're prior-run data being held
  // over, no upstream contact this run.
  let freshFetchedCount = 0;

  if (needsFetch.length > MAX_COLD_FETCH_PER_RUN) {
    // Oldest-attempt-first provides the durable rotation state that a random
    // shuffle cannot: successful and failed attempts both move behind work that
    // has not received a slot in the current sweep. Never-attempted countries
    // naturally sort first, retaining #4293's no-cache recovery property.
    const ordered = orderColdFetchQueue(needsFetch, undefined, { now });
    const deferred = ordered.slice(MAX_COLD_FETCH_PER_RUN);
    const countsBefore = {
      servedStale: servedStaleCount,
      droppedTooOld: droppedTooOldCount,
      droppedNoCache: droppedNoCacheCount,
    };
    for (const item of deferred) {
      retainPriorState(item.iso2, item.prevPayload, now);
    }
    const servedStale = servedStaleCount - countsBefore.servedStale;
    const droppedTooOld = droppedTooOldCount - countsBefore.droppedTooOld;
    const droppedNoCache = droppedNoCacheCount - countsBefore.droppedNoCache;
    needsFetch = ordered.slice(0, MAX_COLD_FETCH_PER_RUN);
    // Rotation arithmetic uses MAX_COLD_FETCH_PER_RUN directly rather than
    // needsFetch.length — needsFetch was just reassigned to the cap-sized
    // slice, so the two are numerically equal here, but using the constant
    // keeps the intent unambiguous if this log block is ever reordered.
    const originalMisses = MAX_COLD_FETCH_PER_RUN + servedStale + droppedTooOld + droppedNoCache;
    console.warn(
      `  [port-activity] Cold-fetch capped at ${MAX_COLD_FETCH_PER_RUN}/run — ` +
      `refreshing ${MAX_COLD_FETCH_PER_RUN} now, retaining ${servedStale} usable cached payloads (refresh deferred), ` +
      `${droppedTooOld} dropped (cache >= ${MAX_CACHE_AGE_MS / 86_400_000}d old), ${droppedNoCache} dropped (no prior payload). ` +
      `Rotation: ~${Math.ceil(originalMisses / MAX_COLD_FETCH_PER_RUN)} runs to fully refresh.`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Expensive path: paginated fetch for cache misses only.
  // ─────────────────────────────────────────────────────────────────────────
  if (progress) progress.stage = 'activity';
  const batches = Math.ceil(needsFetch.length / CONCURRENCY);
  if (progress) progress.totalBatches = batches;
  console.log(`  [port-activity] Activity queue: ${needsFetch.length} countries (skipped ${cacheHits} via cache, ${skipped} unmapped, concurrency ${CONCURRENCY}, per-country cap ${PER_COUNTRY_TIMEOUT_MS / 1000}s)`);

  const errors = progress?.errors ?? [];
  const activityStart = Date.now();
  const retainFailedAttempt = (item, reason, attemptedAt) => {
    const state = buildRefreshFailureState(item, reason, attemptedAt);
    refreshFailures.push({
      iso2: item.iso2,
      code: state.refreshFailure.code,
    });
    // A transient refresh failure must not discard still-usable data.
    // refreshAttemptedAt advances rotation fairness; cacheWrittenAt remains
    // unchanged, so the hard-expiry decision stays truthful.
    // A corrupt stored value was read successfully but is not usable state.
    // Keep its original bytes if repair fails; never replace it with a marker.
    retainPriorState(item.iso2,
      item.prevPayload === CORRUPT_COUNTRY_CACHE ? item.prevPayload : state,
      attemptedAt);
  };

  const completedFetches = new Set();
  // Consecutive batches that saw rate limiting, driving the inter-batch gap,
  // and the extra backoff spent so far against RATE_LIMIT_BACKOFF_BUDGET_MS.
  let consecutiveRateLimitedBatches = 0;
  let rateLimitBackoffSpentMs = 0;
  for (let i = 0; i < needsFetch.length; i += CONCURRENCY) {
    const batch = needsFetch.slice(i, i + CONCURRENCY);
    const batchIdx = Math.floor(i / CONCURRENCY) + 1;
    // The backoff clamp only shortens sleeping; it cannot shorten WORK, and the
    // activity loop's own ceiling (batches x PER_COUNTRY_TIMEOUT_MS) plus the
    // bounded prefix/suffix phases already exceeds the section timeout with
    // zero backoff spent. Stop dispatching once a batch cannot finish inside
    // the run's budget: this break lands on the same last-good retention path
    // the invalid_query breaker uses, so the tick ends as the lossless
    // publish-blocked outcome instead of a SIGTERM mid-batch that destroys
    // in-flight work and reports a hard bundle failure.
    if (Number.isFinite(runDeadlineAt) && Date.now() + PER_COUNTRY_TIMEOUT_MS > runDeadlineAt) {
      console.warn(
        `  [port-activity] run deadline reached at batch ${batchIdx}/${batches} — ` +
        'skipping the remaining batches; unattempted countries retain last-good state.',
      );
      break;
    }
    const attemptedAt = Date.now();
    const errorsBeforeBatch = errors.length;
    if (progress) progress.batchIdx = batchIdx;

    const promises = batch.map(({
      iso3,
      upstreamMaxDate,
      preflightObservation,
      prevPayload,
    }) => {
      // Anchor the rolling windows to upstream max(date) so the aggregate
      // is stable day-over-day when upstream is frozen (required for cache
      // reuse to be semantically correct — see PR #3299 review P1).
      //
      // A failed preflight reuses the country's own cached anchor before the
      // run anchor — see resolveCountryAnchorMs.
      const anchorEpochMs = resolveCountryAnchorMs(
        upstreamMaxDate,
        runAnchorFallbackMs,
        prevPayload?.asof,
      );
      const deadlineAt = Date.now() + PER_COUNTRY_TIMEOUT_MS;
      const p = withPerCountryTimeout(
        (childSignal) => fetchCountryActivityWithRecovery(iso3, {
          signal: childSignal,
          anchorEpochMs,
          dateField,
          preflightObservation,
          refMap: refsByIso3.get(iso3),
          deadlineAt,
        }),
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
      completedFetches.add(iso2);
      if (outcome.status === 'rejected') {
        retainFailedAttempt(batch[j], outcome.reason, attemptedAt);
        continue; // diagnostic already recorded via eager .catch
      }
      const { portAccumMap, verifiedZero } = outcome.value ?? {};
      if (!portAccumMap || (portAccumMap.size === 0 && !verifiedZero)) {
        const reason = Object.assign(new Error('invalid country activity outcome'), {
          refreshFailureCode: 'invalid_empty',
        });
        errors.push(`${iso3}: ${reason.message}`);
        retainFailedAttempt(batch[j], reason, attemptedAt);
        continue;
      }
      const ports = finalisePortsForCountry(portAccumMap, refsByIso3.get(iso3));
      if (!ports.length && !verifiedZero) {
        const reason = Object.assign(new Error('empty final port list'), {
          refreshFailureCode: 'empty_ports',
        });
        errors.push(`${iso3}: ${reason.message}`);
        retainFailedAttempt(batch[j], reason, attemptedAt);
        continue;
      }
      const refreshedAt = Date.now();
      countryData.set(iso2, {
        iso2,
        ports,
        zeroActivity: verifiedZero,
        fetchedAt: new Date(refreshedAt).toISOString(),
        // Content clock (#6060): advances only when upstream's own max(date)
        // advances, so a forced refetch of FROZEN upstream data cannot reset it
        // and green the content-freshness alarm. Seeded from the upstream
        // observation date when no prior clock exists — stamping `refreshedAt`
        // there would report a frozen upstream as fresh for a full budget
        // window after rollout, since every payload predates this field.
        // A verified zero is a successful current observation, not a failed
        // preflight. Refresh its content clock when the seven-day cache expires.
        contentAsOfChangedAt: verifiedZero
          ? refreshedAt
          : contentClockFor(batch[j].prevPayload, upstreamMaxDate, refreshedAt),
        // Cache fields. `asof` is null for a failed preflight or a verified
        // zero. Only the verified-zero marker can make a later explicit null
        // observation reuse this payload.
        asof: upstreamMaxDate,
        cacheWrittenAt: refreshedAt,
        refreshAttemptedAt: attemptedAt,
      });
      freshFetchedCount++;
    }

    if (progress) progress.seeded = countryData.size;
    if (batchIdx === 1 || batchIdx % BATCH_LOG_EVERY === 0 || batchIdx === batches) {
      const elapsed = ((Date.now() - activityStart) / 1000).toFixed(1);
      console.log(`  [port-activity]   batch ${batchIdx}/${batches}: ${countryData.size} usable country payloads assembled; ${errors.length} refresh errors; persistence pending (${elapsed}s)`);
    }

    const batchErrors = errors.slice(errorsBeforeBatch);
    const batchWasRateLimited = batchErrors.some((entry) => RATE_LIMIT_PATTERN.test(String(entry)));
    consecutiveRateLimitedBatches = batchWasRateLimited
      ? consecutiveRateLimitedBatches + 1
      : 0;

    // Circuit-breaker: if batch 1 is ≥80% rejected with the SAME class of
    // error, treat it as an upstream global posture — not a flake that more
    // retries will clear. Skip the remaining batches and preserve their
    // last-good state below. Cuts failure cost ~30s → ~2s and keeps Sentry
    // signal-to-noise sane during incidents like the 2026-04-29 IMF PortWatch
    // `date` → `date_` rename (invalid_query) and the 2026-09-22 ArcGIS
    // throttle (rate_limited, #8501), where continuing only deepened the
    // throttle and burned the full 60s before throwing anyway.
    if (batchIdx === 1 && batches > 1 && batch.length >= 5) {
      const tripped = classifyBatchCircuitBreak(batchErrors, batch.length);
      const action = circuitBreakerAction(tripped);
      if (action === 'abort') {
        console.error(
          `  [port-activity] CIRCUIT-BREAKER: ${(tripped.rate * 100).toFixed(0)}% of batch 1 rejected as ` +
          `${tripped.code} — assuming upstream schema/policy regression, which the remaining batches ` +
          `cannot beat. Skipping remaining ${batches - 1} batches; ` +
          `unattempted countries will retain last-good state. First error: ${batchErrors[0]}`,
        );
        break;
      }
      if (action === 'slow-down') {
        console.warn(
          `  [port-activity] CIRCUIT-BREAKER: ${(tripped.rate * 100).toFixed(0)}% of batch 1 rejected as ` +
          `${tripped.code} — widening to the maximum inter-batch gap and continuing. The remaining ` +
          `${batches - 1} batches keep their cold-fetch slots: a throttle still lets a minority through, ` +
          `and those slots are what pull the expiring tail back from the ${MAX_CACHE_AGE_MS / 86_400_000}-day cliff. ` +
          `First error: ${batchErrors[0]}`,
        );
        consecutiveRateLimitedBatches = Math.max(
          consecutiveRateLimitedBatches,
          RATE_LIMIT_ESCALATION_STEPS_TO_MAX,
        );
      }
    }

    // Inter-batch backoff. Spaces out per-batch bursts so neither
    // ArcGIS-direct nor Decodo-proxy hits its rate-limit window from our
    // run alone (post-#3681 run #2 showed Decodo throttling us after run
    // #1 hammered it back-to-back: 24/30 → 5/30 success rate degradation).
    // Skip on the final batch — no point waiting before exiting the loop.
    //
    // On caller-signal abort: skip the sleep AND break the loop.
    // Greptile PR #3694 P2: pre-fix this was "skip the sleep only" which
    // still started the next batch's 6 concurrent fetches before the
    // onSigterm → process.exit(1) backstop fired. Now the loop exits
    // immediately so SIGTERM doesn't start additional in-flight work.
    if (signal?.aborted) break;
    if (batchIdx < batches) {
      // Wall-clock room for EXTRA backoff, already net of the per-country wrap
      // the next batch may need. Keeps a widened gap from eating the time the
      // batch it precedes depends on, and collapses to the baseline near the
      // deadline. No deadline (unit tests) leaves the static budget in charge.
      const availableMs = Number.isFinite(runDeadlineAt)
        ? runDeadlineAt - Date.now() - PER_COUNTRY_TIMEOUT_MS
        : Number.POSITIVE_INFINITY;
      const backoffMs = rateLimitedBatchBackoffMs(consecutiveRateLimitedBatches, {
        spentExtraMs: rateLimitBackoffSpentMs,
        availableMs,
      });
      rateLimitBackoffSpentMs += backoffMs - BATCH_BACKOFF_MS;
      if (backoffMs > BATCH_BACKOFF_MS) {
        console.warn(
          `  [port-activity] batch ${batchIdx} saw rate limiting ` +
          `(${consecutiveRateLimitedBatches} consecutive) — widening the next gap to ${backoffMs / 1000}s ` +
          `(${rateLimitBackoffSpentMs / 1000}s of the ${RATE_LIMIT_BACKOFF_BUDGET_MS / 1000}s run budget spent)`,
        );
      }
      // Abort-aware sleep: previously a plain setTimeout(BATCH_BACKOFF_MS)
      // that ignored the caller signal mid-sleep, so a SIGTERM during the
      // 5s backoff still made the loop wait the full 5s before observing
      // the abort. Race the sleep against signal.aborted so the loop exits
      // immediately on a real cancellation (which then surfaces via the
      // signal?.aborted check at the top of the next iteration).
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        if (!signal) return;
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  const unattemptedFetches = needsFetch.filter(({ iso2 }) => !completedFetches.has(iso2));
  if (unattemptedFetches.length > 0) {
    const evaluatedAt = Date.now();
    for (const item of unattemptedFetches) {
      retainPriorState(item.iso2, item.prevPayload, evaluatedAt);
    }
    console.warn(
      `  [port-activity] ${unattemptedFetches.length} queued countries were not attempted; ` +
      'retained last-good or scheduler-only state without advancing their attempt cursor.',
    );
  }

  if (errors.length) {
    console.warn(`  [port-activity] ${errors.length} country errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' ...' : ''}`);
  }

  const countries = [...countryData.keys()];
  const coverage = buildCoverageReport({
    eligibleCountries: eligibleIso3.map((iso3) => iso3ToIso2.get(iso3)),
    expectedCountries,
    countryData,
    retryState,
    refreshFailures,
  });
  if (!coverage.complete) {
    const failureCodes = coverage.refreshFailures.length > 0
      ? ` Refresh failures: ${coverage.refreshFailures.map(({ iso2, code }) => `${iso2}:${code}`).join(', ')}.`
      : '';
    console.error(
      `  [port-activity] COVERAGE GAPS: ${coverage.published}/${coverage.target} usable; ` +
      `countries without usable payloads: ${coverage.missingCountries.join(', ') || 'none'}; ` +
      `unidentified shortfall: ${coverage.unidentifiedMissingCount}.${failureCodes}`,
    );
  }
  return {
    countries,
    countryData,
    retryState,
    coverage,
    fetchedAt: new Date().toISOString(),
    servedStaleCount,
    droppedTooOldCount,
    droppedNoCacheCount,
    // Report current observations separately from usable retained coverage.
    freshFetchedCount,
    cacheHitCount: cacheHits,
  };
}

export function shouldAdvanceCanonicalForRun({
  countryCount,
  referenceCountryCount,
  upstreamContactCount,
  coverage,
}) {
  return referenceCountryCount >= PORTWATCH_PORT_ACTIVITY_TARGET_COUNTRIES
    && coverage?.complete === true
    && coverage.refreshFailures.length === 0
    && countryCount === coverage.target
    // Daily source advances must not invalidate a completed rolling sweep.
    // Every country must remain usable, and this run must do useful upstream
    // work. Per-country timestamps and content clocks remain unchanged on reuse.
    && upstreamContactCount > 0;
}

// Why a run that cannot advance the canonical list could not, split into the
// two outcomes that deserve different exit codes (#8501).
//
// `rotation_incomplete` is the run where every expected country is still
// published and usable and the ONLY unmet advance condition is that some
// countries failed to refresh — the twice-daily ArcGIS throttle. Nothing was
// lost: TTLs were extended, the canonical list retained, the failure recorded
// in seed-meta for the freshness monitor to alarm on. Throwing there turned a
// partially-successful rotation into a Railway "Deploy Crashed!" every 12h.
//
// `coverage_shortfall` is everything else: a country fell out of coverage (a
// payload crossed MAX_CACHE_AGE_MS, or never had one), the reference feed came
// back short, or the run made no upstream contact at all. Those stay exit 1.
//
// Defining the soft case as "shouldAdvanceCanonicalForRun would pass but for
// refreshFailures" keeps the two functions from drifting: any new advance
// condition is automatically a hard failure until someone decides otherwise.
export function classifyPublicationBlock(input) {
  if (shouldAdvanceCanonicalForRun(input)) return null;
  const refreshFailures = input?.coverage?.refreshFailures ?? [];
  // `complete` is DERIVED by buildCoverageReport from missingCountries and
  // unidentifiedMissingCount — fields this function is handed but never
  // inspects. Re-asserting them here means the soft outcome rests on the
  // evidence of full coverage rather than on a boolean it did not compute, so
  // a coverage object that ever disagrees with itself takes the loud path
  // instead of riding a green tick with a country genuinely missing.
  const everyCountryStillCovered = (input?.coverage?.missingCountries?.length ?? 0) === 0
    && (input?.coverage?.unidentifiedMissingCount ?? 0) === 0;
  const blockedOnlyByRefreshFailures = refreshFailures.length > 0
    && everyCountryStillCovered
    && shouldAdvanceCanonicalForRun({
      ...input,
      coverage: { ...input.coverage, refreshFailures: [] },
    });
  if (blockedOnlyByRefreshFailures) {
    return {
      kind: 'rotation_incomplete',
      exitCode: PUBLISH_BLOCKED_EXIT_CODE,
      reason: `${refreshFailures.length} of ${input.coverage.target} countries failed to refresh `
        + `(${[...new Set(refreshFailures.map(({ code }) => code))].sort().join(', ')}); `
        + 'every country remains published and usable',
    };
  }
  return {
    kind: 'coverage_shortfall',
    exitCode: 1,
    reason: `usable coverage ${input?.countryCount ?? 0}/${input?.coverage?.target ?? 0}, `
      + `reference ${input?.referenceCountryCount ?? 0}, `
      + `upstream contacts ${input?.upstreamContactCount ?? 0}, `
      + `${refreshFailures.length} refresh failures`,
  };
}

// The process exit code for a completed run, as the isMain wrapper applies it.
// Pure and exported because the wrapper itself never executes under test (the
// harness imports the module, so isMain is false), which left the whole point
// of #8501 — leaving with 76 rather than 1 — provable only by grepping source.
export function exitCodeForOutcome(outcome) {
  return outcome?.publishBlocked === true ? PUBLISH_BLOCKED_EXIT_CODE : 0;
}

export function buildPortActivityFailureMeta(previousMeta, {
  coverage,
  reason,
  now = Date.now(),
} = {}) {
  return {
    ...previousMeta,
    sourceState: 'error',
    errorCode: `PORTWATCH_${(reason ? refreshFailureCode(reason) : 'coverage_partial').toUpperCase()}`,
    lastAttemptAt: now,
    coverage: {
      ...coverage,
      complete: false,
      status: coverage ? 'partial' : 'degraded',
      completionRatio: coverage ? coverage.published / coverage.target : null,
    },
  };
}

export async function main() {
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
  let previousMeta;
  let previousRead = false;
  let failureRecorded = false;

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
      if (previousRead) await publishPortActivitySnapshot({
        countryData: new Map(),
        canonicalAdvances: false,
        metaPayload: buildPortActivityFailureMeta(previousMeta, { reason: new Error('SIGTERM') }),
      });
    } catch {}
    try { await releaseLock(LOCK_DOMAIN, runId); } catch {}
    process.exit(1);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  try {
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY, { strict: true });
    previousMeta = await readSeedSnapshot(META_KEY, { strict: true });
    if (prevIso2List !== null && (!Array.isArray(prevIso2List)
      || prevIso2List.some((iso2) => typeof iso2 !== 'string' || !/^[A-Z]{2}$/.test(iso2)))) {
      throw new Error('Invalid PortWatch canonical snapshot');
    }
    if (previousMeta !== null && (typeof previousMeta !== 'object' || Array.isArray(previousMeta))) {
      throw new Error('Invalid PortWatch seed metadata');
    }
    previousRead = true;
    prevCountryKeys = Array.isArray(prevIso2List) ? prevIso2List.map(iso2 => `${KEY_PREFIX}${iso2}`) : [];

    console.log(`  Fetching port activity data (60d: last30 + prev30 windows)...`);
    const {
      countries,
      countryData,
      servedStaleCount,
      droppedTooOldCount,
      droppedNoCacheCount,
      freshFetchedCount,
      cacheHitCount,
      retryState,
      coverage,
    } = await fetchAll(progress, {
      signal: shutdownController.signal,
      expectedCountries: Array.isArray(prevIso2List) ? prevIso2List : [],
      runDeadlineAt: startedAt + RUN_DISPATCH_DEADLINE_MS,
      refsDeadlineAt: startedAt + REF_FETCH_DEADLINE_MS,
    });

    console.log(`  Assembled ${countryData.size} usable country payloads; persistence pending`);

    const advanceInput = {
      countryCount: countryData.size,
      referenceCountryCount: coverage.referenceCountryCount,
      upstreamContactCount: freshFetchedCount + cacheHitCount,
      coverage,
    };
    const canonicalAdvances = !shutdownController.signal.aborted
      && shouldAdvanceCanonicalForRun(advanceInput);
    const metaPayload = canonicalAdvances
      ? { ...buildPortActivityMetaPayload({ countryData, coverage: { ...coverage, status: 'complete', completionRatio: 1 } }), sourceState: 'ok' }
      : buildPortActivityFailureMeta(previousMeta, { coverage });

    let canonicalTtlExtended = false;
    if (!canonicalAdvances) {
      const retention = await extendExistingTtlDetailed([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL);
      canonicalTtlExtended = retention.extendedKeys.includes(CANONICAL_KEY);
      console.error(
        `  INCOMPLETE RUN: ${countryData.size}/${coverage.target} usable countries; ` +
        `${freshFetchedCount} fetched, ${cacheHitCount} cache-fresh, ${servedStaleCount} stale-served, ` +
        `${droppedTooOldCount} expired, ${droppedNoCacheCount} missing. ` +
        'Full publication blocked; recovery-state and failure-metadata writes pending.',
      );
    }

    console.log(`  Persistence pending: usable coverage ${countryData.size}/${coverage.target}; ${coverage.refreshFailures.length} unresolved refresh failures`);
    await publishPortActivitySnapshot({
      countryData,
      retryState,
      countries,
      metaPayload,
      canonicalAdvances,
    });
    failureRecorded = !canonicalAdvances;
    let canonicalState = 'no prior canonical list';
    if (canonicalAdvances) {
      canonicalState = `canonical list advanced to ${countries.length} countries`;
    } else if (prevIso2List !== null) {
      canonicalState = canonicalTtlExtended
        ? `canonical list retained at ${prevIso2List.length} countries`
        : `canonical retention unconfirmed (${prevIso2List.length} countries at run start)`;
    }
    console.log(
      `  ${canonicalAdvances ? 'State saved' : 'Recovery state saved'}; ${canonicalState}; ` +
      `usable coverage ${countryData.size}/${coverage.target}; ` +
      `${canonicalAdvances ? '' : 'full publication blocked; '}` +
      `${coverage.refreshFailures.length} unresolved refresh failures`,
    );
    if (!canonicalAdvances) {
      // Two states disqualify the soft outcome before coverage is even
      // consulted:
      //   - a SIGTERM-aborted run never reached a verdict on its own coverage;
      //   - an unconfirmed canonical retention means the ONE key the blocked
      //     path does not rewrite (publishPortActivitySnapshot only pushes
      //     CANONICAL_KEY when the canonical advances) may not have had its TTL
      //     extended. At TTL/cron = 259200s/12h, six such runs expire the
      //     canonical list and the product surface goes dark — so this must
      //     stay the loud exit 1 it was, not a green publish-blocked tick.
      const canonicalAtRisk = prevIso2List !== null && !canonicalTtlExtended;
      const block = shutdownController.signal.aborted
        ? { kind: 'coverage_shortfall', reason: 'run aborted before coverage was decided' }
        : canonicalAtRisk
        ? { kind: 'coverage_shortfall', reason: 'canonical retention unconfirmed; its TTL may not have been extended' }
        : classifyPublicationBlock(advanceInput);
      if (block?.kind === 'rotation_incomplete') {
        console.warn(
          `  ROTATION INCOMPLETE: ${block.reason}. Canonical retained and recovery state written; ` +
          `exiting ${block.exitCode} so the bundle reports publish-blocked rather than a crash. ` +
          'The seed-meta freshness monitor owns the alarm if this persists.',
        );
        return { publishBlocked: true };
      }
      throw new Error(`Incomplete PortWatch coverage; canonical retained — ${block?.reason ?? 'unknown'}`);
    }

    logSeedResult('supply_chain', countryData.size, Date.now() - startedAt, { source: 'portwatch-ports' });
    console.log(`  Seeded ${countryData.size} countries`);
    console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
  } catch (err) {
    console.error(`  SEED FAILED: ${err.message}`);
    await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
    if (previousRead && !failureRecorded) {
      await publishPortActivitySnapshot({
        countryData: new Map(),
        canonicalAdvances: false,
        metaPayload: buildPortActivityFailureMeta(previousMeta, { reason: err }),
      });
    }
    throw err;
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigterm);
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-port-activity.mjs');
if (isMain) {
  main().then((outcome) => {
    // #6396 exit code: the coverage gate refused to advance the canonical list
    // after preserving last-good. The bundle runner reports PUBLISH_BLOCKED and
    // exits 0, so a stalled rotation stops painting Railway CRASHED (#8501).
    //
    // exitCode, not process.exit: the bundle runner pipes this child's stdout,
    // so console writes are asynchronous and process.exit can drop them. On
    // this path the ROTATION INCOMPLETE line is the only human-readable reason
    // the tick was publish-blocked — the runner's own summary just says the
    // gate refused. Letting the loop drain keeps that diagnostic.
    process.exitCode = exitCodeForOutcome(outcome);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
