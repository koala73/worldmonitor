// GDELT API fetch helper with curl-only Decodo proxy fallback + multi-retry.
//
// GDELT (api.gdeltproject.org) is a public free API with strict per-IP
// throttling (HTTP 429). Railway egress IPs share a small pool and hit
// 429 storms. seed-gdelt-intel currently has no proxy fallback.
//
// PROXY STRATEGY — CURL-ONLY WITH MULTI-RETRY
//
// Probed 2026-04-16:
//   api.gdeltproject.org via direct (residential):     200
//   api.gdeltproject.org via Decodo curl (5 attempts): 200/200/429/timeout/429
//                                                      = 2/5 success (~40%)
//   api.gdeltproject.org via Decodo CONNECT:            not probed cleanly
//                                                      (proxy URL format issue)
//
// Decodo's curl egress is session-rotating: each call may get a different
// IP from the pool. Some IPs are throttled by GDELT, others are not. ~40%
// per-attempt success rate; 5 attempts gives expected success ~92%
// (1 - 0.6^5 = 0.922).
//
// CONNECT path is omitted for now: not yet probed cleanly against GDELT,
// and adding an unverified leg costs time on each call. If Yahoo's
// pattern holds (CONNECT → 404 from blocked egress IPs), CONNECT for
// GDELT may behave the same. Add only after a clean Railway probe.
//
// Direct retry uses LONGER backoff than Yahoo's 5s base — GDELT's
// per-IP throttle window is wider, so quick retries usually re-hit the
// same throttle.

import { CHROME_UA, sleep, resolveProxy, curlFetch } from './_seed-utils.mjs';

const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Production defaults. Exported so tests can lock the wiring at the
 * helper level. Mixing these up — e.g. swapping in resolveProxyForConnect
 * — would route through an egress pool that has not been verified
 * against GDELT.
 */
export const _PROXY_DEFAULTS = Object.freeze({
  curlProxyResolver: resolveProxy,
  curlFetcher: curlFetch,
});

export function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(retryAt - Date.now(), 1000), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * Fetch JSON from a GDELT API endpoint with retry + proxy multi-retry.
 *
 * @param {string} url - GDELT API URL (typically
 *   `https://api.gdeltproject.org/api/v2/...?query=...&format=json`).
 * @param {object} [opts]
 * @param {string} [opts.label]              - Symbol or label for log lines (default 'unknown').
 * @param {number} [opts.timeoutMs]          - Per-attempt timeout (default 15_000 — GDELT can be slow).
 * @param {number} [opts.maxRetries]         - Direct retries (default 3 → 4 attempts total).
 * @param {number} [opts.retryBaseMs]        - Linear direct backoff base (default 10_000 — GDELT throttle window is wider than Yahoo's).
 * @param {number} [opts.proxyMaxAttempts]   - Curl proxy attempts (default 5 — Decodo rotates session per call).
 * @param {number} [opts.proxyRetryBaseMs]   - Fixed (constant, NOT linear) backoff between proxy attempts (default 5_000). Constant because Decodo rotates the session IP per call — exponential growth wouldn't help; the next attempt's success is independent of the previous attempt's wait.
 * @returns {Promise<unknown>} Parsed JSON. Throws on exhaustion.
 */
export async function fetchGdeltJson(url, opts = {}) {
  const {
    label = 'unknown',
    timeoutMs = 15_000,
    maxRetries = 3,
    retryBaseMs = 10_000,
    proxyMaxAttempts = 5,
    proxyRetryBaseMs = 5_000,
    // Test hooks. Production callers leave unset and get _PROXY_DEFAULTS.
    // `_sleep` lets tests assert backoff values without sleeping in real
    // time. Mirrors the seam pattern from PR #3120's _yahoo-fetch.mjs.
    _curlProxyResolver = _PROXY_DEFAULTS.curlProxyResolver,
    _proxyCurlFetcher = _PROXY_DEFAULTS.curlFetcher,
    _sleep = sleep,
  } = opts;

  let lastDirectError = null;

  // ─── Direct retry loop ───
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastDirectError = err;
      if (attempt < maxRetries) {
        const retryMs = retryBaseMs * (attempt + 1);
        console.warn(`  [GDELT] ${label} ${err?.message ?? err}; retrying in ${Math.round(retryMs / 1000)}s (${attempt + 1}/${maxRetries})`);
        await _sleep(retryMs);
        continue;
      }
      // Final direct attempt threw — fall through to proxy. NEVER throw
      // here (PR #3118 review: throwing bypasses the proxy path).
      break;
    }

    if (resp.ok) {
      // Guard the parse: a 200 OK with HTML/garbage body (WAF challenge,
      // partial response, gzip mismatch) would otherwise throw SyntaxError
      // and escape the helper entirely, bypassing the proxy fallback. The
      // proxy leg already parses inside its own catch — make the direct
      // leg symmetric.
      try {
        return await resp.json();
      } catch (parseErr) {
        lastDirectError = parseErr;
        break;
      }
    }

    lastDirectError = new Error(`HTTP ${resp.status}`);

    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'));
      const retryMs = retryAfter ?? retryBaseMs * (attempt + 1);
      console.warn(`  [GDELT] ${label} ${resp.status} — waiting ${Math.round(retryMs / 1000)}s (${attempt + 1}/${maxRetries})`);
      await _sleep(retryMs);
      continue;
    }

    break;
  }

  // ─── Curl proxy multi-retry loop ───
  // Decodo's session-rotating egress gives a different IP per call. GDELT
  // throttles ~60% of attempts, so we retry until one IP isn't throttled.
  // Only retry on retryable upstream status (429/503); non-retryable
  // proxy errors (auth failure, malformed JSON, network) bail immediately
  // since they're not transient — repeated attempts won't help.
  const curlProxyAuth = _curlProxyResolver();
  let lastProxyError = null;
  let proxyAttemptsRun = 0;
  // Skip the proxy block entirely when the caller opted out via
  // proxyMaxAttempts:0 (best-effort callers that want fast-fail —
  // e.g. fetchTopicTimeline in seed-gdelt-intel which discards failures).
  // Avoids both the wasted log line and the no-op for loop.
  if (curlProxyAuth && proxyMaxAttempts > 0) {
    console.log(`  [GDELT] direct exhausted on ${label} (${lastDirectError?.message ?? 'unknown'}); trying proxy (curl) up to ${proxyMaxAttempts}× (Decodo session-rotates per call)`);
    for (let attempt = 1; attempt <= proxyMaxAttempts; attempt++) {
      proxyAttemptsRun = attempt;
      try {
        // _proxyCurlFetcher (curlFetch / execFileSync) is sync today; wrap
        // with await Promise.resolve so a future async refactor silently
        // keeps working (Greptile P2 from PR #3119).
        const text = await Promise.resolve(_proxyCurlFetcher(url, curlProxyAuth, { 'User-Agent': CHROME_UA, Accept: 'application/json' }));
        // Parse BEFORE logging success so a malformed response doesn't
        // emit a contradictory "succeeded" log + then throw (Greptile P2
        // from PR #3120).
        const parsed = JSON.parse(text);
        console.log(`  [GDELT] proxy (curl) succeeded for ${label} on attempt ${attempt}/${proxyMaxAttempts}`);
        return parsed;
      } catch (curlErr) {
        lastProxyError = curlErr;
        // Decide whether retrying this proxy call is worthwhile.
        //
        // Probed Decodo curl egress against GDELT (2026-04-16) gave
        // 200 / 200 / 429 / TIMEOUT / 429 over 5 attempts. The TIMEOUT
        // is part of the normal transient mix — rotating to another
        // Decodo session usually clears it. The pre-fix logic only
        // retried on `HTTP 429`/`503` substring matches, so a timeout
        // bailed on the first attempt and defeated the multi-retry
        // design. Reframed:
        //
        //   curlErr.status = number      → retry only if 429/503
        //   curlErr instanceof SyntaxError → bail (parse failure is
        //                                    structural, not transient)
        //   otherwise (timeout, ECONNRESET, DNS, curl exec failure,
        //              CONNECT tunnel failure)  → RETRY (next Decodo
        //                                        session likely different)
        //
        // curlFetch attaches `.status` only when curl succeeded but the
        // upstream returned non-2xx, so this property reliably
        // discriminates the HTTP-status case from network/timeout cases.
        const status = curlErr?.status;
        const isParseFailure = curlErr instanceof SyntaxError;
        let isRetryable;
        if (typeof status === 'number') {
          isRetryable = RETRYABLE_STATUSES.has(status);
        } else if (isParseFailure) {
          isRetryable = false;
        } else {
          // Network / timeout / curl exec error — assume transient.
          isRetryable = true;
        }
        if (attempt < proxyMaxAttempts && isRetryable) {
          const retryMs = proxyRetryBaseMs;
          console.warn(`  [GDELT] proxy (curl) attempt ${attempt}/${proxyMaxAttempts} failed: ${curlErr?.message ?? curlErr}; retrying in ${Math.round(retryMs / 1000)}s`);
          await _sleep(retryMs);
          continue;
        }
        // Non-retryable (parse failure, HTTP 4xx other than 429) OR last
        // attempt — give up, throw exhausted with both errors.
        console.warn(`  [GDELT] proxy (curl) attempt ${attempt}/${proxyMaxAttempts} failed${isRetryable ? ' (last attempt)' : ' (non-retryable)'}: ${curlErr?.message ?? curlErr}`);
        break;
      }
    }
  }

  throw new Error(
    `GDELT retries exhausted for ${label}` +
    (lastDirectError ? ` (last direct: ${lastDirectError.message})` : '') +
    (lastProxyError ? ` (last proxy: ${lastProxyError.message} after ${proxyAttemptsRun}/${proxyMaxAttempts} attempts)` : ''),
    lastDirectError ? { cause: lastDirectError } : (lastProxyError ? { cause: lastProxyError } : undefined),
  );
}
