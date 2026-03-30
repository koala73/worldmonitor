/**
 * Shared gateway logic for per-domain Vercel edge functions.
 *
 * Each domain edge function calls `createDomainGateway(routes)` to get a
 * request handler that applies CORS, API-key validation, rate limiting,
 * POST-to-GET compat, error boundary, and cache-tier headers.
 *
 * Splitting domains into separate edge functions means Vercel bundles only the
 * code for one domain per function, cutting cold-start cost by ~20×.
 */

import { createRouter, type RouteDescriptor } from './router';
import { getCorsHeaders, isDisallowedOrigin, isAllowedOrigin } from './cors';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../api/_api-key.js';
import { mapErrorToResponse } from './error-mapper';
import { checkRateLimit, checkEndpointRateLimit, hasEndpointRatePolicy } from './_shared/rate-limit';
import { drainResponseHeaders } from './_shared/response-headers';
import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';

export const serverOptions: ServerOptions = { onError: mapErrorToResponse };

// --- Edge cache tier definitions ---
// NOTE: This map is shared across all domain bundles (~3KB). Kept centralised for
// single-source-of-truth maintainability; the size is negligible vs handler code.

type CacheTier = 'fast' | 'medium' | 'slow' | 'slow-browser' | 'static' | 'daily' | 'no-store';

// Browser-only cache: no `public` or `s-maxage` so Cloudflare (which ignores
// Vary: Origin) does NOT cache these responses. CF sits in front of api.worldmonitor.app
// and would otherwise pin ACAO: worldmonitor.app on the cached response, breaking CORS
// for preview deployments. Vercel CDN caching is handled separately by CDN-Cache-Control.
const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'max-age=60, stale-while-revalidate=60, stale-if-error=600',
  medium: 'max-age=120, stale-while-revalidate=120, stale-if-error=900',
  slow: 'max-age=300, stale-while-revalidate=300, stale-if-error=3600',
  'slow-browser': 'max-age=300, stale-while-revalidate=60, stale-if-error=1800',
  static: 'max-age=600, stale-while-revalidate=600, stale-if-error=14400',
  daily: 'max-age=3600, stale-while-revalidate=7200, stale-if-error=172800',
  'no-store': 'no-store',
};

// Vercel CDN-specific cache TTLs — CDN-Cache-Control overrides Cache-Control for
// Vercel's own edge cache, so Vercel can still cache aggressively (and respects
// Vary: Origin correctly) while CF sees no public s-maxage and passes through.
const TIER_CDN_CACHE: Record<CacheTier, string | null> = {
  fast: 'public, s-maxage=600, stale-while-revalidate=300, stale-if-error=1200',
  medium: 'public, s-maxage=1200, stale-while-revalidate=600, stale-if-error=1800',
  slow: 'public, s-maxage=3600, stale-while-revalidate=900, stale-if-error=7200',
  'slow-browser': 'public, s-maxage=900, stale-while-revalidate=60, stale-if-error=1800',
  static: 'public, s-maxage=14400, stale-while-revalidate=3600, stale-if-error=28800',
  daily: 'public, s-maxage=86400, stale-while-revalidate=14400, stale-if-error=172800',
  'no-store': null,
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  '/api/maritime/v1/get-vessel-snapshot': 'no-store',

  '/api/market/v1/list-market-quotes': 'medium',
  '/api/market/v1/list-crypto-quotes': 'medium',
  '/api/market/v1/list-crypto-sectors': 'slow',
  '/api/market/v1/list-defi-tokens': 'slow',
  '/api/market/v1/list-ai-tokens': 'slow',
  '/api/market/v1/list-other-tokens': 'slow',
  '/api/market/v1/list-commodity-quotes': 'medium',
  '/api/market/v1/list-stablecoin-markets': 'medium',
  '/api/market/v1/get-sector-summary': 'medium',
  '/api/market/v1/get-fear-greed-index': 'slow',
  '/api/market/v1/list-gulf-quotes': 'medium',
  '/api/market/v1/analyze-stock': 'slow',
  '/api/market/v1/get-stock-analysis-history': 'medium',
  '/api/market/v1/backtest-stock': 'slow',
  '/api/market/v1/list-stored-stock-backtests': 'medium',
  '/api/infrastructure/v1/list-service-statuses': 'slow',
  '/api/seismology/v1/list-earthquakes': 'slow',
  '/api/infrastructure/v1/list-internet-outages': 'slow',
  '/api/infrastructure/v1/list-internet-ddos-attacks': 'slow',
  '/api/infrastructure/v1/list-internet-traffic-anomalies': 'slow',

  '/api/unrest/v1/list-unrest-events': 'slow',
  '/api/cyber/v1/list-cyber-threats': 'slow',
  '/api/conflict/v1/list-acled-events': 'slow',
  '/api/military/v1/get-theater-posture': 'slow',
  '/api/infrastructure/v1/get-temporal-baseline': 'slow',
  '/api/aviation/v1/list-airport-delays': 'static',
  '/api/aviation/v1/get-airport-ops-summary': 'static',
  '/api/aviation/v1/list-airport-flights': 'static',
  '/api/aviation/v1/get-carrier-ops': 'slow',
  '/api/aviation/v1/get-flight-status': 'fast',
  '/api/aviation/v1/track-aircraft': 'no-store',
  '/api/aviation/v1/search-flight-prices': 'medium',
  '/api/aviation/v1/search-google-flights': 'no-store',
  '/api/aviation/v1/search-google-dates': 'medium',
  '/api/aviation/v1/list-aviation-news': 'slow',
  '/api/market/v1/get-country-stock-index': 'slow',

  '/api/natural/v1/list-natural-events': 'slow',
  '/api/wildfire/v1/list-fire-detections': 'static',
  '/api/maritime/v1/list-navigational-warnings': 'static',
  '/api/supply-chain/v1/get-shipping-rates': 'static',
  '/api/economic/v1/get-fred-series': 'static',
  '/api/economic/v1/get-bls-series': 'daily',
  '/api/economic/v1/get-energy-prices': 'static',
  '/api/research/v1/list-arxiv-papers': 'static',
  '/api/research/v1/list-trending-repos': 'static',
  '/api/giving/v1/get-giving-summary': 'static',
  '/api/intelligence/v1/get-country-intel-brief': 'static',
  '/api/intelligence/v1/get-gdelt-topic-timeline': 'medium',
  '/api/climate/v1/list-climate-anomalies': 'static',
  '/api/climate/v1/list-climate-disasters': 'static',
  '/api/sanctions/v1/list-sanctions-pressure': 'static',
  '/api/sanctions/v1/lookup-sanction-entity': 'no-store',
  '/api/radiation/v1/list-radiation-observations': 'slow',
  '/api/thermal/v1/list-thermal-escalations': 'slow',
  '/api/research/v1/list-tech-events': 'static',
  '/api/military/v1/get-usni-fleet-report': 'static',
  '/api/military/v1/list-defense-patents': 'daily',
  '/api/conflict/v1/list-ucdp-events': 'static',
  '/api/conflict/v1/get-humanitarian-summary': 'static',
  '/api/conflict/v1/list-iran-events': 'slow',
  '/api/displacement/v1/get-displacement-summary': 'static',
  '/api/displacement/v1/get-population-exposure': 'static',
  '/api/economic/v1/get-bis-policy-rates': 'static',
  '/api/economic/v1/get-bis-exchange-rates': 'static',
  '/api/economic/v1/get-bis-credit': 'static',
  '/api/trade/v1/get-tariff-trends': 'static',
  '/api/trade/v1/get-trade-flows': 'static',
  '/api/trade/v1/get-trade-barriers': 'static',
  '/api/trade/v1/get-trade-restrictions': 'static',
  '/api/trade/v1/get-customs-revenue': 'static',
  '/api/trade/v1/list-comtrade-flows': 'static',
  '/api/economic/v1/list-world-bank-indicators': 'static',
  '/api/economic/v1/get-energy-capacity': 'static',
  '/api/economic/v1/list-grocery-basket-prices': 'static',
  '/api/economic/v1/list-bigmac-prices': 'static',
  '/api/economic/v1/list-fuel-prices': 'static',
  '/api/economic/v1/get-crude-inventories': 'static',
  '/api/economic/v1/get-nat-gas-storage': 'static',
  '/api/economic/v1/get-eu-yield-curve': 'daily',
  '/api/supply-chain/v1/get-critical-minerals': 'daily',
  '/api/military/v1/get-aircraft-details': 'static',
  '/api/military/v1/get-wingbits-status': 'static',
  '/api/military/v1/get-wingbits-live-flight': 'no-store',

  '/api/military/v1/list-military-flights': 'slow',
  '/api/market/v1/list-etf-flows': 'slow',
  '/api/research/v1/list-hackernews-items': 'slow',
  '/api/intelligence/v1/get-country-risk': 'slow',
  '/api/intelligence/v1/get-risk-scores': 'slow',
  '/api/intelligence/v1/get-pizzint-status': 'slow',
  '/api/intelligence/v1/classify-event': 'static',
  '/api/intelligence/v1/search-gdelt-documents': 'slow',
  '/api/infrastructure/v1/get-cable-health': 'slow',
  '/api/positive-events/v1/list-positive-geo-events': 'slow',

  '/api/military/v1/list-military-bases': 'static',
  '/api/economic/v1/get-macro-signals': 'medium',
  '/api/economic/v1/get-national-debt': 'daily',
  '/api/prediction/v1/list-prediction-markets': 'medium',
  '/api/forecast/v1/get-forecasts': 'medium',
  '/api/forecast/v1/get-simulation-package': 'slow',
  '/api/forecast/v1/get-simulation-outcome': 'slow',
  '/api/supply-chain/v1/get-chokepoint-status': 'medium',
  '/api/news/v1/list-feed-digest': 'slow',
  '/api/intelligence/v1/get-country-facts': 'daily',
  '/api/intelligence/v1/list-security-advisories': 'slow',
  '/api/intelligence/v1/list-satellites': 'slow',
  '/api/intelligence/v1/list-gps-interference': 'slow',
  '/api/intelligence/v1/list-cross-source-signals': 'medium',
  '/api/intelligence/v1/list-oref-alerts': 'fast',
  '/api/intelligence/v1/list-telegram-feed': 'fast',
  '/api/intelligence/v1/get-company-enrichment': 'slow',
  '/api/intelligence/v1/list-company-signals': 'slow',
  '/api/news/v1/summarize-article-cache': 'slow',

  '/api/imagery/v1/search-imagery': 'static',

  '/api/infrastructure/v1/list-temporal-anomalies': 'medium',
  '/api/infrastructure/v1/get-ip-geo': 'no-store',
  '/api/infrastructure/v1/reverse-geocode': 'slow',
  '/api/infrastructure/v1/get-bootstrap-data': 'no-store',
  '/api/webcam/v1/get-webcam-image': 'no-store',
  '/api/webcam/v1/list-webcams': 'no-store',

  '/api/consumer-prices/v1/get-consumer-price-overview': 'slow',
  '/api/consumer-prices/v1/get-consumer-price-basket-series': 'slow',
  '/api/consumer-prices/v1/list-consumer-price-categories': 'slow',
  '/api/consumer-prices/v1/list-consumer-price-movers': 'slow',
  '/api/consumer-prices/v1/list-retailer-price-spreads': 'slow',
  '/api/consumer-prices/v1/get-consumer-price-freshness': 'slow',

  '/api/aviation/v1/get-youtube-live-stream-info': 'fast',

  '/api/market/v1/list-earnings-calendar': 'slow',
  '/api/market/v1/get-cot-positioning': 'slow',
  '/api/economic/v1/get-economic-calendar': 'slow',
  '/api/intelligence/v1/list-market-implications': 'slow',
  '/api/economic/v1/get-ecb-fx-rates': 'slow',
  '/api/economic/v1/get-eurostat-country-data': 'slow',
  '/api/economic/v1/get-eu-gas-storage': 'slow',
  '/api/economic/v1/get-eu-fsi': 'slow',
  '/api/economic/v1/get-economic-stress': 'slow',
  '/api/supply-chain/v1/get-shipping-stress': 'medium',
  '/api/health/v1/list-disease-outbreaks': 'slow',
  '/api/intelligence/v1/get-social-velocity': 'fast',
};

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';

/**
 * Creates a Vercel Edge handler for a single domain's routes.
 *
 * Applies the full gateway pipeline: origin check → CORS → OPTIONS preflight →
 * API key → rate limit → route match (with POST→GET compat) → execute → cache headers.
 */
export function createDomainGateway(
  routes: RouteDescriptor[],
): (req: Request) => Promise<Response> {
  const router = createRouter(routes);

  return async function handler(originalRequest: Request): Promise<Response> {
    let request = originalRequest;
    const rawPathname = new URL(request.url).pathname;
    const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;

    // Origin check — skip CORS headers for disallowed origins
    if (isDisallowedOrigin(request)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corsHeaders: Record<string, string>;
    try {
      corsHeaders = getCorsHeaders(request);
    } catch {
      corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    }

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // API key validation
    const keyCheck = validateApiKey(request, {
      forceKey: PREMIUM_RPC_PATHS.has(pathname),
    });
    if (keyCheck.required && !keyCheck.valid) {
      if (PREMIUM_RPC_PATHS.has(pathname)) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          const { validateBearerToken } = await import('./auth-session');
          const session = await validateBearerToken(authHeader.slice(7));
          if (!session.valid) {
            return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          if (session.role !== 'pro') {
            return new Response(JSON.stringify({ error: 'Pro subscription required' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          // Valid pro session — fall through to route handling
        } else {
          return new Response(JSON.stringify({ error: keyCheck.error, _debug: (keyCheck as any)._debug }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } else {
        return new Response(JSON.stringify({ error: keyCheck.error }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // IP-based rate limiting — two-phase: endpoint-specific first, then global fallback
    const endpointRlResponse = await checkEndpointRateLimit(request, pathname, corsHeaders);
    if (endpointRlResponse) return endpointRlResponse;

    if (!hasEndpointRatePolicy(pathname)) {
      const rateLimitResponse = await checkRateLimit(request, corsHeaders);
      if (rateLimitResponse) return rateLimitResponse;
    }

    // Route matching — if POST doesn't match, convert to GET for stale clients
    let matchedHandler = router.match(request);
    if (!matchedHandler && request.method === 'POST') {
      const contentLen = parseInt(request.headers.get('Content-Length') ?? '0', 10);
      if (contentLen < 1_048_576) {
        const url = new URL(request.url);
        try {
          const body = await request.clone().json();
          const isScalar = (x: unknown): x is string | number | boolean =>
            typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
          for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
            if (Array.isArray(v)) v.forEach((item) => { if (isScalar(item)) url.searchParams.append(k, String(item)); });
            else if (isScalar(v)) url.searchParams.set(k, String(v));
          }
        } catch { /* non-JSON body — skip POST→GET conversion */ }
        const getReq = new Request(url.toString(), { method: 'GET', headers: request.headers });
        matchedHandler = router.match(getReq);
        if (matchedHandler) request = getReq;
      }
    }
    if (!matchedHandler) {
      const allowed = router.allowedMethods(new URL(request.url).pathname);
      if (allowed.length > 0) {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: allowed.join(', '), ...corsHeaders },
        });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Execute handler with top-level error boundary
    let response: Response;
    try {
      response = await matchedHandler(request);
    } catch (err) {
      console.error('[gateway] Unhandled handler error:', err);
      response = new Response(JSON.stringify({ message: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Merge CORS + handler side-channel headers into response
    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      mergedHeaders.set(key, value);
    }
    const extraHeaders = drainResponseHeaders(request);
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        mergedHeaders.set(key, value);
      }
    }

    // For GET 200 responses: read body once for cache-header decisions + ETag
    if (response.status === 200 && request.method === 'GET' && response.body) {
      const bodyBytes = await response.arrayBuffer();

      // Skip CDN caching for upstream-unavailable / empty responses so CF
      // doesn't serve stale error data for hours.
      const bodyStr = new TextDecoder().decode(bodyBytes);
      const isUpstreamUnavailable = bodyStr.includes('"upstreamUnavailable":true');

      if (mergedHeaders.get('X-No-Cache') || isUpstreamUnavailable) {
        mergedHeaders.set('Cache-Control', 'no-store');
        mergedHeaders.set('X-Cache-Tier', 'no-store');
      } else {
        const rpcName = pathname.split('/').pop() ?? '';
        const envOverride = process.env[`CACHE_TIER_OVERRIDE_${rpcName.replace(/-/g, '_').toUpperCase()}`] as CacheTier | undefined;
        const tier = (envOverride && envOverride in TIER_HEADERS ? envOverride : null) ?? RPC_CACHE_TIER[pathname] ?? 'medium';
        mergedHeaders.set('Cache-Control', TIER_HEADERS[tier]);
        // Only allow Vercel CDN caching for trusted origins (worldmonitor.app, Vercel previews,
        // Tauri). No-origin server-side requests (external scrapers) must always reach the edge
        // function so the auth check in validateApiKey() can run. Without this guard, a cached
        // 200 from a trusted-origin browser request could be served to a no-origin scraper,
        // bypassing auth entirely.
        const reqOrigin = request.headers.get('origin') || '';
        const cdnCache = isAllowedOrigin(reqOrigin) ? TIER_CDN_CACHE[tier] : null;
        if (cdnCache) mergedHeaders.set('CDN-Cache-Control', cdnCache);
        mergedHeaders.set('X-Cache-Tier', tier);

        // Keep per-origin ACAO (already set from corsHeaders above) and preserve Vary: Origin.
        // ACAO: * with no Vary would collapse all origins into one cache entry, bypassing
        // isDisallowedOrigin() for cache hits — Vercel CDN serves s-maxage responses without
        // re-invoking the function, so a disallowed origin could read a cached ACAO: * response.
      }
      mergedHeaders.delete('X-No-Cache');
      if (!new URL(request.url).searchParams.has('_debug')) {
        mergedHeaders.delete('X-Cache-Tier');
      }

      // FNV-1a inspired fast hash — good enough for cache validation
      let hash = 2166136261;
      const view = new Uint8Array(bodyBytes);
      for (let i = 0; i < view.length; i++) {
        hash ^= view[i]!;
        hash = Math.imul(hash, 16777619);
      }
      const etag = `"${(hash >>> 0).toString(36)}-${view.length.toString(36)}"`;
      mergedHeaders.set('ETag', etag);

      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers: mergedHeaders });
      }

      return new Response(bodyBytes, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders,
      });
    }

    if (response.status === 200 && request.method === 'GET') {
      if (mergedHeaders.get('X-No-Cache')) {
        mergedHeaders.set('Cache-Control', 'no-store');
      }
      mergedHeaders.delete('X-No-Cache');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  };
}
