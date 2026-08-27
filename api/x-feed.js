// @ts-check
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

const EPOCH_ISO = new Date(0).toISOString();

// Every header validateApiKey can read a credential from, plus Origin (still
// gated by isDisallowedOrigin). Two callers with different credentials must
// never share a cache entry.
const VARY_CREDENTIAL = 'Origin, Cookie, X-WorldMonitor-Key, X-Api-Key, Authorization';

/**
 * @typedef {{
 *   id?: string | number;
 *   postId?: string | number;
 *   accountId?: string | number;
 *   account?: string;
 *   accountTitle?: string;
 *   accountName?: string;
 *   handle?: string;
 *   sourceUrl?: string;
 *   url?: string;
 *   permalink?: string;
 *   timestamp?: string | number;
 *   timestampMs?: string | number;
 *   ts?: string | number;
 *   text?: string;
 *   topic?: string;
 *   tags?: unknown[];
 *   earlySignal?: boolean;
 *   hasMedia?: boolean;
 *   lang?: string;
 *   contentState?: string;
 * }} RawXPost
 */

/**
 * @typedef {{
 *   enabled?: boolean;
 *   source?: string;
 *   earlySignal?: boolean;
 *   updatedAt?: string | null;
 *   lastHealthyAt?: string | null;
 *   coverage?: { expected?: number; polled?: number; failed?: number; attempted?: number; complete?: boolean };
 *   count?: number;
 *   posts?: RawXPost[];
 *   items?: RawXPost[];
 * }} RawXFeedResponse
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toHttpUrl(value) {
  const raw = toText(value).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toIsoTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return EPOCH_ISO;
    return new Date(value >= 1e12 ? value : value * 1000).toISOString();
  }
  const raw = toText(value).trim();
  if (!raw) return EPOCH_ISO;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric >= 1e12 ? numeric : numeric * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : EPOCH_ISO;
}

/**
 * @param {unknown[] | undefined} values
 * @returns {string[]}
 */
function toTextArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toText).filter(Boolean);
}

/**
 * First-party panel contract. API-fresh post text is allowed here.
 * MCP/embed partners must use list-x-feed (facts + permalink only).
 * @param {RawXPost} post
 */
function normalizeXPost(post) {
  const handle = toText(post.handle ?? post.account).trim();
  const accountTitle = toText(post.accountTitle ?? post.accountName ?? post.account ?? handle).trim();
  const ts = toIsoTimestamp(post.timestampMs ?? post.timestamp ?? post.ts);
  const text = toText(post.text).trim();
  const postId = toText(post.postId ?? post.id).trim();
  const id = toText(post.id).trim() || `${handle || 'x'}:${postId || ts}`;

  return {
    id,
    postId,
    source: 'x',
    account: handle,
    accountId: toText(post.accountId).trim(),
    accountTitle: accountTitle || handle,
    url: toHttpUrl(post.permalink ?? post.sourceUrl ?? post.url),
    ts,
    text,
    topic: toText(post.topic).trim(),
    tags: toTextArray(post.tags),
    earlySignal: Boolean(post.earlySignal),
    hasMedia: Boolean(post.hasMedia),
    lang: toText(post.lang).trim(),
    contentState: toText(post.contentState).trim() || 'active',
  };
}

/**
 * @param {RawXFeedResponse} parsed
 */
function normalizeXFeed(parsed) {
  const rawPosts = Array.isArray(parsed.posts)
    ? parsed.posts
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const items = rawPosts
    .map(normalizeXPost)
    .filter((item) => item.contentState !== 'deleted');
  const coverage = {
    expected: Math.max(0, Math.floor(Number(parsed.coverage?.expected) || 0)),
    polled: Math.max(0, Math.floor(Number(parsed.coverage?.polled) || 0)),
    failed: Math.max(0, Math.floor(Number(parsed.coverage?.failed) || 0)),
    attempted: Math.max(0, Math.floor(Number(parsed.coverage?.attempted) || 0)),
    complete: parsed.coverage?.complete === true,
  };
  return {
    source: toText(parsed.source).trim() || 'x',
    earlySignal: Boolean(parsed.earlySignal),
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: parsed.updatedAt ?? null,
    lastHealthyAt: parsed.lastHealthyAt ?? null,
    degraded: coverage.expected > 0 && !coverage.complete,
    coverage,
    items,
  };
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // R4 (#6654): this is the ONLY route that serves post bodies, and it must
  // stay the first-party panel's route. isDisallowedOrigin above cannot hold
  // that line by itself — it returns false when Origin is absent, so a bare
  // `curl /api/x-feed?limit=200` collected every body. Origin is not a fix
  // either: it is client-controlled at the wire level, so a gate built on it
  // costs an attacker one `-H`. That is the bypass class issue #3541 closed
  // for validateApiKey, and the reason no header-only browser signal (Origin,
  // Referer, Sec-Fetch-Site) is trusted anywhere in this file.
  //
  // Reuse the credential gate the sibling relay routes already run
  // (api/rss-proxy.js, _relay.js createRelayHandler({ requireApiKey: true })).
  // Not forceKey: the panel is anonymous, so the HMAC-signed wms_ session that
  // the browser mints at boot is the intended credential here; forceKey would
  // demand user-bound Pro auth and lock the dashboard out of its own panel.
  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, { 'Cache-Control': 'no-store', ...corsHeaders });
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return jsonResponse({ error: 'WS_RELAY_URL is not configured' }, 503, corsHeaders);
  }

  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const topic = (url.searchParams.get('topic') || '').trim();
    const account = (url.searchParams.get('account') || url.searchParams.get('channel') || '').trim();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (topic) params.set('topic', topic);
    if (account) params.set('account', account);

    const relayUrl = `${relayBaseUrl}/x/feed?${params}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json', 'User-Agent': 'WorldMonitor-X-Feed/1.0' }),
    }, 15000);

    const body = await response.text();

    // Availability now depends on a request credential, so a URL-keyed shared
    // entry would answer for the origin and hand an unauthenticated caller the
    // authorized payload — a CDN hit precedes handler auth (the #5386 failure
    // mode on /api/bootstrap). `private` bars every shared cache rather than
    // fragmenting one: each wms_ token carries a random nonce, so a Vary on the
    // credential would key roughly one edge entry per browser anyway. The 30s
    // browser window is preserved because the panel already assumes it
    // (CACHE_TTL in src/services/x-intel.ts).
    let cacheControl = 'private, max-age=30';
    if (!response.ok) {
      return buildRelayResponse(response, body, {
        'Cache-Control': 'no-store',
        ...corsHeaders,
      });
    }

    try {
      const parsed = /** @type {RawXFeedResponse} */ (JSON.parse(body));
      const normalized = normalizeXFeed(parsed);
      if (normalized.count === 0) {
        cacheControl = 'private, max-age=0';
      }
      return buildRelayResponse(response, JSON.stringify(normalized), {
        'Cache-Control': cacheControl,
        ...corsHeaders,
        // Overrides the plain `Vary: Origin` from getCorsHeaders. Declares the
        // real cache key for any intermediary that stores despite `private`.
        'Vary': VARY_CREDENTIAL,
      });
    } catch (normalizeError) {
      console.warn('[x-feed] normalization failed:', normalizeError?.message || String(normalizeError));
      void captureSilentError(normalizeError, { tags: { route: 'api/x-feed', step: 'normalize' } });
    }

    return buildRelayResponse(response, body, {
      'Cache-Control': cacheControl,
      ...corsHeaders,
      'Vary': VARY_CREDENTIAL,
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return jsonResponse({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }, isTimeout ? 504 : 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
