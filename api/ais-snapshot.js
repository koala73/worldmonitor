import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  relayPath: '/ais/snapshot',
  timeout: 12000,
  requireApiKey: true,
  requireRateLimit: true,
  cacheHeaders: (ok) => ({
    'Cache-Control': ok
      ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=900'
      : 'public, max-age=10, s-maxage=30, stale-while-revalidate=120',
    ...(ok && { 'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600, stale-if-error=900' }),
  }),
});
