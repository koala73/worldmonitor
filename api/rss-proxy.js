import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout } from './_relay.js';
import { isAllowedDomain, hostMatchForms } from './_rss-allowed-domain-match.js';
import { RSS_BROWSER_UA, rssFetchHeadersForHost } from './_rss-fetch-headers.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

// Domains that consistently block Vercel edge IPs — skip direct fetch,
// go straight to Railway relay to avoid wasted invocation + timeout.
const RELAY_ONLY_DOMAINS = new Set([
  'rss.cnn.com',
  'www.defensenews.com',
  'layoffs.fyi',
  'news.un.org',
  'www.cisa.gov',
  'www.iaea.org',
  'www.who.int',
  'www.crisisgroup.org',
  'english.alarabiya.net',
  'www.timesofisrael.com',
  'www.scmp.com',
  'kyivindependent.com',
  'www.themoscowtimes.com',
  'feeds.24.com',
  'feeds.capi24.com',
  'islandtimes.org',
  'www.atlanticcouncil.org',
]);

// Browser UA for upstream RSS: see api/_rss-fetch-headers.js (#6624).
const DIRECT_FETCH_HEADERS = rssFetchHeadersForHost('');
const DIRECT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_DIRECT_REDIRECTS = 3;

class RssProxyPolicyError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'RssProxyPolicyError';
    this.status = status;
  }
}

async function fetchViaRailway(feedUrl, timeoutMs) {
  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) return null;
  const relayUrl = `${relayBaseUrl}/rss?url=${encodeURIComponent(feedUrl)}`;
  return fetchWithTimeout(relayUrl, {
    headers: getRelayHeaders({
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'User-Agent': 'WorldMonitor-RSS-Proxy/1.0',
    }),
  }, timeoutMs);
}

// Allowlist + match predicate live in api/_rss-allowed-domain-match.js
// (shared with scripts/validate-rss-feeds.mjs --ci so the SSRF guard runs
// identically in the Edge handler and the build-time validator).

function isGoogleNewsFeedUrl(feedUrl) {
  try {
    return new URL(feedUrl).hostname === 'news.google.com';
  } catch {
    return false;
  }
}

function assertHttpProtocol(url, message = 'URL protocol not allowed', status = 400) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RssProxyPolicyError(message, status);
  }
}

function assertAllowedRedirect(url) {
  assertHttpProtocol(url, 'Redirect protocol not allowed', 403);
  // Apply the same www-normalization as the initial domain check so that
  // canonical redirects (e.g. apex -> www) are not incorrectly rejected when
  // only one form is in the allowlist.
  if (!isAllowedDomain(url.hostname)) {
    throw new RssProxyPolicyError('Redirect to disallowed domain');
  }
}

export default async function handler(req, ctx) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, corsHeaders);
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  const requestUrl = new URL(req.url);
  const feedUrl = requestUrl.searchParams.get('url');

  if (!feedUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400, corsHeaders);
  }

  // A malformed `url` param is a client error, not a server fault. Parse it up
  // front and return 400 WITHOUT a Sentry capture — otherwise `new URL()` throws
  // "Invalid URL string." inside the try below, which the catch reports as an
  // error-level exception and answers with a 502 (WORLDMONITOR-TT: 21 events from
  // malformed/double-encoded feed params).
  let parsedUrl;
  try {
    parsedUrl = new URL(feedUrl);
  } catch {
    return jsonResponse({ error: 'Invalid url parameter' }, 400, corsHeaders);
  }

  try {
    assertHttpProtocol(parsedUrl);

    // Security: Check if domain is allowed (normalize www prefix)
    const hostname = parsedUrl.hostname;
    if (!isAllowedDomain(hostname)) {
      return jsonResponse({ error: 'Domain not allowed' }, 403, corsHeaders);
    }

    // Match relay-only hosts with the same www-tolerance as the allowlist:
    // a host allowed via its apex form must still route to the relay when only
    // its www. form is registered (and vice versa), otherwise it falls through
    // to a direct Vercel-edge fetch these hosts block.
    const isRelayOnly = hostMatchForms(hostname).some((form) => RELAY_ONLY_DOMAINS.has(form));

    // Google News is slow - use longer timeout
    const isGoogleNews = isGoogleNewsFeedUrl(feedUrl);
    const timeout = isGoogleNews ? 20000 : 12000;

    const fetchDirect = async () => {
      let currentUrl = parsedUrl;

      for (let redirectCount = 0; redirectCount <= MAX_DIRECT_REDIRECTS; redirectCount += 1) {
        const response = await fetchWithTimeout(currentUrl.href, {
          headers: rssFetchHeadersForHost(currentUrl.hostname),
          redirect: 'manual',
        }, timeout);

        if (!DIRECT_REDIRECT_STATUSES.has(response.status)) {
          return response;
        }

        const location = response.headers.get('location');
        if (!location) {
          return response;
        }

        if (redirectCount === MAX_DIRECT_REDIRECTS) {
          throw new RssProxyPolicyError('Too many redirects', 502);
        }

        const redirectUrl = new URL(location, currentUrl.href);
        assertAllowedRedirect(redirectUrl);
        currentUrl = redirectUrl;
      }
    };

    let response;
    let usedRelay = false;

    if (isRelayOnly) {
      // Skip direct fetch entirely — these domains block Vercel IPs
      response = await fetchViaRailway(feedUrl, timeout);
      usedRelay = !!response;
      if (!response) throw new Error(`Railway relay unavailable for relay-only domain: ${hostname}`);
    } else {
      try {
        response = await fetchDirect();
      } catch (directError) {
        if (directError instanceof RssProxyPolicyError) throw directError;
        // A throwing relay leg here must not replace directError — a null or
        // non-ok relay response already falls through to it below, so a thrown
        // relay error should too, rather than becoming the reported failure.
        let relayResponse = null;
        try {
          relayResponse = await fetchViaRailway(feedUrl, timeout);
        } catch (relayError) {
          console.error('RSS proxy relay fallback error:', feedUrl, relayError instanceof Error ? relayError.message : String(relayError));
        }
        response = relayResponse;
        usedRelay = !!response;
        if (!response) throw directError;
      }

      if (!response.ok && !usedRelay) {
        // Same reasoning: a throwing relay retry must not discard the original
        // non-ok direct response — fall through to it exactly as a null or
        // non-ok relay response already would.
        let relayResponse = null;
        try {
          relayResponse = await fetchViaRailway(feedUrl, timeout);
        } catch (relayError) {
          console.error('RSS proxy relay retry error:', feedUrl, relayError instanceof Error ? relayError.message : String(relayError));
          captureSilentError(relayError, { tags: { route: 'api/rss-proxy', step: 'relay-retry', feed: feedUrl }, ctx });
        }
        if (relayResponse?.ok) {
          response = relayResponse;
          usedRelay = true;
        }
      }
    }

    const data = await response.text();
    const isSuccess = response.status >= 200 && response.status < 300;
    const relayCacheState = usedRelay ? response.headers.get('x-cache') : null;
    const relayStaleMarker = usedRelay ? response.headers.get('x-relay-stale') : null;
    // New relays identify stale fallback explicitly. Keep the label fallback
    // while Railway and Vercel revisions roll out independently.
    const legacyStaleCacheLabel = relayCacheState === 'STALE' || relayCacheState?.endsWith('-STALE');
    const isStaleRelay = relayStaleMarker === '1' || legacyStaleCacheLabel;
    const isCacheableSuccess = isSuccess && !isStaleRelay;
    // Relay-only feeds are slow-updating institutional sources — cache longer
    const cdnTtl = isRelayOnly ? 3600 : 900;
    const swr = isRelayOnly ? 7200 : 1800;
    const sie = isRelayOnly ? 14400 : 3600;
    const browserTtl = isRelayOnly ? 600 : 180;
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/xml',
        'Cache-Control': isCacheableSuccess
          ? `public, max-age=${browserTtl}, s-maxage=${cdnTtl}, stale-while-revalidate=${swr}, stale-if-error=${sie}`
          : isStaleRelay ? 'no-store' : 'public, max-age=15, s-maxage=60, stale-while-revalidate=120',
        ...(isCacheableSuccess && { 'CDN-Cache-Control': `public, s-maxage=${cdnTtl}, stale-while-revalidate=${swr}, stale-if-error=${sie}` }),
        ...(isStaleRelay && { 'CDN-Cache-Control': 'no-store' }),
        ...(relayCacheState && { 'X-Cache': relayCacheState }),
        ...(relayStaleMarker && { 'X-Relay-Stale': relayStaleMarker }),
        ...corsHeaders,
      },
    });
  } catch (error) {
    if (error instanceof RssProxyPolicyError) {
      return jsonResponse({ error: error.message }, error.status, corsHeaders);
    }

    const isTimeout = error.name === 'AbortError';
    console.error('RSS proxy error:', feedUrl, error.message);
    // Skip Sentry capture on timeout — Sentry would drown in transient
    // upstream-feed timeouts which are routine. Only surface "real" errors.
    if (!isTimeout) {
      captureSilentError(error, { tags: { route: 'api/rss-proxy', step: 'fetch', feed: feedUrl }, ctx });
    }
    return jsonResponse({
      error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
      details: error.message,
      url: feedUrl
    }, isTimeout ? 504 : 502, corsHeaders);
  }
}

// Test-only exports. Not part of the public edge handler surface — Vercel's
// runtime invokes only `default export`. Exposed so api/rss-proxy.test.mjs can
// assert the config-drift invariant that every relay-only host is also in the
// RSS allowlist: the allowlist check runs first, so an unlisted relay-only host
// would 403 before the relay routing it exists for is ever consulted.
export const __testing__ = {
  RELAY_ONLY_DOMAINS,
  RSS_BROWSER_UA,
  DIRECT_FETCH_HEADERS,
};
