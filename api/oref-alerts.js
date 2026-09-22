import { createRelayHandler } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const relayOref = createRelayHandler({
  publicCors: true,
  requireRateLimit: true,
  buildRelayPath: (_req, url) => {
    const endpoint = url.searchParams.get('endpoint');
    return endpoint === 'history' ? '/oref/history' : '/oref/alerts';
  },
  forwardSearch: false,
  timeout: 12000,
  onlyOk: true,
  cacheHeaders: () => ({
    'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=120, stale-if-error=900',
  }),
  fallback: (_req, corsHeaders) => jsonResponse({
    configured: false,
    alerts: [],
    historyCount24h: 0,
    timestamp: new Date().toISOString(),
    error: 'No data source available',
  }, 503, corsHeaders),
});

export default function handler(req) {
  if (req.method === 'GET' && !isDisallowedOrigin(req)) {
    const url = new URL(req.url);
    const canonicalSearch = url.searchParams.get('endpoint') === 'history' ? '?endpoint=history' : '';
    if (url.search !== canonicalSearch) {
      url.search = canonicalSearch;
      return new Response(null, {
        status: 308,
        headers: { ...getCorsHeaders(req, 'GET, OPTIONS'), Location: url.href, 'Cache-Control': 'private, no-store' },
      });
    }
  }
  return relayOref(req);
}
