// Yahoo Finance fetch helper with curl-only Decodo proxy fallback.
//
// Yahoo Finance throttles Railway egress IPs aggressively (429s). Existing
// seeders had identical `fetchYahooWithRetry` blocks duplicated 4 times
// (seed-commodity-quotes, seed-etf-flows, seed-gulf-quotes,
// seed-market-quotes) with no proxy fallback. This helper consolidates
// them and adds the proxy fallback.
//
// PROXY STRATEGY — CURL ONLY, NO CONNECT
//
// Decodo provides two egress paths via different hosts:
//   - resolveProxyForConnect() → gate.decodo.com (CONNECT egress pool)
//   - resolveProxy()           → us.decodo.com   (curl-x egress pool)
//
// Probed 2026-04-16:
//   query1.finance.yahoo.com via CONNECT (httpsProxyFetchRaw): HTTP 404
//   query1.finance.yahoo.com via curl    (curlFetch):          HTTP 200
//
// Yahoo's edge blocks Decodo's CONNECT egress IPs but accepts the curl
// egress IPs. So this helper deliberately omits the CONNECT leg — adding
// it would burn time on a guaranteed-404 attempt before the curl path
// runs anyway. Production defaults expose ONLY the curl resolver +
// fetcher (see _PROXY_DEFAULTS).
//
// If Yahoo's behavior toward Decodo CONNECT changes (e.g. Decodo rotates
// the CONNECT pool), add a second leg following the
// scripts/_open-meteo-archive.mjs cascade pattern.

import { CHROME_UA, sleep, resolveProxy, curlFetch } from './_seed-utils.mjs';

const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Production defaults. Exported so tests can lock the wiring at the
 * helper level (see tests/yahoo-fetch.test.mjs production-defaults
 * cases). Mixing these up — e.g. swapping in resolveProxyForConnect
 * — would route requests through the egress pool Yahoo blocks.
 */
export const _PROXY_DEFAULTS = Object.freeze({
  curlProxyResolver: resolveProxy,
  curlFetcher: curlFetch,
});

/**
 * Parse `Retry-After` header value (seconds OR HTTP-date). Mirrors the
 * helper in scripts/_open-meteo-archive.mjs — duplicated for now to keep
 * each helper module self-contained; consolidate to _seed-utils.mjs if
 * a third helper needs it.
 */
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
 * Fetch JSON from a Yahoo Finance endpoint with retry + proxy fallback.
 *
 * @param {string} url - Yahoo Finance URL (typically
 *   `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>...`).
 * @param {object} [opts]
 * @param {string}  [opts.label]       - Symbol or label for log lines (default 'unknown').
 * @param {number}  [opts.timeoutMs]   - Per-attempt timeout (default 10_000).
 * @param {number}  [opts.maxRetries]  - Direct retries (default 3 → 4 attempts total).
 * @param {number}  [opts.retryBaseMs] - Linear backoff base (default 5_000).
 * @returns {Promise<unknown>} Parsed JSON. Throws on exhaustion.
 *
 * Throws (does NOT return null) on exhaustion — caller decides whether
 * to swallow with try/catch. Existing pre-helper code returned null on
 * failure; migrating callers should wrap in try/catch where null
 * semantics is required (rare — most should propagate the error).
 */
export async function fetchYahooJson(url, opts = {}) {
  const {
    label = 'unknown',
    timeoutMs = 10_000,
    maxRetries = 3,
    retryBaseMs = 5_000,
    // Test hooks. Production callers leave these unset and get
    // _PROXY_DEFAULTS. Tests inject mocks to exercise the proxy path
    // without spinning up real curl execs. `_sleep` lets tests assert
    // the actual backoff durations (e.g. Retry-After parsing) without
    // sleeping in real time.
    _curlProxyResolver = _PROXY_DEFAULTS.curlProxyResolver,
    _proxyCurlFetcher = _PROXY_DEFAULTS.curlFetcher,
    _sleep = sleep,
  } = opts;

  // Track the last direct-path failure so the eventual throw carries
  // useful upstream context (HTTP status, error message). Without this
  // the helper would throw "retries exhausted" alone and lose the signal
  // that triggered the proxy attempt.
  let lastDirectError = null;

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
        console.warn(`  [YAHOO] ${label} ${err?.message ?? err}; retrying in ${Math.round(retryMs / 1000)}s (${attempt + 1}/${maxRetries})`);
        await _sleep(retryMs);
        continue;
      }
      // Final direct attempt threw (timeout, ECONNRESET, DNS, etc.).
      // Fall through to the proxy fallback below — NEVER throw here.
      // PR #3118 review: throwing here silently bypasses the proxy path
      // for thrown-error cases.
      break;
    }

    if (resp.ok) return await resp.json();

    lastDirectError = new Error(`HTTP ${resp.status}`);

    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'));
      const retryMs = retryAfter ?? retryBaseMs * (attempt + 1);
      console.warn(`  [YAHOO] ${label} ${resp.status} — waiting ${Math.round(retryMs / 1000)}s (${attempt + 1}/${maxRetries})`);
      await _sleep(retryMs);
      continue;
    }

    break;
  }

  // Curl-only proxy fallback. See module header for why CONNECT is
  // omitted (Yahoo blocks Decodo's CONNECT egress IPs).
  const curlProxyAuth = _curlProxyResolver();
  if (curlProxyAuth) {
    try {
      console.log(`  [YAHOO] direct exhausted on ${label} (${lastDirectError?.message ?? 'unknown'}); trying proxy (curl)`);
      // _proxyCurlFetcher (curlFetch / execFileSync) is sync today;
      // wrap with await Promise.resolve so a future async refactor of
      // curlFetch silently keeps working instead of handing a Promise
      // to JSON.parse (Greptile P2 from PR #3119).
      const text = await Promise.resolve(_proxyCurlFetcher(url, curlProxyAuth, { 'User-Agent': CHROME_UA, Accept: 'application/json' }));
      // Parse BEFORE logging success. If JSON.parse throws, the catch block
      // below records lastProxyError and we throw exhausted — no contradictory
      // "succeeded" log line followed by an "exhausted" throw. The post-deploy
      // verification in the PR description relies on this success log being
      // a true success signal.
      const parsed = JSON.parse(text);
      console.log(`  [YAHOO] proxy (curl) succeeded for ${label}`);
      return parsed;
    } catch (curlErr) {
      throw new Error(
        `Yahoo retries exhausted for ${label} (last direct: ${lastDirectError?.message ?? 'unknown'}; last proxy: ${curlErr?.message ?? curlErr})`,
        { cause: lastDirectError ?? curlErr },
      );
    }
  }

  throw new Error(
    `Yahoo retries exhausted for ${label}${lastDirectError ? ` (last direct: ${lastDirectError.message})` : ''}`,
    lastDirectError ? { cause: lastDirectError } : undefined,
  );
}
