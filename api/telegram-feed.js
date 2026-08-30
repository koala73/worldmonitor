// @ts-check
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';
import { sha256Hex } from './_crypto.js';

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

const TELEGRAM_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
// Every value here must stay under the Edge runtime's 25s begin-response
// ceiling: this handler never streams (it awaits the whole relay body, then
// returns one Response), so past 25s the platform kills the invocation and the
// caller sees a platform error instead of our own 504 envelope. The relay
// enforces a matching TELEGRAM_LOOKUP_DEADLINE_MS on its side.
const TELEGRAM_RELAY_TIMEOUT_MS = {
  feed: 15_000,
  resolve: 20_000,
  channel: 22_000,
};
// `channel` is the fan-out mode: one request per watchlist entry, so the limit
// has to clear TELEGRAM_WATCHLIST_MAX_ENTRIES (20) with room for a second tab
// and an in-window add. Setting it equal to the cap left exactly zero headroom
// and silently dropped channels from the panel on any overlap.
const TELEGRAM_RATE_LIMIT_POLICY = {
  feed: { scope: 'telegram-feed:feed', limit: 60, window: '60 s' },
  resolve: { scope: 'telegram-feed:resolve', limit: 30, window: '60 s' },
  channel: { scope: 'telegram-feed:channel', limit: 60, window: '60 s' },
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function toTelegramUsername(value) {
  const username = toText(value).trim().replace(/^@+/, '').toLowerCase();
  return TELEGRAM_USERNAME_RE.test(username) ? username : '';
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
 * @returns {Promise<TelegramFeedItem>}
 */
async function normalizeTelegramMessage(message) {
  const channel = toText(message.channel ?? message.channelName ?? message.channelTitle).trim();
  const channelTitle = toText(message.channelTitle ?? message.channelName ?? message.channel).trim();
  const ts = toIsoTimestamp(message.timestampMs ?? message.timestamp ?? message.ts);
  const text = toText(message.text).trim();
  // Synthetic id (only when the relay omits message.id): hash the FULL text
  // rather than a 32-char prefix. Same-channel same-second messages sharing a
  // templated prefix ("BREAKING: ..." alerts) collided under the prefix and
  // one of the pair was deduped away downstream (#7210). Timestamps are
  // whole-second when the relay supplies epoch seconds, so the text is the
  // only reliable discriminator - and byte-identical text at the same second
  // is a genuine duplicate that SHOULD collapse to one id.
  const id = toText(message.id).trim()
    || `${channel || 'telegram'}:${ts}:${((await sha256Hex(text)) ?? '').slice(0, 16)}`;

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
async function normalizeTelegramFeed(parsed) {
  const rawMessages = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const items = await Promise.all(rawMessages.map(normalizeTelegramMessage));
  return {
    source: toText(parsed.source).trim() || 'telegram',
    earlySignal: Boolean(parsed.earlySignal),
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: parsed.updatedAt ?? null,
    items,
  };
}

/**
 * @param {unknown} value
 */
function normalizeTelegramPreview(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid Telegram channel preview');
  const parsed = /** @type {Record<string, unknown>} */ (value);
  const username = toTelegramUsername(parsed.username);
  if (!username) throw new Error('Invalid Telegram channel username');
  const title = toText(parsed.title).trim() || username;
  const memberCount = parsed.memberCount == null || parsed.memberCount === ''
    ? Number.NaN
    : Number(parsed.memberCount);
  return {
    username,
    title,
    memberCount: Number.isFinite(memberCount) && memberCount >= 0 ? Math.floor(memberCount) : null,
    url: `https://t.me/${username}`,
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

  const url = new URL(req.url);
  const mode = (url.searchParams.get('mode') || 'feed').trim().toLowerCase();
  if (!Object.hasOwn(TELEGRAM_RATE_LIMIT_POLICY, mode)) {
    return jsonResponse({ error: 'Invalid Telegram feed mode' }, 400, { 'Cache-Control': 'no-store', ...corsHeaders });
  }

  // The credential above is attributable, not scarce: POST /api/wm-session mints
  // an anonymous wms_ token to anyone (30/min/IP, 12h TTL), so without a volume
  // ceiling one token drives unbounded ?limit=200 reads of the R4 corpus for half
  // a day. Pair the gate with a limit the way the sibling credentialed relay
  // proxies already do (api/polymarket.js requireApiKey+requireRateLimit,
  // api/rss-proxy.js's direct checkRateLimit call). Separate scopes keep the
  // capped channel fanout from starving the base feed or interactive resolves.
  // Fails open when Upstash is unconfigured, matching rss-proxy.
  // Deliberately fail-open (the repo default), including for resolve/channel.
  // The tempting argument is that these modes spend a shared Telegram account's
  // flood budget, so the limit "is" the abuse defence and should fail closed.
  // It isn't: the hard ceiling on Telegram RPC volume is the relay's in-process
  // queue (TELEGRAM_RPC_MAX_CONCURRENCY + a global TELEGRAM_RPC_MIN_INTERVAL_MS
  // start interval, ~75 RPC/min), which cannot fail open because it is not
  // backed by Redis. This limit only allocates that fixed budget fairly BETWEEN
  // callers. Failing closed would therefore trade the whole watchlist feature
  // for fairness during an Upstash blip, without changing the account's
  // exposure at all.
  const rateLimitResponse = await checkRateLimit(req, corsHeaders, TELEGRAM_RATE_LIMIT_POLICY[mode]);
  if (rateLimitResponse) return rateLimitResponse;

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return jsonResponse({ error: 'WS_RELAY_URL is not configured' }, 503, corsHeaders);
  }

  try {
    const params = new URLSearchParams();
    let relayPath = '/telegram/feed';
    if (mode === 'resolve' || mode === 'channel') {
      const username = toTelegramUsername(url.searchParams.get('username'));
      if (!username) {
        return jsonResponse({ error: 'Invalid public Telegram username' }, 400, { 'Cache-Control': 'no-store', ...corsHeaders });
      }
      relayPath = mode === 'resolve' ? '/telegram/resolve' : '/telegram/channel';
      params.set('username', username);
      if (mode === 'channel') {
        const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
        params.set('limit', String(limit));
      }
    } else {
      const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const topic = (url.searchParams.get('topic') || '').trim();
      const channel = (url.searchParams.get('channel') || '').trim();
      params.set('limit', String(limit));
      if (topic) params.set('topic', topic);
      if (channel) params.set('channel', channel);
    }

    const relayUrl = `${relayBaseUrl}${relayPath}?${params}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({
        Accept: 'application/json',
        'User-Agent': 'WorldMonitor/1.0',
      }),
    }, TELEGRAM_RELAY_TIMEOUT_MS[mode]);

    const body = await response.text();
    const retryAfter = response.headers.get('retry-after');
    const relayHeaders = retryAfter ? { 'Retry-After': retryAfter } : {};

    // Availability now depends on a request credential, so a URL-keyed shared
    // entry would answer for the origin and hand an unauthenticated caller the
    // authorized payload — a CDN hit precedes handler auth (the #5386 failure
    // mode on /api/bootstrap). `private` bars every shared cache rather than
    // fragmenting one: each wms_ token carries a random nonce, so a Vary on the
    // credential would key roughly one edge entry per browser anyway.
    let cacheControl = mode === 'resolve' ? 'private, max-age=3600' : 'private, max-age=30';
    if (!response.ok) {
      return buildRelayResponse(response, body, {
        'Cache-Control': 'no-store',
        ...relayHeaders,
        ...corsHeaders,
      });
    }

    try {
      const parsedBody = JSON.parse(body);
      if (mode === 'resolve') {
        const normalized = normalizeTelegramPreview(parsedBody);
        return buildRelayResponse(response, JSON.stringify(normalized), {
          'Cache-Control': cacheControl,
          ...relayHeaders,
          ...corsHeaders,
          'Vary': VARY_CREDENTIAL,
        });
      }
      const parsed = /** @type {RawTelegramFeedResponse} */ (parsedBody);
      const normalized = await normalizeTelegramFeed(parsed);
      if (normalized.count === 0) {
        cacheControl = 'private, max-age=0';
      }
      return buildRelayResponse(response, JSON.stringify(normalized), {
        'Cache-Control': cacheControl,
        ...relayHeaders,
        ...corsHeaders,
        // Overrides the plain `Vary: Origin` from getCorsHeaders. Declares the
        // real cache key for any intermediary that stores despite `private`.
        'Vary': VARY_CREDENTIAL,
      });
    } catch (normalizeError) {
      console.warn('[telegram-feed] normalization failed:', normalizeError?.message || String(normalizeError));
      void captureSilentError(normalizeError, { tags: { route: 'api/telegram-feed', step: 'normalize' } });
      if (mode === 'resolve') {
        return jsonResponse({ error: 'Invalid Telegram channel response' }, 502, {
          'Cache-Control': 'no-store',
          ...corsHeaders,
        });
      }
    }

    // Reached only when JSON.parse or normalization threw, i.e. the handler has
    // already reported this body to Sentry as un-normalizable. Hand it back for
    // the client's own tolerant parse, but never let a shape we just flagged as
    // invalid sit in a cache for 30s.
    return buildRelayResponse(response, body, {
      'Cache-Control': 'no-store',
      ...relayHeaders,
      ...corsHeaders,
      'Vary': VARY_CREDENTIAL,
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    // No `details`: the underlying message can carry relay transport detail
    // (undici cause chains, MTProto text) and the browser has no use for it.
    // It is captured server-side instead.
    console.warn('[telegram-feed] relay request failed:', error?.message || String(error));
    void captureSilentError(error, { tags: { route: 'api/telegram-feed', step: 'relay-fetch' } });
    return jsonResponse({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
    }, isTimeout ? 504 : 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
