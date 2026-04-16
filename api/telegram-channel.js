import { createRelayHandler } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const USERNAME_RE = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;

function getParams(req) {
  const url = new URL(req.url);
  const username = (url.searchParams.get('username') || '').trim();
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
  return { username, limit };
}

const relayHandler = createRelayHandler({
  relayPath: '/telegram/channel',
  timeout: 15000,
  cacheHeaders: (isSuccess) => ({
    'Cache-Control': isSuccess
      ? 'public, max-age=30, s-maxage=60, stale-while-revalidate=30, stale-if-error=60'
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

  const { username, limit } = getParams(req);
  if (!USERNAME_RE.test(username)) {
    return jsonResponse({ error: 'Invalid Telegram username' }, 400, corsHeaders);
  }

  const url = new URL(req.url);
  url.searchParams.set('limit', String(limit));
  return relayHandler(new Request(url, req));
}
