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

import { CHROME_UA, sleep, resolveProxy, curlFetch, parseYahooChart, roundSparkline } from './_seed-utils.mjs';
import { PREVIOUS_SESSION_CHART_QUERY, awaitsSessionOpen, previousSessionClose } from './shared/yahoo-closed-session.cjs';
import { crudeOilQuoteProvenance } from './shared/oil-quote-provenance.cjs';
import { SPARKLINE_HISTORY_QUERY, SPARKLINE_HISTORY_RETRY_SECONDS, buildQuoteSparkline } from './shared/quote-sparkline.cjs';

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

/** True when a `Retry-After` hint asks for longer than `MAX_RETRY_AFTER_MS`. */
export function retryAfterExceedsCap(value) {
  if (!value) return false;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000 > MAX_RETRY_AFTER_MS;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) && retryAt - Date.now() > MAX_RETRY_AFTER_MS;
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
 * @param {number}  [opts.retryBaseMs] - Capped exponential backoff base (default 5_000).
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
  const retryDelay = (attempt) => Math.round(
    Math.min(60_000, retryBaseMs * 2 ** attempt * 1.25) * (0.8 + Math.random() * 0.2),
  );

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
        const retryMs = retryDelay(attempt);
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
      const retryAfterHeader = resp.headers.get('retry-after');
      if (retryAfterExceedsCap(retryAfterHeader)) {
        // A direct retry inside the capped wait would land before the
        // provider's cooldown ends; go straight to the proxy egress instead.
        await resp.body?.cancel().catch(() => {});
        console.warn(`  [YAHOO] ${label} ${resp.status} — Retry-After ${retryAfterHeader} exceeds ${MAX_RETRY_AFTER_MS / 1000}s; skipping direct retries`);
        break;
      }
      const retryAfter = parseRetryAfterMs(retryAfterHeader);
      const retryMs = Math.max(retryAfter ?? 0, retryDelay(attempt));
      await resp.body?.cancel().catch(() => {});
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

const SPARKLINE_HISTORY_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * A cron seeder starts a fresh process every run. This keeps the sparkline
 * history chart in Redis per symbol and session, so the history request is
 * made once a day per symbol, not on every run. A failed request is recorded
 * for SPARKLINE_HISTORY_RETRY_SECONDS, and runs in that time skip it. `command`
 * is redisCommand bound to the seeder's credentials.
 */
export function createSparklineHistoryCache(command, keyPrefix) {
  const key = (symbol) => `${keyPrefix}${symbol}`;
  return {
    /** Returns { chart } for this session, { unavailable: true } after a recent failure, or null. */
    async load(symbol, sessionStart) {
      const { result } = await command(['GET', key(symbol)]);
      const cached = result ? JSON.parse(result) : null;
      if (cached?.unavailable) return { unavailable: true };
      return cached?.sessionStart === sessionStart ? { chart: cached.chart } : null;
    },
    async markUnavailable(symbol) {
      await command(['SET', key(symbol), JSON.stringify({ unavailable: true }), 'EX', SPARKLINE_HISTORY_RETRY_SECONDS]);
    },
    async save(symbol, sessionStart, chart) {
      const result = chart?.chart?.result?.[0];
      const compact = {
        chart: {
          result: [{
            timestamp: result?.timestamp ?? [],
            indicators: { quote: [{ close: result?.indicators?.quote?.[0]?.close ?? [] }] },
          }],
        },
      };
      await command(['SET', key(symbol), JSON.stringify({ sessionStart, chart: compact }), 'EX', SPARKLINE_HISTORY_TTL_SECONDS]);
    },
  };
}

/**
 * Fetch and parse one Yahoo quote. A chart rolled to a session that has not
 * traded costs a second, staggered request for the daily chart holding the
 * last completed session's previous close; without it the change reads 0.00%.
 * `sparklineWindow` adds the 24-hour sparkline. Its history chart costs one
 * more request unless `historyCache` already holds it for this session.
 */
export async function fetchYahooQuoteChart(symbol, {
  delayMs = 150,
  sparklineWindow = false,
  historyCache = null,
  fetchJson = (url, options) => fetchYahooJson(url, { label: symbol, ...options }),
} = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const chart = await fetchJson(url);
  const lastTradeAt = chart?.chart?.result?.[0]?.meta?.regularMarketTime;
  let previousClose = null;
  if (awaitsSessionOpen(chart)) {
    await sleep(delayMs);
    // Optional: a 429 with Retry-After must not hold the sequential basket for minutes.
    const daily = await fetchJson(`${url}${PREVIOUS_SESSION_CHART_QUERY}`, { maxRetries: 0 }).catch(() => null);
    previousClose = previousSessionClose(daily, lastTradeAt);
  }
  const quote = parseYahooChart(chart, symbol, { previousClose });
  if (!quote) return null;
  let sparkline = null;
  if (sparklineWindow) {
    const sessionStart = chart?.chart?.result?.[0]?.timestamp?.[0] ?? lastTradeAt;
    const cacheable = historyCache && Number.isFinite(sessionStart);
    const cached = historyCache ? await historyCache.load(symbol, sessionStart).catch(() => null) : null;
    let history = cached?.chart ?? null;
    if (!history && !cached?.unavailable) {
      await sleep(delayMs);
      history = await fetchJson(`${url}${SPARKLINE_HISTORY_QUERY}`, { maxRetries: 0 }).catch(() => null);
      if (history && cacheable) await historyCache.save(symbol, sessionStart, history).catch(() => {});
      if (!history && historyCache) await historyCache.markUnavailable(symbol).catch(() => {});
    }
    if (!history) console.warn(`  [YAHOO] ${symbol} sparkline history unavailable; publishing today's bars only`);
    const { sparkline: values, ...labels } = buildQuoteSparkline(chart, history);
    sparkline = { sparkline: roundSparkline(values), ...labels };
  }
  return { ...quote, ...sparkline, ...crudeOilQuoteProvenance(symbol, 'Yahoo Finance', 'futures', lastTradeAt * 1000) };
}
