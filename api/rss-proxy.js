import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout } from './_relay.js';
import RSS_ALLOWED_DOMAINS from './_rss-allowed-domains.js';

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

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  const requestUrl = new URL(req.url);
  const feedUrl = requestUrl.searchParams.get('url');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const parsedUrl = new URL(feedUrl);

    // Security: Check if domain is allowed (normalize www prefix)
    const hostname = parsedUrl.hostname;
    const bare = hostname.replace(/^www\./, '');
    const withWww = hostname.startsWith('www.') ? hostname : `www.${hostname}`;
    if (!ALLOWED_DOMAINS.includes(hostname) && !ALLOWED_DOMAINS.includes(bare) && !ALLOWED_DOMAINS.includes(withWww)) {
      return new Response(JSON.stringify({ error: 'Domain not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const isRelayOnly = RELAY_ONLY_DOMAINS.has(hostname);

    // Google News is slow - use longer timeout
    const isGoogleNews = feedUrl.includes('news.google.com');
    const timeout = isGoogleNews ? 20000 : 12000;

    const fetchDirect = async () => {
      const response = await fetchWithTimeout(feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
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
          const rBare = rHost.replace(/^www\./, '');
          const rWithWww = rHost.startsWith('www.') ? rHost : `www.${rHost}`;
          if (
            !ALLOWED_DOMAINS.includes(rHost) &&
            !ALLOWED_DOMAINS.includes(rBare) &&
            !ALLOWED_DOMAINS.includes(rWithWww)
          ) {
            throw new Error('Redirect to disallowed domain');
          }
          return fetchWithTimeout(redirectUrl.href, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, text/xml, */*',
              'Accept-Language': 'en-US,en;q=0.9',
            },
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
        if (relayResponse && relayResponse.ok) {
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
    return new Response(JSON.stringify({
      error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
      details: error.message,
      url: feedUrl
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
