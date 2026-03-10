import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return new Response(JSON.stringify({ error: 'WS_RELAY_URL is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
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
    let data;
    try {
      data = JSON.parse(body);
      // Ensure the frontend knows it's enabled if we got a valid response from the relay
      if (typeof data === 'object' && data !== null) {
        data.enabled = true;
      }
    } catch {
      data = { error: 'Invalid relay response', enabled: false };
    }

    const cacheControl = data.count > 0
      ? 'public, max-age=30, s-maxage=120, stale-while-revalidate=60, stale-if-error=120'
      : 'public, max-age=0, s-maxage=15, stale-while-revalidate=10';

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': cacheControl,
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return new Response(JSON.stringify({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
}
