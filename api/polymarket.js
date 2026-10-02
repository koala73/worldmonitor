import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  relayPath: '/polymarket',
  forwardSearch: false,
  buildRelayPath: (_req, url) => {
    const endpoint = url.searchParams.get('endpoint') === 'events' ? 'events' : 'markets';
    const order = url.searchParams.get('order');
    const params = new URLSearchParams({
      endpoint,
      closed: url.searchParams.get('closed') === 'true' ? 'true' : 'false',
      order: ['volume', 'liquidity', 'startDate', 'endDate', 'spread'].includes(order) ? order : 'volume',
      ascending: url.searchParams.get('ascending') === 'true' ? 'true' : 'false',
      limit: String(Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50))),
    });
    const tag = (url.searchParams.get('tag') || url.searchParams.get('tag_slug') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
    if (tag && endpoint === 'events') params.set('tag_slug', tag);
    return `/polymarket?${params}`;
  },
  timeout: 15000,
  requireApiKey: true,
  requireRateLimit: true,
  extraHeaders: response => response.headers.get('Cache-Control') === 'no-store'
    ? { 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' } : {},
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'private, max-age=120'
      : 'no-store',
    ...(!ok && { 'CDN-Cache-Control': 'no-store' }),
  }),
});
