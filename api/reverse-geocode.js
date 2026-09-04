import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { checkRateLimit } from './_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash, setCachedData } from './_upstash-json.js';
import { geocodeCacheKey } from './_geocode-cache-key.js';

export const config = { runtime: 'edge' };

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/reverse';
const CHROME_UA = 'WorldMonitor/2.0 (https://worldmonitor.app)';

// Mirrors ENDPOINT_RATE_POLICIES['/api/reverse-geocode'] in
// server/_shared/rate-limit.ts. api/*.js cannot import ../server/ (AGENTS.md),
// so the budget is duplicated here and tests/rate-limit.test.mts fails if the
// two copies drift. (#6234)
const RATE_LIMIT_SCOPE = 'reverse-geocode';
const RATE_LIMIT_PER_MINUTE = 60;
// Must match checkScopedRateLimit('reverse-geocode', ..., 'global') in the
// gateway RPC. checkRateLimit uses `rl:${scope}` as its Redis prefix, so the
// special `scope` namespace plus this identifier produces the same
// `rl:scope:reverse-geocode:global` bucket on both routes.
const PROVIDER_RATE_LIMIT_SCOPE = 'scope';
const PROVIDER_RATE_LIMIT_IDENTIFIER = 'reverse-geocode:global';
const PROVIDER_RATE_LIMIT_PER_SECOND = 1;

function normalizeCacheEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return {
    country: typeof entry.country === 'string' ? entry.country : '',
    code: typeof entry.code === 'string' ? entry.code : '',
    displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
    error: '',
  };
}

function getCacheKeyPrefix() {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const publicCors = getPublicCorsHeaders();

  // Metered before the coordinate validation so malformed requests are not a
  // free unlimited path. Availability-first on purpose: the map degrades to an
  // unlabelled country rather than failing, and checkRateLimit already returns
  // null when Upstash is unconfigured. `ctx` is forwarded so the degraded-path
  // Sentry envelope survives isolate teardown. (#6234)
  const limited = await checkRateLimit(req, cors, {
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: '60 s',
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');

  const latN = Number(lat);
  const lonN = Number(lon);
  if (!lat || !lon || Number.isNaN(latN) || Number.isNaN(lonN)
      || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
    return jsonResponse({ error: 'valid lat (-90..90) and lon (-180..180) required' }, 400, cors);
  }

  const cacheKey = `${getCacheKeyPrefix()}${geocodeCacheKey(latN, lonN)}`;

  const cached = normalizeCacheEntry(await readJsonFromUpstash(cacheKey, 1500));
  if (cached) {
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: {
        ...publicCors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    });
  }

  // Nominatim permits at most one request per second for the application as a
  // whole. Apply this only after the shared cache misses so cached traffic is
  // free, and fail closed because a Redis outage must not turn both routes
  // into unbounded provider passthrough.
  const providerLimited = await checkRateLimit(req, cors, {
    ctx,
    scope: PROVIDER_RATE_LIMIT_SCOPE,
    identifier: PROVIDER_RATE_LIMIT_IDENTIFIER,
    limit: PROVIDER_RATE_LIMIT_PER_SECOND,
    window: '1 s',
    failClosed: true,
  });
  if (providerLimited) return providerLimited;

  try {
    const resp = await fetch(
      `${NOMINATIM_BASE}?lat=${latN}&lon=${lonN}&format=json&zoom=3&accept-language=en`,
      {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!resp.ok) {
      return jsonResponse({ error: `Nominatim ${resp.status}` }, 502, cors);
    }

    const data = await resp.json();
    const country = data.address?.country || '';
    const code = (data.address?.country_code || '').toUpperCase();
    const displayName = data.display_name || country || '';

    // Write unconditionally, matching the gateway RPC
    // (server/worldmonitor/infrastructure/v1/reverse-geocode.ts): ocean and
    // Antarctic cells must populate the shared geocode: cache, and a sweep of
    // those cells is currently 100% Nominatim passthrough. The entry uses the
    // RPC's exact shape ({country, code, displayName, error} as strings) —
    // both handlers read the same deployment-scoped 0.001-degree grid namespace
    // (`geocode:lat,lon`, 604800 s TTL), so either may serve the other and a
    // normalized `''` is indistinguishable from an ocean lookup either way.
    // (#6432)
    const result = { country, code, displayName, error: '' };
    const body = JSON.stringify(result);

    ctx.waitUntil(setCachedData(cacheKey, result, 604800));

    return new Response(body, {
      status: 200,
      headers: {
        ...publicCors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'Nominatim request failed' }, 502, cors);
  }
}
