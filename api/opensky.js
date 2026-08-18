import { createRelayHandler } from './_relay.js';
import { getHeaderApiKey, isDesktopOrigin, validateApiKey } from './_api-key.js';
import { getCorsHeaders } from './_cors.js';
import { timingSafeIncludes } from './_crypto.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const relayHandler = createRelayHandler({
  relayPath: '/opensky',
  timeout: 20000,
  // Product access is checked before the generic relay. Keeping this false is
  // intentional: the authenticated local sidecar validates against its own
  // WORLDMONITOR_API_KEY, which is not present in the sidecar's cloud allowlist.
  requireApiKey: false,
  cacheHeaders: () => ({
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
  }),
  extraHeaders: (response) => {
    const xCache = response.headers.get('x-cache');
    return xCache ? { 'X-Cache': xCache } : {};
  },
});

const LOCAL_SIDECAR_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const CANONICAL_PRODUCT_ORIGIN = 'https://worldmonitor.app';

function isAuthenticatedSidecarHop(origin) {
  return (process.env.LOCAL_API_MODE || '').includes('sidecar')
    && LOCAL_SIDECAR_ORIGIN.test(origin);
}

async function hasProductAccess(req, origin) {
  if (isAuthenticatedSidecarHop(origin)) {
    const localProductKey = process.env.WORLDMONITOR_API_KEY || '';
    return timingSafeIncludes(getHeaderApiKey(req), localProductKey ? [localProductKey] : []);
  }

  if (!isDesktopOrigin(origin) && origin !== CANONICAL_PRODUCT_ORIGIN) return false;
  const auth = await validateApiKey(req, { forceKey: true });
  return auth.valid && auth.kind === 'enterprise';
}

function noStore(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  return response;
}

export default async function handler(req) {
  const origin = req.headers.get('Origin') || '';
  if (!await hasProductAccess(req, origin)) {
    return noStore(jsonResponse({ error: 'Not found' }, 404, getCorsHeaders(req, 'GET, OPTIONS')));
  }

  // `_cors.js` intentionally rejects production loopback Origins. The local
  // sidecar already authenticated the native transport and replaced the
  // renderer Origin, so normalize only this trusted hop before relay CORS.
  let relayRequest = req;
  if (isAuthenticatedSidecarHop(origin)) {
    const headers = new Headers(req.headers);
    headers.set('Origin', 'tauri://localhost');
    relayRequest = new Request(req, { headers });
  }
  return noStore(await relayHandler(relayRequest));
}
