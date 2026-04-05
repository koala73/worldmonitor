import { createRelayHandler } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const USERNAME_RE = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;

function getUsername(req) {
  const url = new URL(req.url);
  return (url.searchParams.get('username') || '').trim();
}

const relayHandler = createRelayHandler({
  relayPath: '/telegram/resolve',
  timeout: 15000,
  cacheHeaders: (isSuccess) => ({
    'Cache-Control': isSuccess
      ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200, stale-if-error=86400'
      : 'no-store',
  }),
});

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

  const username = getUsername(req);
  if (!USERNAME_RE.test(username)) {
    return jsonResponse({ error: 'Invalid Telegram username' }, 400, corsHeaders);
  }

  return relayHandler(req);
}
