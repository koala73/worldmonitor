import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
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
  fallback: (_req, corsHeaders) => new Response(JSON.stringify({
    configured: false,
    alerts: [],
    historyCount24h: 0,
    timestamp: new Date().toISOString(),
    error: 'No data source available',
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  }),
});
