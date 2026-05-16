import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout } from './_relay.js';
import RSS_ALLOWED_DOMAINS from './_rss-allowed-domains.js';
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
  'www.arabnews.com',
  'www.timesofisrael.com',
  'www.scmp.com',
  'kyivindependent.com',
  'www.themoscowtimes.com',
  'feeds.24.com',
  'feeds.capi24.com',
  'islandtimes.org',
  'www.atlanticcouncil.org',
]);

const DIRECT_FETCH_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-US,en;q=0.9',
});

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

// Allowed RSS feed domains — shared source of truth (shared/rss-allowed-domains.js)
const ALLOWED_DOMAINS = RSS_ALLOWED_DOMAINS;

function isAllowedDomain(hostname) {
  const bare = hostname.replace(/^www\./, '');
  const withWww = hostname.startsWith('www.') ? hostname : `www.${hostname}`;
  return ALLOWED_DOMAINS.includes(hostname) || ALLOWED_DOMAINS.includes(bare) || ALLOWED_DOMAINS.includes(withWww);
}

function isGoogleNewsFeedUrl(feedUrl) {
  try {
    return new URL(feedUrl).hostname === 'news.google.com';
  } catch {
    return false;
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

  try {
    const parsedUrl = new URL(feedUrl);

    // Security: Check if domain is allowed (normalize www prefix)
    const hostname = parsedUrl.hostname;
    if (!isAllowedDomain(hostname)) {
      return jsonResponse({ error: 'Domain not allowed' }, 403, corsHeaders);
    }

    const isRelayOnly = RELAY_ONLY_DOMAINS.has(hostname);

    // Google News is slow - use longer timeout
    const isGoogleNews = isGoogleNewsFeedUrl(feedUrl);
    const timeout = isGoogleNews ? 20000 : 12000;

    const fetchDirect = async () => {
      const response = await fetchWithTimeout(feedUrl, {
        headers: DIRECT_FETCH_HEADERS,
        redirect: 'manual',
      }, timeout);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          const redirectUrl = new URL(location, feedUrl);
          // Apply the same www-normalization as the initial domain check so that
          // canonical redirects (e.g. bbc.co.uk → www.bbc.co.uk) are not
          // incorrectly rejected when only one form is in the allowlist.
          const rHost = redirectUrl.hostname;
          if (!isAllowedDomain(rHost)) {
            throw new Error('Redirect to disallowed domain');
          }
          return fetchWithTimeout(redirectUrl.href, {
            headers: DIRECT_FETCH_HEADERS,
          }, timeout);
        }
      }

      return response;
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
        response = await fetchViaRailway(feedUrl, timeout);
        usedRelay = !!response;
        if (!response) throw directError;
      }

      if (!response.ok && !usedRelay) {
        const relayResponse = await fetchViaRailway(feedUrl, timeout);
        if (relayResponse?.ok) {
          response = relayResponse;
        }
      }
    }

    const data = await response.text();
    const isSuccess = response.status >= 200 && response.status < 300;
    // Relay-only feeds are slow-updating institutional sources — cache longer
    const cdnTtl = isRelayOnly ? 3600 : 900;
    const swr = isRelayOnly ? 7200 : 1800;
    const sie = isRelayOnly ? 14400 : 3600;
    const browserTtl = isRelayOnly ? 600 : 180;
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/xml',
        'Cache-Control': isSuccess
          ? `public, max-age=${browserTtl}, s-maxage=${cdnTtl}, stale-while-revalidate=${swr}, stale-if-error=${sie}`
          : 'public, max-age=15, s-maxage=60, stale-while-revalidate=120',
        ...(isSuccess && { 'CDN-Cache-Control': `public, s-maxage=${cdnTtl}, stale-while-revalidate=${swr}, stale-if-error=${sie}` }),
        ...corsHeaders,
      },
    });
  } catch (error) {
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
