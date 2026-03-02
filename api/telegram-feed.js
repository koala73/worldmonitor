import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  buildRelayPath: (_req, url) => {
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const topic = (url.searchParams.get('topic') || '').trim();
    const channel = (url.searchParams.get('channel') || '').trim();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (topic) params.set('topic', topic);
    if (channel) params.set('channel', channel);
    return `/telegram/feed?${params}`;
  },
  forwardSearch: false,
  timeout: 25000,
  cacheHeaders: () => ({
    'Cache-Control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  }),
});
