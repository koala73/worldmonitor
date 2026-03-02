import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

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

  const requestUrl = new URL(req.url);
  const endpoint = requestUrl.searchParams.get('endpoint');
  const isHistory = endpoint === 'history';

  const relayBaseUrl = getRelayBaseUrl();

  if (relayBaseUrl) {
    try {
      const relayPath = isHistory ? '/oref/history' : '/oref/alerts';
      const response = await fetchWithTimeout(`${relayBaseUrl}${relayPath}`, {
        headers: getRelayHeaders({ Accept: 'application/json' }),
      }, 12000);

      if (response.ok) {
        const cacheControl = isHistory
          ? 'public, max-age=60, s-maxage=180, stale-while-revalidate=60, stale-if-error=600'
          : 'public, max-age=60, s-maxage=180, stale-while-revalidate=60, stale-if-error=600';
        return new Response(await response.text(), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': cacheControl,
            ...corsHeaders,
          },
        });
      }
    } catch {
      // Relay failed
    }
  }

  return new Response(JSON.stringify({
    configured: false,
    alerts: [],
    historyCount24h: 0,
    timestamp: new Date().toISOString(),
    error: 'No data source available',
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
