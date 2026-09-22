import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { getRelayBaseUrl, getRelayHeaders } from './_relay.js';
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
const MAX_FEED_BYTES = 5 * 1024 * 1024;

// Consumers render far fewer items than a feed carries: src/services/rss.ts
// slices to 5, src/services/country-coverage.ts lower still. Stopping the read
// here bounds a 1400-episode podcast feed to a few KB instead of 11.92 MB.
const MAX_FEED_ITEMS = 20;
const ITEM_CLOSE_PATTERN = /<\/(?:item|entry)\s*>/gi;
// Longest `</entry  >` spelling we rescan across a chunk seam.
const ITEM_CLOSE_SEAM = 16;

/**
 * Closing tags for every element still open in `xml`, outermost last.
 *
 * A body cut at an item boundary is still missing its `</channel></rss>` or
 * `</feed>`. Consumers parse with a strict XML parser and treat a parse error
 * as a total feed failure, so an unclosed root costs the whole feed rather
 * than the trimmed tail. Comments and CDATA are skipped so markup quoted
 * inside them cannot unbalance the stack.
 */
function closeOpenElements(xml) {
  const stack = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? xml.length : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) break;
    const raw = xml.slice(lt + 1, gt);
    const name = raw.replace(/^\//, '').match(/^[A-Za-z_][\w.:-]*/)?.[0];
    if (name) {
      if (raw.startsWith('/')) {
        const open = stack.lastIndexOf(name);
        if (open !== -1) stack.length = open;
      } else if (!raw.endsWith('/')) {
        stack.push(name);
      }
    }
    i = gt + 1;
  }
  return stack.reverse().map((name) => `</${name}>`).join('');
}

/**
 * Stable Sentry grouping fingerprint for an `api/rss-proxy` capture.
 *
 * Both capture sites run in the minified edge bundle, whose frames are all
 * anonymous `(vc/edge/function` with no source map. Sentry's default grouping
 * keys on that stack, so unfingerprinted captures collapse into whatever
 * catch-all shares it — WORLDMONITOR-ZR absorbed a feed error next to six
 * events from an unrelated subsystem. Same remedy as
 * `api/mcp/error-fingerprint.ts`.
 *
 * Keyed on the error class, never the feed URL: the allowlist carries 428
 * hosts, and a URL-keyed fingerprint would mint 428 issues for one outage.
 */
function rssProxyErrorFingerprint(step, error) {
  const name = error instanceof Error ? error.name || 'Error' : 'non-error';
  return ['rss-proxy', step, name];
}

// Own the deadline through body consumption, without changing other relay callers.
async function fetchRssResponse(url, options, timeoutMs) {
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException('Feed timeout', 'AbortError'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      // A late fetch must not leave a body alive after the deadline won.
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      const result = { status: response.status, ok: response.ok, headers: response.headers, data: '' };
      if (options.redirect === 'manual' && DIRECT_REDIRECT_STATUSES.has(response.status)
        && response.headers.get('location')) {
        void response.body?.cancel().catch(() => {});
        return result;
      }
      if (!response.body) return result;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      // End offset of the last complete item, and how far we have scanned for
      // one. Scanning resumes a seam short of the tail so a close tag split
      // across two chunks is still seen, and never before `keepTo`, so a tag
      // already counted cannot be counted twice.
      let keepTo = -1;
      let scannedTo = 0;
      let items = 0;
      let bounded = false;
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        // Fetch exposes decoded bytes; Content-Length may describe compressed data.
        bytes += value.byteLength;
        result.data += decoder.decode(value, { stream: true });

        ITEM_CLOSE_PATTERN.lastIndex = scannedTo;
        for (let m = ITEM_CLOSE_PATTERN.exec(result.data); m; m = ITEM_CLOSE_PATTERN.exec(result.data)) {
          items += 1;
          keepTo = m.index + m[0].length;
          if (items >= MAX_FEED_ITEMS) break;
        }
        scannedTo = Math.max(keepTo, result.data.length - ITEM_CLOSE_SEAM);

        if (items >= MAX_FEED_ITEMS || bytes > MAX_FEED_BYTES) {
          bounded = true;
          break;
        }
      }
      result.data += decoder.decode();
      if (bounded) {
        // A single item wider than the byte cap leaves nothing well-formed to
        // keep, so that stays a hard failure.
        if (keepTo < 0) throw new Error('Feed body too large');
        const kept = result.data.slice(0, keepTo);
        result.data = kept + closeOpenElements(kept);
        void reader.cancel().catch(() => {});
      }
      return result;
    })()]);
  } catch (error) {
    controller.abort();
    // Cancellation can itself stall. Request it, but never extend the deadline.
    void reader?.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

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
  return fetchRssResponse(relayUrl, {
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
        const response = await fetchRssResponse(currentUrl.href, {
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
          // Skip Sentry on timeout, exactly as the outer catch does for the
          // direct leg. fetchViaRailway aborts on the same feed timeout budget,
          // and this retry is a best-effort SECOND attempt whose failure the
          // caller never sees — the original non-ok direct response is returned
          // either way. Capturing it reported routine upstream latency at error
          // level (WORLDMONITOR-11G); #7438 made the same call for
          // api/telegram-feed.js. Real relay failures still report.
          if (relayError?.name !== 'AbortError') {
            captureSilentError(relayError, { tags: { route: 'api/rss-proxy', step: 'relay-retry', feed: feedUrl }, fingerprint: rssProxyErrorFingerprint('relay-retry', relayError), ctx });
          }
        }
        if (relayResponse?.ok) {
          response = relayResponse;
          usedRelay = true;
        }
      }
    }

    const data = response.data;
    const relayCacheState = usedRelay ? response.headers.get('x-cache') : null;
    const relayStaleMarker = usedRelay ? response.headers.get('x-relay-stale') : null;
    return new Response(data, {
      status: response.status,
      headers: {
        // Consumers parse response.text() as feed XML. Never let an upstream
        // MIME type or active XML turn this same-origin URL into a document.
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        // validateApiKey() gates every GET. Shared caches do not key on the
        // credential header, so this must not be public / s-maxage / CDN-cached.
        // `private` keeps CDNs out; max-age lets the SPA feedCache persist.
        'Cache-Control': 'private, max-age=180',
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
      captureSilentError(error, { tags: { route: 'api/rss-proxy', step: 'fetch', feed: feedUrl }, fingerprint: rssProxyErrorFingerprint('fetch', error), ctx });
    }
    return jsonResponse({
      error: isTimeout ? 'Feed timeout' : 'Failed to fetch feed',
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
