import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

/**
 * Normalize relay Telegram message to the browser UI model.
 * The relay may return either `messages[]` or `items[]` with varying field names.
 * The browser UI (TelegramIntelPanel) expects `items[]` with:
 *   id, source, channel, channelTitle, url, ts, text, topic, tags, earlySignal, mediaUrls
 */
function normalizeTelegramMessage(msg) {
  const timestamp = msg.timestamp ?? msg.ts ?? msg.timestampMs ?? null;
  const ts = timestamp === null
    ? null
    : typeof timestamp === 'number'
      ? (timestamp > 1e12 ? new Date(timestamp).toISOString() : new Date(timestamp * 1000).toISOString())
      : (timestamp ? new Date(timestamp).toISOString() : null);

  return {
    id: String(msg.id ?? ''),
    source: 'telegram',
    channel: String(msg.channelName ?? msg.channel ?? ''),
    channelTitle: String(msg.channelTitle ?? msg.channelName ?? msg.channel ?? ''),
    url: String(msg.sourceUrl ?? msg.url ?? ''),
    ts,
    text: String(msg.text ?? ''),
    topic: String(msg.topic ?? ''),
    tags: Array.isArray(msg.tags) ? msg.tags : [],
    earlySignal: Boolean(msg.earlySignal ?? false),
    mediaUrls: Array.isArray(msg.mediaUrls) ? msg.mediaUrls.map(String) : [],
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
      const parsed = JSON.parse(body);
      // Normalize: extract messages from messages[] OR items[], then normalize each to UI model
      const rawMessages = Array.isArray(parsed?.messages) ? parsed.messages
        : Array.isArray(parsed?.items) ? parsed.items
        : [];
      const normalizedItems = rawMessages.map(normalizeTelegramMessage);
      const normalizedCount = parsed?.count ?? normalizedItems.length;
      const normalizedResponse = {
        enabled: parsed?.enabled ?? true,
        count: normalizedCount,
        updatedAt: parsed?.updatedAt ?? null,
        items: normalizedItems,
      };
      if (!parsed || normalizedCount === 0 || normalizedItems.length === 0) {
        cacheControl = 'public, max-age=0, s-maxage=15, stale-while-revalidate=10';
      }
      return buildRelayResponse(response, JSON.stringify(normalizedResponse), {
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
