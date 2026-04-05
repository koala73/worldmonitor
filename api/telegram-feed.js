// @ts-check
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const EPOCH_ISO = new Date(0).toISOString();

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
function toString(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toHttpUrl(value) {
  const raw = toString(value).trim();
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
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  const raw = toString(value).trim();
  if (!raw) return EPOCH_ISO;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : EPOCH_ISO;
}

/**
 * @param {unknown[] | undefined} values
 * @param {(value: unknown) => string} mapper
 * @returns {string[]}
 */
function toStringArray(values, mapper = toString) {
  if (!Array.isArray(values)) return [];
  return values.map(mapper).filter(Boolean);
}

/**
 * @param {RawTelegramMessage} message
 * @returns {TelegramFeedItem}
 */
function normalizeTelegramMessage(message) {
  const channel = toString(message.channel ?? message.channelName ?? message.channelTitle).trim();
  const channelTitle = toString(message.channelTitle ?? message.channelName ?? message.channel).trim();
  const ts = toIsoTimestamp(message.timestampMs ?? message.timestamp ?? message.ts);
  const text = toString(message.text).trim();
  const id = toString(message.id).trim() || `${channel || 'telegram'}:${ts}:${text.slice(0, 32)}`;

  return {
    id,
    source: 'telegram',
    channel,
    channelTitle: channelTitle || channel,
    url: toHttpUrl(message.sourceUrl ?? message.url),
    ts,
    text,
    topic: toString(message.topic).trim(),
    tags: toStringArray(message.tags),
    earlySignal: Boolean(message.earlySignal),
    mediaUrls: toStringArray(message.mediaUrls, toHttpUrl),
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
    source: toString(parsed.source).trim() || 'telegram',
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

    let cacheControl = 'public, max-age=30, s-maxage=120, stale-while-revalidate=60, stale-if-error=120';
    try {
      const parsed = /** @type {RawTelegramFeedResponse} */ (JSON.parse(body));
      const normalized = normalizeTelegramFeed(parsed);
      if (normalized.count === 0) {
        cacheControl = 'public, max-age=0, s-maxage=15, stale-while-revalidate=10';
      }
      return buildRelayResponse(response, JSON.stringify(normalized), {
        'Cache-Control': response.ok ? cacheControl : 'no-store',
        ...corsHeaders,
      });
    } catch {}

    return buildRelayResponse(response, body, {
      'Cache-Control': response.ok ? cacheControl : 'no-store',
      ...corsHeaders,
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return jsonResponse({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }, isTimeout ? 504 : 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
