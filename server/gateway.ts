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
import { getCorsHeaders, isDisallowedOrigin } from './cors';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../api/_api-key.js';
import { mapErrorToResponse } from './error-mapper';
import { checkRateLimit } from './_shared/rate-limit';
import { drainResponseHeaders } from './_shared/response-headers';
import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';

export const serverOptions: ServerOptions = { onError: mapErrorToResponse };

// --- Edge cache tier definitions ---
// NOTE: This map is shared across all domain bundles (~3KB). Kept centralised for
// single-source-of-truth maintainability; the size is negligible vs handler code.

type CacheTier = 'fast' | 'medium' | 'slow' | 'static' | 'daily' | 'no-store';

const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'public, s-maxage=120, stale-while-revalidate=30, stale-if-error=300',
  medium: 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
  slow: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=1800',
  static: 'public, s-maxage=3600, stale-while-revalidate=300, stale-if-error=7200',
  daily: 'public, s-maxage=86400, stale-while-revalidate=3600, stale-if-error=172800',
  'no-store': 'no-store',
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  '/api/maritime/v1/get-vessel-snapshot': 'no-store',

  '/api/market/v1/list-market-quotes': 'medium',
  '/api/market/v1/list-crypto-quotes': 'medium',
  '/api/market/v1/list-commodity-quotes': 'medium',
  '/api/market/v1/list-stablecoin-markets': 'medium',
  '/api/market/v1/get-sector-summary': 'medium',
  '/api/market/v1/list-gulf-quotes': 'medium',
  '/api/infrastructure/v1/list-service-statuses': 'slow',
  '/api/seismology/v1/list-earthquakes': 'slow',
  '/api/infrastructure/v1/list-internet-outages': 'slow',

  '/api/unrest/v1/list-unrest-events': 'slow',
  '/api/cyber/v1/list-cyber-threats': 'slow',
  '/api/conflict/v1/list-acled-events': 'slow',
  '/api/military/v1/get-theater-posture': 'slow',
  '/api/infrastructure/v1/get-temporal-baseline': 'slow',
  '/api/aviation/v1/list-airport-delays': 'static',
  '/api/market/v1/get-country-stock-index': 'slow',

  '/api/natural/v1/list-natural-events': 'slow',
  '/api/wildfire/v1/list-fire-detections': 'static',
  '/api/maritime/v1/list-navigational-warnings': 'static',
  '/api/supply-chain/v1/get-shipping-rates': 'static',
  '/api/economic/v1/get-fred-series': 'static',
  '/api/economic/v1/get-energy-prices': 'static',
  '/api/research/v1/list-arxiv-papers': 'static',
  '/api/research/v1/list-trending-repos': 'static',
  '/api/giving/v1/get-giving-summary': 'static',
  '/api/intelligence/v1/get-country-intel-brief': 'static',
  '/api/climate/v1/list-climate-anomalies': 'static',
  '/api/research/v1/list-tech-events': 'static',
  '/api/military/v1/get-usni-fleet-report': 'static',
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
  '/api/economic/v1/list-world-bank-indicators': 'static',
  '/api/economic/v1/get-energy-capacity': 'static',
  '/api/supply-chain/v1/get-critical-minerals': 'daily',
  '/api/military/v1/get-aircraft-details': 'static',
  '/api/military/v1/get-wingbits-status': 'static',

  '/api/military/v1/list-military-flights': 'slow',
  '/api/market/v1/list-etf-flows': 'slow',
  '/api/research/v1/list-hackernews-items': 'slow',
  '/api/intelligence/v1/get-risk-scores': 'slow',
  '/api/intelligence/v1/get-pizzint-status': 'slow',
  '/api/intelligence/v1/search-gdelt-documents': 'slow',
  '/api/infrastructure/v1/get-cable-health': 'slow',
  '/api/positive-events/v1/list-positive-geo-events': 'slow',

  '/api/military/v1/list-military-bases': 'static',
  '/api/economic/v1/get-macro-signals': 'medium',
  '/api/prediction/v1/list-prediction-markets': 'medium',
  '/api/supply-chain/v1/get-chokepoint-status': 'medium',
  '/api/news/v1/list-feed-digest': 'slow',
  '/api/intelligence/v1/classify-event': 'static',
  '/api/news/v1/summarize-article-cache': 'slow',
};

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

    // API key validation (origin-aware)
    const keyCheck = validateApiKey(request);
    if (keyCheck.required && !keyCheck.valid) {
      return new Response(JSON.stringify({ error: keyCheck.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // IP-based rate limiting (60 req/min sliding window)
    const rateLimitResponse = await checkRateLimit(request, corsHeaders);
    if (rateLimitResponse) return rateLimitResponse;

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

    if (response.status === 200 && request.method === 'GET' && !mergedHeaders.has('Cache-Control')) {
      if (mergedHeaders.get('X-No-Cache')) {
        mergedHeaders.set('Cache-Control', 'no-store');
        mergedHeaders.set('X-Cache-Tier', 'no-store');
      } else {
        const pathname = new URL(request.url).pathname;
        const rpcName = pathname.split('/').pop() ?? '';
        const envOverride = process.env[`CACHE_TIER_OVERRIDE_${rpcName.replace(/-/g, '_').toUpperCase()}`] as CacheTier | undefined;
        const tier = (envOverride && envOverride in TIER_HEADERS ? envOverride : null) ?? RPC_CACHE_TIER[pathname] ?? 'medium';
        mergedHeaders.set('Cache-Control', TIER_HEADERS[tier]);
        mergedHeaders.set('X-Cache-Tier', tier);
      }
    }
    mergedHeaders.delete('X-No-Cache');
    if (!new URL(request.url).searchParams.has('_debug')) {
      mergedHeaders.delete('X-Cache-Tier');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  };
}
