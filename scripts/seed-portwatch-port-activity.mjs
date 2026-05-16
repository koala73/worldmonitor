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
// Coverage gate. TEMPORARILY lowered from 50 → 25 on 2026-05-14 to let
// seed-meta refresh while ArcGIS is in a degraded rate-limit state.
// Background: post-#3681 the proxy retry IS firing, but both direct AND
// proxy paths are throttled — successful per-country fetches dropped from
// 24 → 5 between successive runs as Decodo hit its own rate-limit. With
// gate=50 the seed-meta stayed frozen at 2026-05-12 00:03 UTC for 60+ hours.
// Lowering to 25 lets a partial-success run advance the meta and clears
// the operator-facing WARNING while ArcGIS recovers. Revert to 50 once
// successive runs reliably exceed 50 again (target: 2026-05-20 review).
const MIN_VALID_COUNTRIES = 25;

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
// WM 2026-05-15 incident probe (direct laptop, direct laptop-via-Decodo, and
// Railway logs): ArcGIS Daily_Ports_Data currently responds in 51-56s for
// most queries when accessed through Decodo's gate.decodo.com pool. Direct
// access from Railway container IPs is fully throttled (never returns within
// 60s). Pre-fix budgets (45s direct + 35s proxy) couldn't catch either the
// direct response (Railway throttled) or the proxy response (under-budgeted
// for 51-56s class), so every cold fetch hit "proxy fetch timeout".
//
// Rebalanced: fail direct fast (Railway-direct doesn't work anyway), give the
// proxy leg enough budget to actually capture the 51-56s ArcGIS responses
// that Decodo IS successfully tunneling. Total: 15 + 70 = 85s, fits the 90s
// per-country wrap with 5s slack.
const FETCH_TIMEOUT = 15_000;
// Proxy leg gets the bulk of the per-country budget. 70s comfortably catches
// ArcGIS's 51-56s response class observed today. Even when the body is a
// 400 "Invalid query parameters" (PR #3701 degradation pattern), it arrives
// within this window — which means fetchWithRetryOnInvalidParams's
// circuit-breaker actually fires now, surfacing the real upstream signal
// instead of silent timeouts.
const PROXY_FETCH_TIMEOUT = 70_000;
// Preflight-specific direct timeout. The fetchMaxDate preflight runs once
// per eligible country (174 today) at PREFLIGHT_CONCURRENCY=24 BEFORE the
// cold-fetch cap partitions countries into refresh-now vs serve-stale, so
// without a tighter budget the preflight phase alone could blow the 570s
// container budget under ArcGIS degradation:
//   ceil(174/24)=8 waves × (FETCH_TIMEOUT 15s + PROXY_FETCH_TIMEOUT 70s)
//   = 680s worst case — over the 570s bundle budget BEFORE useful work.
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
// rebalanced budgets (FETCH_TIMEOUT=15s direct + PROXY_FETCH_TIMEOUT=70s
// proxy) let the proxy leg receive the 51-56s body directly, and
// arcgisProxyRetry throws an "ArcGIS error (via proxy after ...)"
// message that the circuit-breaker matches — so the capture re-fetch is
// no longer load-bearing. This constant stays at 40s for the day the
// attempt cap is bumped back > 0 (e.g. non-Railway egress where direct
// works), with the proviso that any caller re-enabling capture should
// re-derive the budget against the FETCH_TIMEOUT in effect at that time.
const ERROR_BODY_CAPTURE_EXTRA_MS = 40_000;
// After this many "Invalid query parameters" errors in a single process,
// stop retrying on them — that's a degradation signal, not a transient
// flake. The historical comment on fetchWithRetryOnInvalidParams notes
// "a single retry with a short back-off clears it in practice", which
// was true for the 2026-04-20 BRA/IDN/NGA transient. NOT true during the
// 2026-05-15 degradation episode where every cold-fetch hit the same
// 400 and the retry burned another full FETCH_TIMEOUT for nothing
// (30 cold × 2 attempts × 45s = blown 540s container budget). Counter
// is module-local and resets at process start (next cron tick).
const INVALID_PARAMS_RETRY_THRESHOLD = 5;
// Minimum FRESH upstream successes (cache-fresh OR fetched-fresh) required
// for cap-mode to bypass the 80% degradation guard. Pre-fix the bypass was
// unconditional, which meant a run with `servedStale=27, freshSuccess=0,
// dropped=117` could pass `countryData.size >= MIN_VALID_COUNTRIES` (all
// stale-served entries) AND bypass the degradation guard (capTriggered),
// shrinking the canonical list from ~174 → 27 stale-only entries and
// advancing seed-meta — hiding the upstream outage.
//
// Floor at 5 fresh successes: meaningful upstream contact this run.
// Below that, cap-mode is NOT a rotational steady-state — it's an
// ArcGIS-completely-down scenario, and the 80% guard should fire (which
// extendExistingTtl-only on prior payloads, preserves canonical list,
// keeps WARNING visible to the operator).
const MIN_FRESH_FETCH_FOR_CAP_BYPASS = 5;
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
// Concurrency for the per-country activity fetch. Halved from 12 → 6 on
// 2026-05-14 to ease pressure on both ArcGIS direct AND Decodo proxy paths,
// which were each hitting their own rate-limits in the post-3676/3681 runs
// (24/30 successes on run #1, 5/30 on run #2 as Decodo throttled us).
// Math at concurrency 6 + cold-fetch cap 30:
//   5 batches × ~60s realistic (90s worst-case per country) + 4×5s backoff
//   ≈ 320s realistic, 470s worst case — fits the 570s bundle budget.
const CONCURRENCY = 6;
// Cooldown between activity-fetch batches. Spaces out per-batch bursts so
// neither ArcGIS-direct nor Decodo-proxy hits its rate-limit window from
// our run alone. 5s × 4 inter-batch gaps = 20s total added to a 30-country
// run — negligible against the 570s bundle budget.
const BATCH_BACKOFF_MS = 5_000;
const BATCH_LOG_EVERY = 5;
// Cache hygiene: force a full refetch if the cached payload is older than 7 days
// even when upstream maxDate is unchanged. Protects against window-shift drift
// (cached aggregates were computed against a window that's now 7+ days offset
// from today's last30/prev30 cutoffs) and serves as a belt-and-braces refresh
// if the maxDate check ever silently short-circuits.
const MAX_CACHE_AGE_MS = 7 * 86_400_000;
// Cap how many countries can be cold-fetched in a single run. When upstream
// advances its data (asof mismatch on a sync'd cache), all 174 countries
// become "cache miss" at once. Cold-fetching 174 against ArcGIS exceeds the
// 570s bundle budget (observed 2026-05-13: preflight alone took 360s, batch 1
// of 15 hit 12 errors in 45s before container died at the budget cap).
//
// With this cap, a "everything stale" run refreshes a random subset and
// serves the remainder from prior cache (marked staleAsof=true so downstream
// can see they're a window behind). A full rotation completes in ~6 runs
// = ~3 days at the 12h cron cadence, well within the 7-day MAX_CACHE_AGE_MS.
//
// 30 is sized so the cold-fetch path (30 × ~3-5s/country with concurrency
// 12 ≈ 12-15s) easily fits the 570s budget even when ArcGIS is slow.
const MAX_COLD_FETCH_PER_RUN = 30;
// Concurrency for the cheap per-country maxDate preflight. These are tiny
// outStatistics queries (returns 1 row), so we can push harder than the
// expensive fetch concurrency without tripping ArcGIS 429s in practice.
const PREFLIGHT_CONCURRENCY = 24;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

// Retry an ArcGIS request through the Decodo proxy. Used as the fallback
// path when the direct request returns 429 OR silently times out — both
// are signals that ArcGIS is rate-limiting our seed-server IP. Returns the
// parsed JSON body or throws.
//
// Uses PROXY_FETCH_TIMEOUT (70s, gives the bulk of PER_COUNTRY_TIMEOUT_MS to
// the proxy leg). Direct FETCH_TIMEOUT (15s) + PROXY_FETCH_TIMEOUT (70s) =
// 85s, fits the 90s per-country wrap with 5s slack for Decodo's TCP
// handshake and CONNECT setup. See PR #3711 incident notes for the
// rebalance — Railway-direct is currently fully throttled by ArcGIS, so
// "fail fast direct, give proxy the budget" is the right shape.
async function arcgisProxyRetry(url, reason, { signal } = {}) {
  const proxyAuth = resolveProxyForConnect();
  if (!proxyAuth) throw new Error(`ArcGIS direct ${reason} + no proxy configured for ${url.slice(0, 80)}`);
  console.warn(`  [portwatch] ${reason} — retrying via proxy: ${url.slice(0, 80)}`);
  const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: PROXY_FETCH_TIMEOUT, signal });
  const proxied = JSON.parse(buffer.toString('utf8'));
  if (proxied.error) {
    // Greptile PR #3681 review P2: ArcGIS can return `{"error":{"code":400}}`
    // with no message field. Fall back to code, then JSON.stringify so the
    // thrown error message stays informative on unexpected error shapes.
    const errInfo = proxied.error.message ?? proxied.error.code ?? JSON.stringify(proxied.error);
    throw new Error(`ArcGIS error (via proxy after ${reason}): ${errInfo}`);
  }
  return proxied;
}

async function fetchWithTimeout(url, { signal, timeoutMs = FETCH_TIMEOUT, noProxyFallback = false } = {}) {
  // Combine the per-call timeoutMs with the upstream caller signal so an
  // abort propagates into the in-flight fetch AND future pagination iterations.
  //
  // Options:
  //   timeoutMs        — defaults to FETCH_TIMEOUT (15s). Caller can override
  //                       for tighter/looser budgets (preflight uses 5s).
  //   noProxyFallback  — if true, timeout/429 throws instead of routing to
  //                       arcgisProxyRetry. Used by preflight so a degraded
  //                       upstream can't burn the container budget on
  //                       best-effort cache-invalidation probes (PR #3711 P1).
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
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
    // circuit-breaker (fetchWithRetryOnInvalidParams) never saw the
    // real message. If THIS re-fetch lands a body with `body.error`,
    // surface its message so the circuit-breaker can fire on the
    // upstream-degradation signal.
    //
    // Currently DISABLED via MAX_BODY_CAPTURE_ATTEMPTS=0 — see the
    // constant comment for rationale. Today's budgets (FETCH_TIMEOUT=15s,
    // PROXY_FETCH_TIMEOUT=70s) make this path redundant: the proxy leg
    // has enough budget to receive ArcGIS's 51-56s slow response
    // directly, including the 400 error body, which arcgisProxyRetry
    // throws as a message that fetchWithRetryOnInvalidParams matches.
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
      const captured = await _captureErrorBodyAfterTimeout(url, signal);
      if (captured?.error) {
        _bodyCaptureSuccessCount += 1;
        throw new Error(`ArcGIS error: ${captured.error.message ?? captured.error.code ?? JSON.stringify(captured.error)}`);
      }
      if (captured?.body) {
        _bodyCaptureSuccessCount += 1;
        return captured.body;
      }
      // captured=null: capture also timed out / errored. Don't count as
      // success — fall through to proxy retry, leaving attempts budget
      // for the next timing-out country in case that one settles faster.
    }
    return await arcgisProxyRetry(url, `direct ${errName || 'timeout'}`, { signal });
  }
  if (resp.status === 429) {
    // Preflight (noProxyFallback) treats 429 as a soft failure: throw and
    // let the caller fall through to the expensive per-country path.
    if (noProxyFallback) throw new Error(`ArcGIS HTTP 429 (preflight, no proxy fallback)`);
    return await arcgisProxyRetry(url, 'HTTP 429 rate-limited', { signal });
  }
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
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
// fetchWithRetryOnInvalidParams's regex matches that, so the threshold
// circuit-breaker (PR #3701) fires on proxy-returned errors without
// needing a separate diagnostic capture re-fetch. Setting attempts=0
// keeps the code path intact (and the once-per-run gate code) for any
// future scenario where direct-fetch DOES land close to a body (e.g. a
// non-Railway egress where direct works), but skips the 40s overhead
// during the current Railway-throttled-direct + proxy-works mode.
const MAX_BODY_CAPTURE_ATTEMPTS = 0;

// Test-only helper: resets the capture counters so unit tests can
// re-exercise the capture path with different mocked responses.
export function _resetBodyCapturedFlag() {
  _bodyCaptureSuccessCount = 0;
  _bodyCaptureAttemptCount = 0;
}

// Best-effort body capture when the initial fetch times out at
// FETCH_TIMEOUT. Used to surface the actual ArcGIS error body during
// degradation episodes (see ERROR_BODY_CAPTURE_EXTRA_MS comment).
// Returns `{error}` if the response body contains an ArcGIS error,
// `{body}` if it contains a normal response, or null if the re-fetch
// itself failed (caller falls through to proxy retry as before).
async function _captureErrorBodyAfterTimeout(url, signal) {
  if (signal?.aborted) return null;
  const captureSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ERROR_BODY_CAPTURE_EXTRA_MS)])
    : AbortSignal.timeout(ERROR_BODY_CAPTURE_EXTRA_MS);
  try {
    const resp = await fetch(url, {
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

// ArcGIS's Daily_Ports_Data FeatureServer intermittently returns "Cannot
// perform query. Invalid query parameters." for otherwise-valid queries —
// observed in prod 2026-04-20 for BRA/IDN/NGA on per-country WHERE, and
// also for the global WHERE after the PR #3225 rollout. A single retry with
// a short back-off clears it in practice for transient single-call flakes,
// but NOT during upstream degradation episodes where every call returns
// the same 400 (WM 2026-05-15: ArcGIS Daily_Ports_Data flapped, 30 cold
// fetches all hit the 400, retry burned ~22 minutes of container budget
// for zero recoveries).
//
// Strategy: keep the one-shot retry for transient flakes, but cap total
// retries-on-this-error per process at INVALID_PARAMS_RETRY_THRESHOLD.
// Beyond that, bail-don't-retry — caller treats the country as failed
// for this run, and cap-mode + stale-serve + multi-tick rotation cover
// the gap until upstream recovers.
//
// IMPORTANT: a 100%-batch-rejected version of this error is NOT a flake —
// it's an upstream schema-rename or policy change. The 2026-04-29 IMF
// reserved-keyword sweep flapped `date` → `date_` → `date` within ~9h,
// which would silently break any seeder using a hardcoded literal twice
// in the same incident. resolveArcgisDateField introspects the schema at
// run start to survive the flap; the threshold below catches other
// global-regression classes (renamed table, removed field, policy
// change, server-side degradation) so we don't burn the container
// budget on doomed retries.
let _invalidParamsErrorCount = 0;
async function fetchWithRetryOnInvalidParams(url, { signal } = {}) {
  try {
    return await fetchWithTimeout(url, { signal });
  } catch (err) {
    const msg = err?.message || '';
    if (!/Invalid query parameters/i.test(msg)) throw err;
    _invalidParamsErrorCount += 1;
    // PR #3701 P1 round 3: threshold check MUST come before the
    // proxy-confirmed short-circuit. Pre-fix the short-circuit ran first,
    // so a degraded incident where every error arrives via proxy would
    // never surface the clean "ArcGIS degraded — N errors" message — the
    // counter incremented forever but the threshold path was unreachable.
    // Right order: count → threshold (emits the degraded message) → proxy
    // short-circuit (skip retry only when below threshold).
    if (_invalidParamsErrorCount > INVALID_PARAMS_RETRY_THRESHOLD) {
      // Degradation signal — caller sees a clear "no retry, run will be
      // partial" message instead of doubling time-on-task for nothing.
      throw new Error(`ArcGIS degraded — ${_invalidParamsErrorCount} 'Invalid query parameters' errors in this run, no retry (threshold ${INVALID_PARAMS_RETRY_THRESHOLD})`);
    }
    // Greptile PR #3701 P2: if the error came BACK from the proxy
    // (arcgisProxyRetry wraps with "via proxy after ${reason}"), the
    // proxy has already confirmed the upstream error — retrying would
    // just round-trip direct timeout → proxy → same error, burning the
    // per-country budget for nothing. The proxy response is the
    // definitive upstream signal here. Counter increment + threshold
    // check above still apply, so proxy-confirmed errors DO contribute
    // to the degraded-run message.
    if (/via proxy after/i.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    if (signal?.aborted) throw signal.reason ?? err;
    console.warn(`  [port-activity] retrying after "${msg}" (${_invalidParamsErrorCount}/${INVALID_PARAMS_RETRY_THRESHOLD}): ${url.slice(0, 80)}`);
    return await fetchWithTimeout(url, { signal });
  }
}

// Test-only helper: clears the module-level counter so unit tests can
// re-exercise the threshold path with different inputs.
export function _resetInvalidParamsErrorCount() {
  _invalidParamsErrorCount = 0;
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
async function paginateWindowInto(portAccumMap, iso3, where, windowKind, { signal, dateField } = {}) {
  // Defensive: callers should always thread dateField through, but if a
  // future caller forgets, fall back to the resolver (idempotent + cached).
  const df = dateField || (await resolveArcgisDateField({ signal }));
  let offset = 0;
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
    body = await fetchWithRetryOnInvalidParams(`${EP3_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (!a || a.portid == null || a[df] == null) continue;
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
async function fetchCountryAccum(iso3, { signal, anchorEpochMs, dateField } = {}) {
  const anchor = anchorEpochMs ?? Date.now();
  const cutoff30 = anchor - 30 * 86400000;
  const cutoff60 = anchor - 60 * 86400000;
  const df = dateField || (await resolveArcgisDateField({ signal }));

  const portAccumMap = new Map();

  // ARCGIS_DATE_FIELD: queryable column name is resolved dynamically at run
  // start via resolveArcgisDateField. The `timestamp 'YYYY-MM-DD HH:MM:SS'`
  // literal works on both the esriFieldTypeDateOnly and esriFieldTypeDate
  // shapes ArcGIS may serve.
  await Promise.all([
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND ${df} > ${epochToTimestamp(cutoff30)}`,
      'last30',
      { signal, dateField: df },
    ),
    paginateWindowInto(
      portAccumMap,
      iso3,
      `ISO3='${iso3}' AND ${df} > ${epochToTimestamp(cutoff60)} AND ${df} <= ${epochToTimestamp(cutoff30)}`,
      'prev30',
      { signal, dateField: df },
    ),
  ]);

  return portAccumMap;
}

// Cheap preflight: single outStatistics query returning max(date) for one
// country. Used to skip the expensive fetch when upstream data hasn't
// advanced since the last cached run. ~1-2s per call at ArcGIS's current
// steady-state. Returns ISO date string "YYYY-MM-DD" or null on any error
// (we then fall through to the expensive path, which has its own retry).
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
    // full direct+proxy budget. Also skips fetchWithRetryOnInvalidParams's
    // 500ms backoff retry — preflight is best-effort cache invalidation,
    // a retry just doubles wall-clock without changing the outcome.
    const body = await fetchWithTimeout(`${EP3_BASE}?${params}`, {
      signal,
      timeoutMs: PREFLIGHT_FETCH_TIMEOUT,
      noProxyFallback: true,
    });
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
//
// fetchAll is the orchestrator (refs → schema → preflight → cache-partition
// → batched fetch → finalise); splitting it would move complexity into a
// hidden seam and obscure the linear pipeline. Each stage is short and
// well-commented; suppress the cognitive-complexity warning on the line.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrator pipeline
export async function fetchAll(progress, { signal } = {}) {
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
      slice.map((iso3) => fetchMaxDate(iso3, { signal, dateField })),
    );
    for (let j = 0; j < slice.length; j++) {
      const r = settled[j];
      maxDates[i + j] = r.status === 'fulfilled' ? r.value : null;
    }
  }
  console.log(`  [port-activity] Preflight maxDate for ${eligibleIso3.length} countries (${((Date.now() - preflightT0) / 1000).toFixed(1)}s)`);

  // Partition: cache hits (reusable) vs misses (need expensive fetch).
  // For misses, capture `prevPayload` (may be null) so that if we end up
  // deferring this country to a later run we can still serve its previous
  // (slightly-stale) data — better than dropping it entirely.
  const countryData = new Map();
  let needsFetch = [];
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
      needsFetch.push({ iso3, iso2, upstreamMaxDate, prevPayload: prev });
    }
  }
  console.log(`  [port-activity] Cache: ${cacheHits} hits, ${needsFetch.length} misses`);

  // Cold-fetch cap (WM 2026-05-13 incident): when needsFetch exceeds the
  // per-run cap, refresh a random subset and serve the rest from prior
  // cache marked staleAsof=true. Prevents the catastrophic "everything
  // stale → 174 cold-fetches → bundle SIGTERM" failure mode that produced
  // 37h of stale data after a single upstream-advance event. A full
  // rotation completes in ~ceil(174/30) = 6 runs ≈ 3 days at 12h cadence.
  // Cap-mode signaling. Surfaces to the caller so main() can bypass the 80%
  // degradation guard for an intentionally-partial publish. Greptile PR #3694
  // round 3 P1: pre-fix, cap-mode + temp-gate=25 would clear the coverage gate
  // (countryData.size ≥ 25) but still fail the degradation guard
  // (countryData.size < prevCount × 0.8 ≈ 139), so seed-meta would not advance
  // and the WARNING would persist — defeating the PR's main recovery claim.
  let capTriggered = false;
  let servedStaleCount = 0;
  let droppedTooOldCount = 0;
  let droppedNoCacheCount = 0;
  // Counts fresh upstream successes this run (fetched-fresh path, line ~904).
  // cacheHits is counted separately and also contributes to "fresh upstream
  // contact" — both are aggregated into the cap-mode bypass gate in main().
  // Servet-stale entries do NOT count: they're prior-run data being held
  // over, no upstream contact this run.
  let freshFetchedCount = 0;

  if (needsFetch.length > MAX_COLD_FETCH_PER_RUN) {
    capTriggered = true;
    // Deterministic-ish shuffle: Fisher-Yates with Math.random — fine here
    // because we just need "different subset each run", not crypto strength.
    const shuffled = [...needsFetch];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const deferred = shuffled.slice(MAX_COLD_FETCH_PER_RUN);
    let servedStale = 0;
    let droppedTooOld = 0;
    let droppedNoCache = 0;
    for (const item of deferred) {
      const prev = item.prevPayload;
      if (!prev || typeof prev !== 'object') {
        // No prior payload (new country, first-ever miss). Drop — same as
        // pre-fix behavior for hard misses.
        droppedNoCache++;
        continue;
      }
      // MAX_CACHE_AGE_MS hard-drop boundary (Greptile PR #3676 review P1):
      // the deferred-stale path MUST respect the same age gate the
      // cacheFresh check enforces, otherwise a country deferred across
      // enough runs while upstream was frozen ≥4 days could publish data
      // older than the intended 7d hard-drop threshold. Without this,
      // window-drift accumulates past MAX_CACHE_AGE_MS and the PR's claim
      // that hard-drop behavior is unchanged would be false.
      const cacheWrittenAt = prev.cacheWrittenAt;
      if (typeof cacheWrittenAt !== 'number' || (now - cacheWrittenAt) >= MAX_CACHE_AGE_MS) {
        droppedTooOld++;
        continue;
      }
      // Mark as stale-asof so downstream consumers know this country is one
      // window behind. The canonical payload structure is unchanged.
      countryData.set(item.iso2, { ...prev, staleAsof: true });
      servedStale++;
    }
    needsFetch = shuffled.slice(0, MAX_COLD_FETCH_PER_RUN);
    // Rotation arithmetic uses MAX_COLD_FETCH_PER_RUN directly rather than
    // needsFetch.length — needsFetch was just reassigned to the cap-sized
    // slice, so the two are numerically equal here, but using the constant
    // keeps the intent unambiguous if this log block is ever reordered.
    const originalMisses = MAX_COLD_FETCH_PER_RUN + servedStale + droppedTooOld + droppedNoCache;
    // Surface the bucket counts to the outer-scope fields so main()'s
    // degradation-guard bypass can include them in the partial-publish log.
    servedStaleCount = servedStale;
    droppedTooOldCount = droppedTooOld;
    droppedNoCacheCount = droppedNoCache;
    console.warn(
      `  [port-activity] Cold-fetch capped at ${MAX_COLD_FETCH_PER_RUN}/run — ` +
      `refreshing ${MAX_COLD_FETCH_PER_RUN} now, serving ${servedStale} on stale cache (asof behind), ` +
      `${droppedTooOld} dropped (cache > ${MAX_CACHE_AGE_MS / 86_400_000}d old), ${droppedNoCache} dropped (no prior payload). ` +
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
        (childSignal) => fetchCountryAccum(iso3, { signal: childSignal, anchorEpochMs, dateField }),
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
      freshFetchedCount++;
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
      // Abort-aware sleep: previously a plain setTimeout(BATCH_BACKOFF_MS)
      // that ignored the caller signal mid-sleep, so a SIGTERM during the
      // 5s backoff still made the loop wait the full 5s before observing
      // the abort. Race the sleep against signal.aborted so the loop exits
      // immediately on a real cancellation (which then surfaces via the
      // signal?.aborted check at the top of the next iteration).
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, BATCH_BACKOFF_MS);
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

  if (errors.length) {
    console.warn(`  [port-activity] ${errors.length} country errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' ...' : ''}`);
  }

  if (countryData.size === 0) throw new Error('No country port data returned from ArcGIS');
  return {
    countries: [...countryData.keys()],
    countryData,
    fetchedAt: new Date().toISOString(),
    // Cap-mode signaling — see capTriggered declaration. main() reads these
    // to bypass the 80% degradation guard for an intentionally-partial
    // publish AND to emit a "PARTIAL PUBLISH" log noting the fresh/stale split.
    capTriggered,
    servedStaleCount,
    droppedTooOldCount,
    droppedNoCacheCount,
    // Fresh upstream contact this run. Surfaced so main() can gate the
    // cap-mode bypass on a minimum-fresh-success floor — see
    // MIN_FRESH_FETCH_FOR_CAP_BYPASS. Without this, a run with all-stale
    // served entries (freshFetched=0, cacheHits=0, servedStale≥25) could
    // bypass the degradation guard and publish a shrunken canonical list
    // as healthy, hiding the upstream outage.
    freshFetchedCount,
    cacheHitCount: cacheHits,
  };
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
    const {
      countries,
      countryData,
      capTriggered,
      servedStaleCount,
      droppedTooOldCount,
      droppedNoCacheCount,
      freshFetchedCount,
      cacheHitCount,
    } = await fetchAll(progress, { signal: shutdownController.signal });

    console.log(`  Fetched ${countryData.size} countries`);

    if (!validateFn({ countries })) {
      console.error(`  COVERAGE GATE FAILED: only ${countryData.size} countries, need >=${MIN_VALID_COUNTRIES}`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

    // Degradation guard — bypass when capTriggered (Greptile PR #3694 round 3 P1).
    //
    // The 80%-of-prev guard exists to catch SILENT data loss: an ArcGIS
    // regression that drops 100 → 50 countries with no other signal. In
    // cap-mode the partial coverage is LOUD, INTENTIONAL, and ROTATIONAL
    // (refresh 30 per run, serve rest from cache up to 7d age) — the
    // coverage gate (countryData.size ≥ MIN_VALID_COUNTRIES) is the right
    // floor here, not the 80%-of-prev comparison.
    //
    // Without this bypass, the cap-mode path would always trip the guard
    // (cap=30 + ~24 stale-served = ~54 << 0.8 × 174 = 139), seed-meta
    // would never advance, and the operator-facing WARNING would persist
    // — defeating the entire recovery design from #3676 onwards.
    //
    // PR #3701 review P1: the bypass MUST also require fresh upstream
    // contact this run (freshFetchedCount + cacheHitCount). Pre-fix, a
    // worst-case "ArcGIS completely down" run with freshSuccess=0,
    // cacheHits=0, servedStale=27 would pass the lowered coverage gate
    // (countryData.size=27 ≥ 25) and bypass the degradation guard, shrinking
    // the canonical list from ~174 → 27 stale-only entries and advancing
    // seed-meta as healthy — hiding the upstream outage. With this gate,
    // such a run falls through to the 80% guard (which fires and
    // extendExistingTtl-only), preserving the canonical list and the
    // operator-facing WARNING.
    const upstreamContactCount = freshFetchedCount + cacheHitCount;
    const capBypassEarned = capTriggered && upstreamContactCount >= MIN_FRESH_FETCH_FOR_CAP_BYPASS;
    if (capBypassEarned) {
      console.warn(
        `  PARTIAL PUBLISH (cap-mode): ${countryData.size}/${prevCount} countries — ` +
        `${freshFetchedCount} fresh-fetched, ${cacheHitCount} cache-fresh, ${servedStaleCount} stale-served, ` +
        `${droppedTooOldCount} dropped (cache > 7d), ${droppedNoCacheCount} dropped (no prior payload). ` +
        `Degradation guard bypassed (≥${MIN_FRESH_FETCH_FOR_CAP_BYPASS} fresh upstream contacts); seed-meta will advance.`,
      );
    } else if (capTriggered) {
      // Cap-mode WITHOUT enough fresh upstream contact — fall through to the
      // 80% guard. If we got here, freshFetched + cacheHits < threshold,
      // which means this is an upstream-degraded run, not a rotational one.
      // Log explicitly so the operator sees why the bypass didn't fire.
      console.error(
        `  CAP-MODE BYPASS REFUSED: only ${upstreamContactCount} fresh upstream contacts ` +
        `(${freshFetchedCount} fetched + ${cacheHitCount} cache-fresh, threshold ${MIN_FRESH_FETCH_FOR_CAP_BYPASS}). ` +
        `Stale-only published would hide the upstream outage. Falling through to 80% degradation guard.`,
      );
      if (prevCount > 0 && countryData.size < prevCount * 0.8) {
        console.error(`  DEGRADATION GUARD: ${countryData.size} countries vs ${prevCount} previous — refusing to overwrite (need ≥${Math.ceil(prevCount * 0.8)})`);
        await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
        return;
      }
    } else if (prevCount > 0 && countryData.size < prevCount * 0.8) {
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
