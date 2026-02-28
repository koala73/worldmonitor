/**
 * Vercel edge function for sebuf RPC routes.
 *
 * Matches /api/{domain}/v1/{rpc} via Vercel dynamic segment routing.
 * CORS headers are applied to every response (200, 204, 403, 404).
 */

export const config = { runtime: 'edge' };

import { createRouter } from '../../../server/router';
import { getCorsHeaders, isDisallowedOrigin } from '../../../server/cors';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../_api-key.js';
import { mapErrorToResponse } from '../../../server/error-mapper';
import { checkRateLimit } from '../../../server/_shared/rate-limit';
import { drainResponseHeaders } from '../../../server/_shared/response-headers';
import { createSeismologyServiceRoutes } from '../../../src/generated/server/worldmonitor/seismology/v1/service_server';
import { seismologyHandler } from '../../../server/worldmonitor/seismology/v1/handler';
import { createWildfireServiceRoutes } from '../../../src/generated/server/worldmonitor/wildfire/v1/service_server';
import { wildfireHandler } from '../../../server/worldmonitor/wildfire/v1/handler';
import { createClimateServiceRoutes } from '../../../src/generated/server/worldmonitor/climate/v1/service_server';
import { climateHandler } from '../../../server/worldmonitor/climate/v1/handler';
import { createPredictionServiceRoutes } from '../../../src/generated/server/worldmonitor/prediction/v1/service_server';
import { predictionHandler } from '../../../server/worldmonitor/prediction/v1/handler';
import { createDisplacementServiceRoutes } from '../../../src/generated/server/worldmonitor/displacement/v1/service_server';
import { displacementHandler } from '../../../server/worldmonitor/displacement/v1/handler';
import { createAviationServiceRoutes } from '../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import { aviationHandler } from '../../../server/worldmonitor/aviation/v1/handler';
import { createResearchServiceRoutes } from '../../../src/generated/server/worldmonitor/research/v1/service_server';
import { researchHandler } from '../../../server/worldmonitor/research/v1/handler';
import { createUnrestServiceRoutes } from '../../../src/generated/server/worldmonitor/unrest/v1/service_server';
import { unrestHandler } from '../../../server/worldmonitor/unrest/v1/handler';
import { createConflictServiceRoutes } from '../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { conflictHandler } from '../../../server/worldmonitor/conflict/v1/handler';
import { createMaritimeServiceRoutes } from '../../../src/generated/server/worldmonitor/maritime/v1/service_server';
import { maritimeHandler } from '../../../server/worldmonitor/maritime/v1/handler';
import { createCyberServiceRoutes } from '../../../src/generated/server/worldmonitor/cyber/v1/service_server';
import { cyberHandler } from '../../../server/worldmonitor/cyber/v1/handler';
import { createEconomicServiceRoutes } from '../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { economicHandler } from '../../../server/worldmonitor/economic/v1/handler';
import { createInfrastructureServiceRoutes } from '../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { infrastructureHandler } from '../../../server/worldmonitor/infrastructure/v1/handler';
import { createMarketServiceRoutes } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { marketHandler } from '../../../server/worldmonitor/market/v1/handler';
import { createNewsServiceRoutes } from '../../../src/generated/server/worldmonitor/news/v1/service_server';
import { newsHandler } from '../../../server/worldmonitor/news/v1/handler';
import { createIntelligenceServiceRoutes } from '../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { intelligenceHandler } from '../../../server/worldmonitor/intelligence/v1/handler';
import { createMilitaryServiceRoutes } from '../../../src/generated/server/worldmonitor/military/v1/service_server';
import { militaryHandler } from '../../../server/worldmonitor/military/v1/handler';
import { createPositiveEventsServiceRoutes } from '../../../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { positiveEventsHandler } from '../../../server/worldmonitor/positive-events/v1/handler';
import { createGivingServiceRoutes } from '../../../src/generated/server/worldmonitor/giving/v1/service_server';
import { givingHandler } from '../../../server/worldmonitor/giving/v1/handler';
import { createTradeServiceRoutes } from '../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { tradeHandler } from '../../../server/worldmonitor/trade/v1/handler';
import { createSupplyChainServiceRoutes } from '../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { supplyChainHandler } from '../../../server/worldmonitor/supply-chain/v1/handler';

import type { ServerOptions } from '../../../src/generated/server/worldmonitor/seismology/v1/service_server';

// --- Edge cache tier definitions ---
type CacheTier = 'fast' | 'medium' | 'slow' | 'static' | 'no-store';

const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'public, s-maxage=120, stale-while-revalidate=30, stale-if-error=300',
  medium: 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
  slow: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=1800',
  static: 'public, s-maxage=3600, stale-while-revalidate=300, stale-if-error=7200',
  'no-store': 'no-store',
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  '/api/maritime/v1/get-vessel-snapshot': 'no-store',

  '/api/market/v1/list-market-quotes': 'fast',
  '/api/market/v1/list-crypto-quotes': 'fast',
  '/api/market/v1/list-commodity-quotes': 'fast',
  '/api/market/v1/list-stablecoin-markets': 'fast',
  '/api/market/v1/get-sector-summary': 'fast',
  '/api/infrastructure/v1/list-service-statuses': 'fast',
  '/api/seismology/v1/list-earthquakes': 'fast',
  '/api/infrastructure/v1/list-internet-outages': 'fast',

  '/api/unrest/v1/list-unrest-events': 'slow',
  '/api/cyber/v1/list-cyber-threats': 'slow',
  '/api/conflict/v1/list-acled-events': 'slow',
  '/api/military/v1/get-theater-posture': 'slow',
  '/api/infrastructure/v1/get-temporal-baseline': 'slow',
  '/api/aviation/v1/list-airport-delays': 'slow',
  '/api/market/v1/get-country-stock-index': 'slow',

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
  '/api/supply-chain/v1/get-critical-minerals': 'static',
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
};

const serverOptions: ServerOptions = { onError: mapErrorToResponse };

const allRoutes = [
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
  ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
  ...createCyberServiceRoutes(cyberHandler, serverOptions),
  ...createEconomicServiceRoutes(economicHandler, serverOptions),
  ...createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
  ...createMarketServiceRoutes(marketHandler, serverOptions),
  ...createNewsServiceRoutes(newsHandler, serverOptions),
  ...createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
  ...createMilitaryServiceRoutes(militaryHandler, serverOptions),
  ...createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
  ...createGivingServiceRoutes(givingHandler, serverOptions),
  ...createTradeServiceRoutes(tradeHandler, serverOptions),
  ...createSupplyChainServiceRoutes(supplyChainHandler, serverOptions),
];

const router = createRouter(allRoutes);

export default async function handler(originalRequest: Request): Promise<Response> {
  let request = originalRequest;
  // Origin check first — skip CORS headers for disallowed origins (M-2 fix)
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
  // that still send POST to endpoints converted in PR #468.
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
      } catch {}
      const getReq = new Request(url.toString(), { method: 'GET', headers: request.headers });
      matchedHandler = router.match(getReq);
      if (matchedHandler) request = getReq;
    }
  }
  if (!matchedHandler) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Execute handler with top-level error boundary (H-1 fix)
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
}
