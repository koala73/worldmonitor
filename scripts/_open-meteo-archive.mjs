import { CHROME_UA, sleep, resolveProxy, resolveProxyForConnect, httpsProxyFetchRaw, curlFetch } from './_seed-utils.mjs';

// Production defaults for the proxy cascade. Exported so tests can assert
// the wiring is correct without re-importing the underlying functions.
//
// CRITICAL invariant: the CONNECT leg MUST resolve via resolveProxyForConnect()
// (preserves gate.decodo.com, the host Decodo routes via its CONNECT egress
// pool), and the curl leg MUST resolve via resolveProxy() (rewrites to
// us.decodo.com, the host Decodo routes via its curl egress pool — a
// DIFFERENT IP pool). Mixing them collapses the two-leg cascade into one
// pool and defeats the redundancy this helper exists to provide.
//
// See scripts/_proxy-utils.cjs:67-88 and the established usage at
// scripts/seed-portwatch-chokepoints-ref.mjs:33-37 +
// scripts/seed-recovery-external-debt.mjs:31-35.
export const _PROXY_DEFAULTS = Object.freeze({
  connectProxyResolver: resolveProxyForConnect,
  curlProxyResolver: resolveProxy,
  connectFetcher: httpsProxyFetchRaw,
  curlFetcher: curlFetch,
});

const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

export function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function normalizeArchiveBatchResponse(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

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

export async function fetchOpenMeteoArchiveBatch(zones, opts) {
  const {
    startDate,
    endDate,
    daily,
    timezone = 'UTC',
    timeoutMs = 30_000,
    maxRetries = 3,
    retryBaseMs = 2_000,
    label = zones.map((zone) => zone.name).join(', '),
    // Test hooks. Production callers leave these unset; the helper uses the
    // real proxy resolvers + fetchers from _seed-utils.mjs (see _PROXY_DEFAULTS).
    // Tests inject mocks to exercise the cascade without spinning up real
    // Decodo tunnels. Keep these undocumented in PR descriptions — they are
    // implementation-only seams, not a public API surface.
    //
    // INVARIANT: connect/curl legs use DIFFERENT resolvers because Decodo
    // routes CONNECT (gate.decodo.com) and curl-x (us.decodo.com) through
    // different egress IP pools. Reusing one resolver for both legs collapses
    // the redundancy.
    _connectProxyResolver = _PROXY_DEFAULTS.connectProxyResolver,
    _curlProxyResolver = _PROXY_DEFAULTS.curlProxyResolver,
    _proxyFetcher = _PROXY_DEFAULTS.connectFetcher,
    _proxyCurlFetcher = _PROXY_DEFAULTS.curlFetcher,
  } = opts;

  const params = new URLSearchParams({
    latitude: zones.map((zone) => String(zone.lat)).join(','),
    longitude: zones.map((zone) => String(zone.lon)).join(','),
    start_date: startDate,
    end_date: endDate,
    daily: daily.join(','),
    timezone,
  });
  const url = `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;

  // Track the last direct-path failure so the eventual throw carries useful
  // context if proxy fallback is also unavailable / fails. Without this the
  // helper would throw a generic "retries exhausted" message and lose the
  // upstream error (timeout, ECONNRESET, HTTP status code) that triggered
  // the fallback path.
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
        const retryMs = retryBaseMs * 2 ** attempt;
        console.log(`  [OPEN_METEO] ${err?.message ?? err} for ${label}; retrying batch in ${Math.round(retryMs / 1000)}s`);
        await sleep(retryMs);
        continue;
      }
      // Final direct attempt threw (timeout, ECONNRESET, DNS, etc.). Fall
      // through to the proxy fallback below — the previous version threw
      // here, which silently bypassed the proxy path for thrown-error cases
      // and only ran fallback for non-OK HTTP responses.
      break;
    }

    if (resp.ok) {
      const data = normalizeArchiveBatchResponse(await resp.json());
      if (data.length !== zones.length) {
        throw new Error(`Open-Meteo batch size mismatch for ${label}: expected ${zones.length}, got ${data.length}`);
      }
      return data;
    }

    lastDirectError = new Error(`HTTP ${resp.status}`);

    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxRetries) {
      const retryMs = parseRetryAfterMs(resp.headers.get('retry-after')) ?? (retryBaseMs * 2 ** attempt);
      console.log(`  [OPEN_METEO] ${resp.status} for ${label}; retrying batch in ${Math.round(retryMs / 1000)}s`);
      await sleep(retryMs);
      continue;
    }

    // Direct attempt failed with non-retryable or after-final-retry status.
    // Open-Meteo's free tier rate-limits per source IP; Railway containers
    // share IP pools and hit 429 storms (logs.1776312819911 — every batch
    // 429'd through 4 retries on 2026-04-16). Fall through to proxy fallback
    // below before throwing.
    break;
  }

  // Proxy fallback — same pattern as fredFetchJson / imfFetchJson in
  // _seed-utils.mjs. Decodo gateway gets a different egress IP that is not
  // (yet) on Open-Meteo's per-IP throttle. Skip silently if no proxy is
  // configured (preserves existing behavior in non-Railway envs).
  //
  // Two-attempt cascade: CONNECT path first (pure-Node, faster, no curl
  // dependency), curl fallback second. Decodo's CONNECT and curl egress
  // reach DIFFERENT IP pools (per scripts/_proxy-utils.cjs:67), and some
  // hosts only accept one path — Yahoo Finance returns 404 to Decodo's
  // CONNECT egress but 200 to the curl egress (probed 2026-04-16). For
  // Open-Meteo both paths work today, but pinning the helper to one would
  // be a single point of failure if Decodo rebalances pools. The curl
  // attempt costs an exec only when CONNECT also failed, so steady-state
  // overhead is zero.
  const connectProxyAuth = _connectProxyResolver();
  const curlProxyAuth = _curlProxyResolver();
  let lastProxyError = null;

  // CONNECT leg via gate.decodo.com pool.
  if (connectProxyAuth) {
    try {
      console.log(`  [OPEN_METEO] direct exhausted on ${label} (${lastDirectError?.message ?? 'unknown'}); trying proxy (CONNECT)`);
      const { buffer } = await _proxyFetcher(url, connectProxyAuth, {
        accept: 'application/json',
        timeoutMs,
      });
      const data = normalizeArchiveBatchResponse(JSON.parse(buffer.toString('utf8')));
      if (data.length !== zones.length) {
        throw new Error(`Open-Meteo proxy batch size mismatch for ${label}: expected ${zones.length}, got ${data.length}`);
      }
      console.log(`  [OPEN_METEO] proxy (CONNECT) succeeded for ${label}`);
      return data;
    } catch (proxyErr) {
      lastProxyError = proxyErr;
      console.warn(`  [OPEN_METEO] proxy (CONNECT) failed for ${label}: ${proxyErr?.message ?? proxyErr}${curlProxyAuth ? '; trying proxy (curl)' : ''}`);
    }
  }

  // Second-choice curl leg via us.decodo.com pool — DIFFERENT egress IPs
  // than the CONNECT pool above. Some hosts (Yahoo Finance) only accept
  // this path. Only runs when CONNECT also failed.
  if (curlProxyAuth) {
    try {
      // _proxyCurlFetcher (curlFetch / execFileSync) is intentionally
      // synchronous today, so plain invocation works. Wrapping with
      // Promise.resolve + await keeps the call future-safe: if curlFetch is
      // ever refactored to async, this line silently keeps working instead
      // of returning an unhandled Promise to JSON.parse.
      const text = await Promise.resolve(_proxyCurlFetcher(url, curlProxyAuth, { 'User-Agent': CHROME_UA, Accept: 'application/json' }));
      const data = normalizeArchiveBatchResponse(JSON.parse(text));
      if (data.length !== zones.length) {
        throw new Error(`Open-Meteo proxy (curl) batch size mismatch for ${label}: expected ${zones.length}, got ${data.length}`);
      }
      console.log(`  [OPEN_METEO] proxy (curl) succeeded for ${label}`);
      return data;
    } catch (curlErr) {
      lastProxyError = curlErr;
      console.warn(`  [OPEN_METEO] proxy (curl) failed for ${label}: ${curlErr?.message ?? curlErr}`);
    }
  }

  // Surface the most relevant upstream signal. Direct error usually wins
  // (it's why we tried the proxy in the first place). Proxy error is in
  // cause-chain for deeper inspection.
  const finalErr = new Error(
    `Open-Meteo retries exhausted for ${label}${lastDirectError ? ` (last direct: ${lastDirectError.message})` : ''}${lastProxyError ? ` (last proxy: ${lastProxyError.message})` : ''}`,
    lastDirectError ? { cause: lastDirectError } : undefined,
  );
  throw finalErr;
}
