// Bounded GDELT DOC API transport.
//
// GDELT rate-limits shared cloud egress aggressively. Railway's direct route
// is persistently blocked, while the shared proxy has separately returned 429,
// timed out, and failed TLS. Retrying either route in the same run only
// amplifies the outage, so production selects exactly one route and attempts it
// once:
//
//   GDELT_PROXY_URL -> PROXY_URL -> direct (only when no proxy is configured)
//
// GDELT_PROXY_URL gives this mandatory-proxy source an independently
// replaceable exit. PROXY_URL remains a compatibility fallback while operators
// provision that source-specific route.

import { CHROME_UA, resolveProxy, curlFetch } from './_seed-utils.mjs';

const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

export class GdeltFetchError extends Error {
  constructor(code, route, label, cause) {
    const safeCode = ERROR_CODE_RE.test(code) ? code : 'GDELT_FETCH_FAILED';
    super(
      `GDELT ${route} fetch failed for ${label}: ${safeCode}`
        + (cause?.message ? ` (${cause.message})` : ''),
      cause ? { cause } : undefined,
    );
    this.name = 'GdeltFetchError';
    this.code = safeCode;
    this.route = route;
  }
}

function routeErrorPrefix(route) {
  if (route === 'source-proxy') return 'GDELT_SOURCE_PROXY';
  if (route === 'shared-proxy') return 'GDELT_SHARED_PROXY';
  if (route === 'proxy') return 'GDELT_PROXY';
  return 'GDELT_DIRECT';
}

function errorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    parts.push(current?.code, current?.name, current?.message);
    current = current?.cause;
  }
  return parts.filter(Boolean).join(' ');
}

export function classifyGdeltFetchError(error, route) {
  const prefix = routeErrorPrefix(route);
  const numericStatus = Number(error?.status);
  const text = errorText(error);
  const messageStatus = text.match(/\bHTTP\s+([1-5]\d{2})\b/i)?.[1];
  const status = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? numericStatus
    : (messageStatus ? Number(messageStatus) : null);
  if (status) return `${prefix}_HTTP_${status}`;
  if (error instanceof SyntaxError || /\bJSON\b|Unexpected token/i.test(text)) {
    return `${prefix}_INVALID_JSON`;
  }
  if (/SSL_ERROR_SYSCALL|certificate|TLS|SSL/i.test(text)) return `${prefix}_TLS`;
  if (/timed?\s*out|timeout|AbortError|UND_ERR_HEADERS_TIMEOUT/i.test(text)) {
    return `${prefix}_TIMEOUT`;
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return `${prefix}_DNS`;
  return `${prefix}_TRANSPORT`;
}

export function resolveGdeltProxy() {
  return resolveProxy(process.env.GDELT_PROXY_URL || process.env.PROXY_URL || '');
}

export function resolveGdeltProxyRoute() {
  if (process.env.GDELT_PROXY_URL) return 'source-proxy';
  if (process.env.PROXY_URL) return 'shared-proxy';
  return 'direct';
}

// Exported so tests exercise the same production binding rather than a
// source-text approximation.
export const _PROXY_DEFAULTS = Object.freeze({
  curlProxyResolver: resolveGdeltProxy,
  proxyRouteResolver: resolveGdeltProxyRoute,
  curlFetcher: curlFetch,
});

/**
 * Fetch one GDELT DOC JSON response through exactly one selected route.
 *
 * Same-route retries are intentionally unsupported. When no proxy is
 * configured, proxyMaxAttempts: 0 selects the direct route. A configured proxy
 * cannot be bypassed, and values above one are rejected so a future call site
 * cannot silently restore the retry storm.
 */
export async function fetchGdeltJson(url, opts = {}) {
  const {
    label = 'unknown',
    timeoutMs = 30_000,
    maxRetries = 0,
    proxyMaxAttempts = 1,
    _fetch = globalThis.fetch,
    _curlProxyResolver = _PROXY_DEFAULTS.curlProxyResolver,
    _proxyRouteResolver = _PROXY_DEFAULTS.proxyRouteResolver,
    _proxyCurlFetcher = _PROXY_DEFAULTS.curlFetcher,
  } = opts;

  if (maxRetries !== 0) {
    throw new RangeError('GDELT same-route direct retries are disabled; maxRetries must be 0');
  }
  if (proxyMaxAttempts !== 0 && proxyMaxAttempts !== 1) {
    throw new RangeError('GDELT same-route proxy retries are disabled; proxyMaxAttempts must be 0 or 1');
  }

  const resolvedProxyRoute = _proxyRouteResolver();
  const proxyConfigured = resolvedProxyRoute !== 'direct';
  if (proxyConfigured && proxyMaxAttempts === 0) {
    throw new RangeError(
      'GDELT direct fallback is disabled when a proxy is configured; proxyMaxAttempts must be 1',
    );
  }

  const proxyAuth = proxyMaxAttempts === 1 ? _curlProxyResolver() : null;
  if (proxyConfigured && !proxyAuth) {
    const code = `${routeErrorPrefix(resolvedProxyRoute)}_CONFIG`;
    const error = new Error(`${resolvedProxyRoute} is configured but could not be parsed`);
    console.warn(`  [GDELT] ${resolvedProxyRoute} failed for ${label}: ${code}`);
    throw new GdeltFetchError(code, resolvedProxyRoute, label, error);
  }
  if (proxyAuth) {
    const proxyRoute = proxyConfigured ? resolvedProxyRoute : 'proxy';
    try {
      const text = await Promise.resolve(
        _proxyCurlFetcher(
          url,
          proxyAuth,
          { 'User-Agent': CHROME_UA, Accept: 'application/json' },
          { timeoutMs },
        ),
      );
      const parsed = JSON.parse(text);
      console.log(`  [GDELT] ${proxyRoute} succeeded for ${label}`);
      return parsed;
    } catch (error) {
      const code = classifyGdeltFetchError(error, proxyRoute);
      console.warn(`  [GDELT] ${proxyRoute} failed for ${label}: ${code}`);
      throw new GdeltFetchError(code, proxyRoute, label, error);
    }
  }

  try {
    const response = await _fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new GdeltFetchError(
        classifyGdeltFetchError(error, 'direct'),
        'direct',
        label,
        error,
      );
    }
  } catch (error) {
    if (error instanceof GdeltFetchError) throw error;
    const code = classifyGdeltFetchError(error, 'direct');
    console.warn(`  [GDELT] direct failed for ${label}: ${code}`);
    throw new GdeltFetchError(code, 'direct', label, error);
  }
}
