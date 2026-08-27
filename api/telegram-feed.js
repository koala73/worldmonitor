// @ts-check
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
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
 *   channel?: string;
 *   channelId?: string | number;
 *   channelName?: string;
 *   channelTitle?: string;
 *   sourceUrl?: string;
 *   url?: string;
 *   timestamp?: string | number;
 *   timestampMs?: string | number;
 *   ts?: string | number;
 *   text?: string;
 *   topic?: string;
 *   tags?: unknown[];
 *   earlySignal?: boolean;
 *   mediaUrls?: unknown[];
 * }} RawTelegramMessage
 */

/**
 * @typedef {{
 *   enabled?: boolean;
 *   source?: string;
 *   earlySignal?: boolean;
 *   updatedAt?: string | null;
 *   count?: number;
 *   messages?: RawTelegramMessage[];
 *   items?: RawTelegramMessage[];
 * }} RawTelegramFeedResponse
 */

/**
 * @typedef {{
 *   id: string;
 *   source: 'telegram';
 *   channel: string;
 *   channelTitle: string;
 *   url: string;
 *   ts: string;
 *   text: string;
 *   topic: string;
 *   tags: string[];
 *   earlySignal: boolean;
 *   mediaUrls: string[];
 * }} TelegramFeedItem
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
 * @param {(value: unknown) => string} mapper
 * @returns {string[]}
 */
function toTextArray(values, mapper = toText) {
  if (!Array.isArray(values)) return [];
  return values.map(mapper).filter(Boolean);
}

/**
 * @param {RawTelegramMessage} message
 * @returns {TelegramFeedItem}
 */
function normalizeTelegramMessage(message) {
  const channel = toText(message.channel ?? message.channelName ?? message.channelTitle).trim();
  const channelTitle = toText(message.channelTitle ?? message.channelName ?? message.channel).trim();
  const ts = toIsoTimestamp(message.timestampMs ?? message.timestamp ?? message.ts);
  const text = toText(message.text).trim();
  const id = toText(message.id).trim() || `${channel || 'telegram'}:${ts}:${text.slice(0, 32)}`;

  return {
    id,
    source: 'telegram',
    channel,
    channelTitle: channelTitle || channel,
    url: toHttpUrl(message.sourceUrl ?? message.url),
    ts,
    text,
    topic: toText(message.topic).trim(),
    tags: toTextArray(message.tags),
    earlySignal: Boolean(message.earlySignal),
    mediaUrls: toTextArray(message.mediaUrls, toHttpUrl),
  };
}

/**
 * @param {RawTelegramFeedResponse} parsed
 */
function normalizeTelegramFeed(parsed) {
  const rawMessages = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const items = rawMessages.map(normalizeTelegramMessage);
  return {
    source: toText(parsed.source).trim() || 'telegram',
    earlySignal: Boolean(parsed.earlySignal),
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: parsed.updatedAt ?? null,
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

  // Same hole #6654 closed on api/x-feed.js: isDisallowedOrigin returns false
  // when Origin is absent, so a bare `curl /api/telegram-feed` collected every
  // post body. Origin is not a fix either — it is client-controlled at the
  // wire, so a header-only gate costs an attacker one `-H` (the #3541 bypass
  // class). Reuse the sibling credential gate. Not forceKey: the panel is
  // anonymous, so the HMAC-signed wms_ session the browser mints at boot is
  // the intended credential; forceKey would demand user-bound Pro auth and
  // lock the dashboard out of its own panel.
  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, { 'Cache-Control': 'no-store', ...corsHeaders });
  }

  // The credential above is attributable, not scarce: POST /api/wm-session mints
  // an anonymous wms_ token to anyone (30/min/IP, 12h TTL), so without a volume
  // ceiling one token drives unbounded ?limit=200 reads of the R4 corpus for half
  // a day. Pair the gate with a limit the way the sibling credentialed relay
  // proxies already do (api/polymarket.js requireApiKey+requireRateLimit,
  // api/rss-proxy.js's direct checkRateLimit call). 60/min/IP is double the
  // panel's own 60s refresh cadence (REFRESH_INTERVALS.telegramIntel), so a real
  // dashboard tab — including a burst of topic-tab switches — never trips it.
  // Fails open when Upstash is unconfigured, matching rss-proxy.
  const rateLimitResponse = await checkRateLimit(req, corsHeaders, {
    scope: 'telegram-feed',
    limit: 60,
    window: '60 s',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return jsonResponse({ error: 'WS_RELAY_URL is not configured' }, 503, corsHeaders);
  }

  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const topic = (url.searchParams.get('topic') || '').trim();
    const channel = (url.searchParams.get('channel') || '').trim();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (topic) params.set('topic', topic);
    if (channel) params.set('channel', channel);

    const relayUrl = `${relayBaseUrl}/telegram/feed?${params}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
    }, 15000);

    const body = await response.text();

    // Availability now depends on a request credential, so a URL-keyed shared
    // entry would answer for the origin and hand an unauthenticated caller the
    // authorized payload — a CDN hit precedes handler auth (the #5386 failure
    // mode on /api/bootstrap). `private` bars every shared cache rather than
    // fragmenting one: each wms_ token carries a random nonce, so a Vary on the
    // credential would key roughly one edge entry per browser anyway. The 30s
    // browser window is preserved because the panel already assumes it
    // (CACHE_TTL in src/services/telegram-intel.ts).
    let cacheControl = 'private, max-age=30';
    if (!response.ok) {
      return buildRelayResponse(response, body, {
        'Cache-Control': 'no-store',
        ...corsHeaders,
      });
    }

    try {
      const parsed = /** @type {RawTelegramFeedResponse} */ (JSON.parse(body));
      const normalized = normalizeTelegramFeed(parsed);
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
      // Fall through to the raw relay body so a shape change upstream still
      // serves data, but never silently: clients receive an un-normalized
      // payload, which is a bug worth an alert.
      console.warn('[telegram-feed] normalization failed:', normalizeError?.message || String(normalizeError));
      void captureSilentError(normalizeError, { tags: { route: 'api/telegram-feed', step: 'normalize' } });
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
