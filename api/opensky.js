import { createRelayHandler } from './_relay.js';

export const config = { runtime: 'edge' };

export default createRelayHandler({
  relayPath: '/opensky',
  timeout: 20000,
  cacheHeaders: () => ({
    'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60, stale-if-error=300',
  }),
  extraHeaders: (response) => {
    const xCache = response.headers.get('x-cache');
    return xCache ? { 'X-Cache': xCache } : {};
  },
});
