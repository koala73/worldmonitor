import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

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
    if (topic) params.set('topic', encodeURIComponent(topic));
    if (channel) params.set('channel', encodeURIComponent(channel));

    const relayUrl = `${relayBaseUrl}/telegram/feed?${params}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
    }, 15000);

    const body = await response.text();

    let cacheControl = 'public, max-age=30, s-maxage=120, stale-while-revalidate=60, stale-if-error=120';
    try {
      const parsed = JSON.parse(body);
      if (!parsed || parsed.count === 0 || !parsed.items || parsed.items.length === 0) {
        cacheControl = 'public, max-age=0, s-maxage=15, stale-while-revalidate=10';
      }
    } catch {}

    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'Cache-Control': cacheControl,
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return jsonResponse({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }, isTimeout ? 504 : 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
