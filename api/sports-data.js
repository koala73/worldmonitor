import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { createSportsDataProviders, isSportsProvider } from './_sports-data-config.js';

export const config = { runtime: 'edge' };

const REQUEST_TIMEOUT_MS = 12_000;
const PROVIDERS = createSportsDataProviders();

function resolveSportsRequest(providerKey, rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const provider = PROVIDERS[providerKey];
  if (!provider) return null;

  let parsed;
  try {
    parsed = new URL(rawPath, 'https://worldmonitor.app');
  } catch {
    return null;
  }

  const pathname = parsed.pathname;
  if (!(pathname in provider.endpointTtls)) return null;

  const allowedParams = provider.allowedParams[pathname];
  for (const key of parsed.searchParams.keys()) {
    if (!allowedParams.has(key)) return null;
  }

  return {
    upstreamUrl: `${provider.baseUrl}${pathname}${parsed.search}`,
    cacheTtl: provider.endpointTtls[pathname] || 300,
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

  const requestUrl = new URL(req.url);
  const providerKey = requestUrl.searchParams.get('provider') || 'thesportsdb';
  if (!isSportsProvider(providerKey)) {
    return jsonResponse({ error: 'Invalid sports provider' }, 400, corsHeaders);
  }

  const requestedPath = requestUrl.searchParams.get('path');
  const resolved = resolveSportsRequest(providerKey, requestedPath);
  if (!resolved) {
    return jsonResponse({ error: 'Invalid sports path' }, 400, corsHeaders);
  }

  const { upstreamUrl, cacheTtl } = resolved;

  try {
    const response = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WorldMonitor-Sports-Proxy/1.0',
      },
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'Cache-Control': response.ok
          ? `public, max-age=120, s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`
          : 'public, max-age=15, s-maxage=60, stale-while-revalidate=120',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return jsonResponse(
      { error: isTimeout ? 'Sports feed timeout' : 'Failed to fetch sports data' },
      isTimeout ? 504 : 502,
      corsHeaders,
    );
  }
}
