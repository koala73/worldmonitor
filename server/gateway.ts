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
import { checkEntitlement, getRequiredTier, getEntitlements } from './_shared/entitlement-check';
import { resolveClerkSession } from './_shared/auth-session';
import {
  INTERNAL_MCP_SIG_HEADER,
  INTERNAL_MCP_USER_ID_HEADER,
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
  verifyInternalMcpRequest,
} from './_shared/mcp-internal-hmac';
import { buildUsageIdentity, type UsageIdentityInput } from './_shared/usage-identity';
import {
  deliverUsageEvents,
  buildRequestEvent,
  deriveRequestId,
  deriveExecutionRegion,
  deriveCountry,
  deriveIpCity,
  deriveIpRegion,
  deriveReqBytes,
  deriveSentryTraceId,
  deriveOriginKind,
  deriveUaHash,
  deriveIp,
  deriveUserAgent,
  deriveReferer,
  deriveAcceptLanguage,
  deriveHost,
  maybeAttachDevHealthHeader,
  runWithUsageScope,
  type CacheTier as UsageCacheTier,
  type RequestReason,
} from './_shared/usage';
import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';

export const serverOptions: ServerOptions = { onError: mapErrorToResponse };

/**
 * Internal-MCP request body size cap (256 KB). Internal-MCP fetches
 * carry small JSON-RPC params; this ceiling prevents the gateway from
 * buffering arbitrarily large bodies on the strip / HMAC-verify paths.
 *
 * Applied at:
 *   - The trust-marker strip block (any Pro-marked inbound request)
 *   - The HMAC-verify block (signed internal-MCP requests)
 *
 * Both Content-Length AND post-buffer byte count are checked because
 * Content-Length can be absent / wrong for chunked or streamed bodies.
 *
 * F8 (U7+U8 review pass).
 */
const MAX_INTERNAL_MCP_BODY = 256 * 1024;

// --- Edge cache tier definitions ---
// NOTE: This map is shared across all domain bundles (~3KB). Kept centralised for
// single-source-of-truth maintainability; the size is negligible vs handler code.

type CacheTier = 'fast' | 'medium' | 'slow' | 'slow-browser' | 'static' | 'daily' | 'no-store' | 'live';

// Three-tier caching: browser (max-age) → CF edge (s-maxage) → Vercel CDN (CDN-Cache-Control).
// CF ignores Vary: Origin so it may pin a single ACAO value, but this is acceptable
// since production traffic is same-origin and preview deployments hit Vercel CDN directly.
//
// 'live' tier (60s) is for endpoints with strict freshness contracts — the
// energy-atlas live-tanker map layer requires position fixes to refresh on
// the order of one minute. Every shorter-than-medium tier is custom; we keep
// the existing tiers untouched so unrelated endpoints aren't impacted.
const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
  medium: 'public, max-age=120, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  slow: 'public, max-age=300, s-maxage=1800, stale-while-revalidate=300, stale-if-error=3600',
  'slow-browser': 'max-age=300, stale-while-revalidate=60, stale-if-error=1800',
  static: 'public, max-age=600, s-maxage=3600, stale-while-revalidate=600, stale-if-error=14400',
  daily: 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=7200, stale-if-error=172800',
  'no-store': 'no-store',
  live: 'public, max-age=30, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
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
  live: 'public, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  // 'live' tier — bbox-quantized + tanker-aware caching upstream of the
  // 60s in-handler cache, absorbing identical-bbox requests at the CDN
  // before they hit this Vercel function. Energy Atlas live-tanker layer.
  '/api/maritime/v1/get-vessel-snapshot': 'live',

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
  '/api/market/v1/get-market-breadth-history': 'daily',
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
  '/api/cyber/v1/list-cyber-threats': 'static',
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
  '/api/supply-chain/v1/get-shipping-rates': 'daily',
  '/api/supply-chain/v1/list-pipelines': 'static',
  '/api/supply-chain/v1/get-pipeline-detail': 'static',
  '/api/supply-chain/v1/list-storage-facilities': 'static',
  '/api/supply-chain/v1/get-storage-facility-detail': 'static',
  '/api/supply-chain/v1/list-fuel-shortages': 'medium',
  '/api/supply-chain/v1/get-fuel-shortage-detail': 'medium',
  '/api/supply-chain/v1/list-energy-disruptions': 'medium',
  '/api/economic/v1/get-fred-series': 'static',
  '/api/economic/v1/get-bls-series': 'daily',
  '/api/economic/v1/get-energy-prices': 'static',
  '/api/research/v1/list-arxiv-papers': 'static',
  '/api/research/v1/list-trending-repos': 'static',
  '/api/giving/v1/get-giving-summary': 'static',
  '/api/intelligence/v1/get-country-intel-brief': 'static',
  '/api/intelligence/v1/get-gdelt-topic-timeline': 'medium',
  '/api/climate/v1/list-climate-anomalies': 'daily',
  '/api/climate/v1/list-climate-disasters': 'daily',
  '/api/climate/v1/get-co2-monitoring': 'daily',
  '/api/climate/v1/get-ocean-ice-data': 'daily',
  '/api/climate/v1/list-air-quality-data': 'fast',
  '/api/climate/v1/list-climate-news': 'slow',
  '/api/sanctions/v1/list-sanctions-pressure': 'daily',
  '/api/sanctions/v1/lookup-sanction-entity': 'no-store',
  '/api/radiation/v1/list-radiation-observations': 'slow',
  '/api/thermal/v1/list-thermal-escalations': 'slow',
  '/api/research/v1/list-tech-events': 'daily',
  '/api/military/v1/get-usni-fleet-report': 'daily',
  '/api/military/v1/list-defense-patents': 'daily',
  '/api/conflict/v1/list-ucdp-events': 'daily',
  '/api/conflict/v1/get-humanitarian-summary': 'daily',
  '/api/conflict/v1/list-iran-events': 'slow',
  '/api/displacement/v1/get-displacement-summary': 'daily',
  '/api/displacement/v1/get-population-exposure': 'daily',
  '/api/economic/v1/get-bis-policy-rates': 'daily',
  '/api/economic/v1/get-bis-exchange-rates': 'daily',
  '/api/economic/v1/get-bis-credit': 'daily',
  '/api/trade/v1/get-tariff-trends': 'daily',
  '/api/trade/v1/get-trade-flows': 'daily',
  '/api/trade/v1/get-trade-barriers': 'daily',
  '/api/trade/v1/get-trade-restrictions': 'daily',
  '/api/trade/v1/get-customs-revenue': 'daily',
  '/api/trade/v1/list-comtrade-flows': 'daily',
  '/api/economic/v1/list-world-bank-indicators': 'daily',
  '/api/economic/v1/get-energy-capacity': 'daily',
  '/api/economic/v1/list-grocery-basket-prices': 'daily',
  '/api/economic/v1/list-bigmac-prices': 'daily',
  '/api/economic/v1/list-fuel-prices': 'daily',
  '/api/economic/v1/get-fao-food-price-index': 'daily',
  '/api/economic/v1/get-crude-inventories': 'daily',
  '/api/economic/v1/get-nat-gas-storage': 'daily',
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

  '/api/military/v1/list-military-bases': 'daily',
  '/api/economic/v1/get-macro-signals': 'medium',
  '/api/economic/v1/get-national-debt': 'daily',
  '/api/prediction/v1/list-prediction-markets': 'medium',
  '/api/forecast/v1/get-forecasts': 'medium',
  '/api/forecast/v1/get-simulation-package': 'slow',
  '/api/forecast/v1/get-simulation-outcome': 'slow',
  '/api/supply-chain/v1/get-chokepoint-status': 'medium',
  '/api/supply-chain/v1/get-chokepoint-history': 'slow',
  '/api/news/v1/list-feed-digest': 'slow',
  '/api/intelligence/v1/get-country-facts': 'daily',
  '/api/intelligence/v1/list-security-advisories': 'slow',
  '/api/intelligence/v1/list-satellites': 'static',
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
  '/api/market/v1/get-gold-intelligence': 'slow',
  '/api/market/v1/get-hyperliquid-flow': 'medium',
  '/api/market/v1/get-insider-transactions': 'slow',
  '/api/economic/v1/get-economic-calendar': 'slow',
  '/api/intelligence/v1/list-market-implications': 'slow',
  '/api/economic/v1/get-ecb-fx-rates': 'slow',
  '/api/economic/v1/get-eurostat-country-data': 'slow',
  '/api/economic/v1/get-eu-gas-storage': 'slow',
  '/api/economic/v1/get-oil-stocks-analysis': 'static',
  '/api/economic/v1/get-oil-inventories': 'slow',
  '/api/economic/v1/get-energy-crisis-policies': 'static',
  '/api/economic/v1/get-eu-fsi': 'slow',
  '/api/economic/v1/get-economic-stress': 'slow',
  '/api/supply-chain/v1/get-shipping-stress': 'medium',
  '/api/supply-chain/v1/get-country-chokepoint-index': 'slow-browser',
  '/api/supply-chain/v1/get-bypass-options': 'slow-browser',
  '/api/supply-chain/v1/get-country-cost-shock': 'slow-browser',
  '/api/supply-chain/v1/get-country-products': 'slow-browser',
  '/api/supply-chain/v1/get-multi-sector-cost-shock': 'slow-browser',
  '/api/supply-chain/v1/get-sector-dependency': 'slow-browser',
  '/api/supply-chain/v1/get-route-explorer-lane': 'slow-browser',
  '/api/supply-chain/v1/get-route-impact': 'slow-browser',
  // Scenario engine: list-scenario-templates is a compile-time constant catalog;
  // daily tier gives browser max-age=3600 matching the legacy /api/scenario/v1/templates
  // endpoint header. get-scenario-status is premium-gated — gateway short-circuits
  // to 'slow-browser' but the entry is still required by tests/route-cache-tier.test.mjs.
  '/api/scenario/v1/list-scenario-templates': 'daily',
  '/api/scenario/v1/get-scenario-status': 'slow-browser',
  '/api/health/v1/list-disease-outbreaks': 'slow',
  '/api/health/v1/list-air-quality-alerts': 'fast',
  '/api/intelligence/v1/get-social-velocity': 'fast',
  '/api/intelligence/v1/get-country-energy-profile': 'slow',
  '/api/intelligence/v1/compute-energy-shock': 'fast',
  '/api/intelligence/v1/get-country-port-activity': 'slow',
  // NOTE: get-regional-snapshot is premium-gated via PREMIUM_RPC_PATHS; the
  // gateway short-circuits to 'slow-browser' before consulting this map. The
  // entry below exists to satisfy the parity contract enforced by
  // tests/route-cache-tier.test.mjs (every generated GET route needs a tier)
  // and documents the intended tier if the endpoint ever becomes non-premium.
  '/api/intelligence/v1/get-regional-snapshot': 'slow',
  // get-regime-history is premium-gated same as get-regional-snapshot; this
  // entry is required by tests/route-cache-tier.test.mjs even though the
  // gateway short-circuits premium paths to slow-browser.
  '/api/intelligence/v1/get-regime-history': 'slow',
  // get-regional-brief is premium-gated; slow-browser in practice, slow entry for route-parity.
  '/api/intelligence/v1/get-regional-brief': 'slow',
  '/api/resilience/v1/get-resilience-score': 'slow',
  '/api/resilience/v1/get-resilience-ranking': 'slow',

  // Partner-facing shipping/v2. route-intelligence is premium-gated; gateway
  // short-circuits to slow-browser. Entry required by tests/route-cache-tier.test.mjs.
  '/api/v2/shipping/route-intelligence': 'slow-browser',
  // GET /webhooks lists caller's webhooks — premium-gated; short-circuited to
  // slow-browser. Entry required by tests/route-cache-tier.test.mjs.
  '/api/v2/shipping/webhooks': 'slow-browser',
};

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';

/**
 * Creates a Vercel Edge handler for a single domain's routes.
 *
 * Applies the full gateway pipeline: origin check → CORS → OPTIONS preflight →
 * API key → rate limit → route match (with POST→GET compat) → execute → cache headers.
 */
export type GatewayCtx = { waitUntil: (p: Promise<unknown>) => void };

export function createDomainGateway(
  routes: RouteDescriptor[],
): (req: Request, ctx?: GatewayCtx) => Promise<Response> {
  const router = createRouter(routes);

  return async function handler(originalRequest: Request, ctx?: GatewayCtx): Promise<Response> {
    let request = originalRequest;
    const rawPathname = new URL(request.url).pathname;
    const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;
    const t0 = Date.now();

    // Usage-telemetry identity inputs — accumulated as gateway auth resolution progresses.
    // Read at every return point; null/0 defaults are valid for early returns.
    //
    // x-widget-key is intentionally NOT trusted here: a header is attacker-
    // controllable, and emitting it as `customer_id` would let unauthenticated
    // callers poison per-customer dashboards (per koala #3403 review). We only
    // populate `widgetKey` after validating it against the configured
    // WIDGET_AGENT_KEY — same check used in api/widget-agent.ts.
    const rawWidgetKey = request.headers.get('x-widget-key') ?? null;
    const widgetAgentKey = process.env.WIDGET_AGENT_KEY ?? '';
    const validatedWidgetKey =
      rawWidgetKey && widgetAgentKey && rawWidgetKey === widgetAgentKey ? rawWidgetKey : null;
    const usage: UsageIdentityInput = {
      sessionUserId: null,
      isUserApiKey: false,
      enterpriseApiKey: null,
      widgetKey: validatedWidgetKey,
      clerkOrgId: null,
      userApiKeyCustomerRef: null,
      tier: null,
    };
    // Domain segment for telemetry. Path layouts:
    //   /api/<domain>/v1/<rpc>          → parts[2] = domain
    //   /api/v2/<domain>/<rpc>          → parts[2] = "v2", parts[3] = domain
    const _parts = pathname.split('/');
    const domain = (/^v\d+$/.test(_parts[2] ?? '') ? _parts[3] : _parts[2]) ?? '';
    const reqBytes = deriveReqBytes(request);

    function emitRequest(status: number, reason: RequestReason, cacheTier: UsageCacheTier | null, resBytes = 0): void {
      if (!ctx?.waitUntil) return;
      const identity = buildUsageIdentity(usage);
      // Single ctx.waitUntil() registered synchronously in the request phase.
      // The IIFE awaits ua_hash (SHA-256) then awaits delivery directly via
      // deliverUsageEvents — no nested waitUntil call, which Edge runtimes
      // (Cloudflare/Vercel) may drop after the response phase ends.
      ctx.waitUntil((async () => {
        const uaHash = await deriveUaHash(originalRequest);
        await deliverUsageEvents([
          buildRequestEvent({
            requestId: deriveRequestId(originalRequest),
            domain,
            route: pathname,
            method: originalRequest.method,
            status,
            durationMs: Date.now() - t0,
            reqBytes,
            resBytes,
            customerId: identity.customer_id,
            principalId: identity.principal_id,
            authKind: identity.auth_kind,
            tier: identity.tier,
            country: deriveCountry(originalRequest),
            ipCity: deriveIpCity(originalRequest),
            ipRegion: deriveIpRegion(originalRequest),
            executionRegion: deriveExecutionRegion(originalRequest),
            executionPlane: 'vercel-edge',
            originKind: deriveOriginKind(originalRequest),
            cacheTier,
            ip: deriveIp(originalRequest),
            userAgent: deriveUserAgent(originalRequest),
            uaHash,
            referer: deriveReferer(originalRequest),
            acceptLanguage: deriveAcceptLanguage(originalRequest),
            host: deriveHost(originalRequest),
            sentryTraceId: deriveSentryTraceId(originalRequest),
            reason,
          }),
        ]);
      })());
    }

    // Origin check — skip CORS headers for disallowed origins
    if (isDisallowedOrigin(request)) {
      emitRequest(403, 'origin_403', null);
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
      emitRequest(204, 'preflight', null);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ----------------------------------------------------------------------
    // Defense-in-depth: strip client-controlled copies of the trusted
    // internal-MCP markers BEFORE any other logic runs. The gateway is the
    // ONLY layer permitted to set `x-wm-mcp-internal-verified` /
    // `x-user-id` (the latter is also set by the Clerk-session block
    // below from a verified bearer). Without the strip step, an attacker
    // who sends `x-wm-mcp-internal-verified: 1` from outside could spoof
    // premium context to any handler that reads these markers via
    // `isCallerPremium`. The strip MUST run regardless of whether the
    // X-WM-MCP-Internal header is present, so that the legacy
    // `validateApiKey` path also receives a sanitised request.
    //
    // Mutation invariant: every subsequent request reconstruction in this
    // function must build from the (already-stripped) `request`, not from
    // `originalRequest`.
    // ----------------------------------------------------------------------
    {
      const inboundHeaders = request.headers;
      if (
        inboundHeaders.has(INTERNAL_MCP_VERIFIED_HEADER) ||
        inboundHeaders.has(TRUSTED_USER_ID_HEADER)
      ) {
        const stripped = new Headers(inboundHeaders);
        stripped.delete(INTERNAL_MCP_VERIFIED_HEADER);
        stripped.delete(TRUSTED_USER_ID_HEADER);
        // For GET/HEAD: no body to forward. For other methods: buffer the
        // body bytes and pass them to the new Request — `body: request.body`
        // (a ReadableStream) requires `duplex: 'half'` in Node's undici
        // Request constructor, and the cleaner cross-runtime approach is
        // to forward bytes. Internal-MCP payloads are small JSON RPC params.
        //
        // F8: cap the buffered body at MAX_INTERNAL_MCP_BODY (256 KB).
        // Internal-MCP and gateway-bypass-strip paths only carry small
        // JSON-RPC params; 256 KB is a safe ceiling that prevents an
        // attacker from forcing the gateway to allocate megabytes of
        // memory just by setting Content-Length on a forged request.
        const reInit: RequestInit = { method: request.method, headers: stripped };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const contentLen = parseInt(request.headers.get('Content-Length') ?? '0', 10);
          if (Number.isFinite(contentLen) && contentLen > MAX_INTERNAL_MCP_BODY) {
            // F14: distinct reason label for body-size rejections so
            // telemetry separates this class from auth-401s.
            emitRequest(413, 'malformed_request', null);
            return new Response(JSON.stringify({ error: 'payload_too_large' }), {
              status: 413,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          try {
            const bytes = await request.clone().arrayBuffer();
            // Defense-in-depth: also reject if the actual buffered byte
            // count exceeds the cap (Content-Length can be absent or
            // wrong on chunked / streamed bodies).
            if (bytes.byteLength > MAX_INTERNAL_MCP_BODY) {
              emitRequest(413, 'malformed_request', null);
              return new Response(JSON.stringify({ error: 'payload_too_large' }), {
                status: 413,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
            reInit.body = bytes;
          } catch {
            // If we can't buffer the body, we can't safely forward the
            // request without trust-markers stripped. 400 the caller.
            // F14: use a distinct telemetry reason — "auth_401" was
            // misleading (this is a body-buffer failure, not an auth
            // outcome).
            emitRequest(400, 'malformed_request', null);
            return new Response(JSON.stringify({ error: 'malformed_request' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
        }
        request = new Request(request.url, reInit);
      }
    }

    // ----------------------------------------------------------------------
    // Internal-MCP HMAC pre-check — runs BEFORE `validateApiKey` so that a
    // verified Pro tool fetch never needs an `X-WorldMonitor-Key`. If
    // `X-WM-MCP-Internal` is present, treat as a deliberate signed request:
    //   - verify ⇒ entitlement re-check ⇒ rebuild Request with trusted markers
    //   - verify FAILS ⇒ 401 immediately (do NOT fall through; present-but-
    //     invalid is a forge attempt, falling through to validateApiKey
    //     would let an attacker chain the legacy auth path).
    // If the header is absent, fall through to the existing validateApiKey
    // path with the (header-stripped) request — Starter+ wm_ keys remain
    // unchanged.
    //
    // When this flag is true, downstream auth gates (validateApiKey, the
    // PREMIUM_RPC_PATHS bearer gate, IP rate limiting) are skipped. The MCP
    // edge already enforced 50/day + 60/min/userId; the gateway-level
    // entitlement check for ENDPOINT_ENTITLEMENTS is also skipped here
    // because we re-checked tier ≥ 1 + mcpAccess === true above.
    // ----------------------------------------------------------------------
    let internalMcpVerified = false;
    if (request.headers.has(INTERNAL_MCP_SIG_HEADER)) {
      const hmacSecret = process.env.MCP_INTERNAL_HMAC_SECRET ?? '';
      if (!hmacSecret) {
        // Server misconfiguration on the HMAC-attempt path. Surface as 500
        // CONFIGURATION so operators see it; legacy wm_ key path is
        // unaffected because we only enter this branch when the caller
        // explicitly tried to use the internal-MCP route.
        emitRequest(500, 'auth_401', null);
        return new Response(
          JSON.stringify({ error: 'CONFIGURATION', detail: 'MCP_INTERNAL_HMAC_SECRET not configured' }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      // Read the body bytes ONCE upfront. We need them in three places:
      //   1. Inside verifyInternalMcpRequest for the bodyHash compare
      //   2. To rebuild a fresh Request with trusted markers (Node's undici
      //      Request constructor refuses a ReadableStream body without
      //      `duplex: 'half'`; passing bytes sidesteps that)
      //   3. To make the body re-readable by the downstream handler — once
      //      a stream is locked, subsequent reads throw.
      // Reading then passing buffered bytes is safe for internal-MCP
      // payloads (small JSON RPC params); not appropriate for streamed
      // uploads, which this path doesn't carry.
      let bodyBytes: ArrayBuffer | null = null;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // F8: cap inbound body BEFORE buffering. Internal-MCP signed
        // requests carry small JSON-RPC params; 256 KB is a safe ceiling.
        const contentLen = parseInt(request.headers.get('Content-Length') ?? '0', 10);
        if (Number.isFinite(contentLen) && contentLen > MAX_INTERNAL_MCP_BODY) {
          emitRequest(413, 'malformed_request', null);
          return new Response(JSON.stringify({ error: 'payload_too_large' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        try {
          bodyBytes = await request.clone().arrayBuffer();
        } catch {
          emitRequest(401, 'auth_401', null);
          return new Response(
            JSON.stringify({ error: 'invalid_internal_mcp_signature' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
          );
        }
        if (bodyBytes.byteLength > MAX_INTERNAL_MCP_BODY) {
          emitRequest(413, 'malformed_request', null);
          return new Response(JSON.stringify({ error: 'payload_too_large' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        // Reconstruct request from buffered bytes so verify can clone freely
        // and the downstream handler can read the body normally.
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBytes,
        });
      }
      // verifyInternalMcpRequest returns null when X-WM-MCP-User-Id is
      // missing, signature header is malformed, timestamp is out of
      // window, or the HMAC compare fails. All collapse to a single 401 —
      // intentionally do NOT distinguish (don't leak which piece failed
      // to a forge probe).
      const verified = await verifyInternalMcpRequest(request, hmacSecret);
      if (!verified) {
        emitRequest(401, 'auth_401', null);
        return new Response(
          JSON.stringify({ error: 'invalid_internal_mcp_signature' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      // Entitlement re-check at the gateway: the MCP edge already verifies
      // tier ≥ 1 + mcpAccess + validUntil before signing the outbound
      // fetch (api/mcp.ts). This second check defends against (a) the
      // edge being bypassed (e.g. captured signature + leaked secret), (b)
      // mid-request entitlement lapse, (c) future regressions where a
      // non-edge caller signs requests.
      //
      // F1 (U7+U8 review pass): include `validUntil < Date.now()` in the
      // rejection condition. The cache-hot path in `entitlement-check.ts`
      // self-validates `validUntil >= Date.now()` at line 134, but the
      // Convex fallback at lines 154-156 does not — without this check
      // an entitlement row with stale `validUntil` would pass the gateway
      // re-check via the fallback path. Mirror the per-handler runProPreChecks
      // and authorize-pro entitlement guards.
      const ent = await getEntitlements(verified.userId);
      if (
        !ent ||
        ent.features.tier < 1 ||
        // mcpAccess flag lands in U10 — undefined means "field not present
        // on this entitlement row", which we treat as false. This keeps
        // pre-U10 entitlement rows from accidentally granting MCP access.
        (ent.features as { mcpAccess?: boolean }).mcpAccess !== true ||
        ent.validUntil < Date.now()
      ) {
        emitRequest(401, 'auth_401', null);
        return new Response(
          JSON.stringify({ error: 'insufficient_entitlement' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
        );
      }
      // Rebuild Request with trusted markers — sanitised header set
      // already had inbound copies stripped above, so this is the ONLY
      // place those markers can enter the downstream path. Body is
      // re-supplied from the bytes we buffered (bodyBytes is null for
      // GET/HEAD, in which case we omit the body field entirely).
      //
      // The verified-marker value is a per-process-startup random nonce,
      // NOT the constant '1'. This protects direct edge functions that
      // call `isCallerPremium` but don't route through this gateway —
      // an attacker can't guess the nonce, so spoofing the marker on
      // those endpoints fails closed.
      //
      // F7 (U7+U8 review pass): strip the inbound HMAC headers BEFORE
      // setting the trusted markers. The gateway has consumed them via
      // verifyInternalMcpRequest; downstream handlers should only see
      // the trusted-marker pair, not the raw signature/userId headers.
      // Defense-in-depth — handlers shouldn't have any reason to read
      // the inbound HMAC.
      const trusted = new Headers(request.headers);
      trusted.delete(INTERNAL_MCP_SIG_HEADER);
      trusted.delete(INTERNAL_MCP_USER_ID_HEADER);
      trusted.set(INTERNAL_MCP_VERIFIED_HEADER, getInternalMcpVerifiedNonce());
      trusted.set(TRUSTED_USER_ID_HEADER, verified.userId);
      const rebuildInit: RequestInit = { method: request.method, headers: trusted };
      if (bodyBytes !== null) rebuildInit.body = bodyBytes;
      request = new Request(request.url, rebuildInit);
      usage.sessionUserId = verified.userId;
      if (typeof ent.features.tier === 'number') {
        usage.tier = ent.features.tier;
      }
      internalMcpVerified = true;
    }

    // Tier gate check first — JWT resolution is expensive (JWKS + RS256) and only needed
    // for tier-gated endpoints. Non-tier-gated endpoints never use sessionUserId.
    //
    // Internal-MCP verified path skips the tier gate / Clerk JWT resolution
    // entirely: we already resolved the userId via HMAC verify and confirmed
    // tier ≥ 1 + mcpAccess === true. Re-running the JWT path on a request
    // that has no Authorization header would just no-op anyway.
    const isTierGated = !internalMcpVerified && getRequiredTier(pathname) !== null;
    const needsLegacyProBearerGate = !internalMcpVerified && PREMIUM_RPC_PATHS.has(pathname) && !isTierGated;

    // Session resolution — extract userId from bearer token (Clerk JWT) if present.
    // Only runs for tier-gated endpoints to avoid JWKS lookup on every request.
    let sessionUserId: string | null = null;
    if (isTierGated) {
      const session = await resolveClerkSession(request);
      sessionUserId = session?.userId ?? null;
      usage.sessionUserId = sessionUserId;
      usage.clerkOrgId = session?.orgId ?? null;
      if (sessionUserId) {
        request = new Request(request.url, {
          method: request.method,
          headers: (() => {
            const h = new Headers(request.headers);
            h.set('x-user-id', sessionUserId);
            return h;
          })(),
          body: request.body,
        });
      }
    }

    // API key validation — tier-gated endpoints require EITHER an API key OR a valid bearer token.
    // Authenticated users (sessionUserId present) bypass the API key requirement.
    //
    // Internal-MCP verified path: skip validateApiKey entirely. The HMAC
    // verify replaced the API key contract for this request — running
    // validateApiKey would 401 every Pro tool fetch (no wm_ key on the
    // request). Telemetry stays attributed via the verified userId set
    // above; entitlement re-check (`features.tier ≥ 1 && mcpAccess`) was
    // already performed before flipping `internalMcpVerified = true`.
    let keyCheck: { valid: boolean; required: boolean; error?: string; kind?: 'enterprise' | 'session' | 'user' } = internalMcpVerified
      ? { valid: true, required: false }
      : ((await validateApiKey(request, {
          forceKey: (isTierGated && !sessionUserId) || needsLegacyProBearerGate,
        })) as { valid: boolean; required: boolean; error?: string; kind?: 'enterprise' | 'session' | 'user' });

    // Clerk session is itself proof of authentication (validated at line 410).
    // validateApiKey is strict-no-trust-of-headers per #3541 and would 401 every
    // Clerk-authenticated user who hasn't also minted a wms_ session token.
    // Override: tier-gated routes with a resolved sessionUserId pass this layer.
    if (isTierGated && sessionUserId && keyCheck.required && !keyCheck.valid) {
      keyCheck = { valid: true, required: false };
    }

    // User-owned API keys (wm_ prefix): when the static WORLDMONITOR_VALID_KEYS
    // check fails, try async Convex-backed validation for user-issued keys.
    let isUserApiKey = false;
    const wmKey =
      request.headers.get('X-WorldMonitor-Key') ??
      request.headers.get('X-Api-Key') ??
      '';
    if (keyCheck.required && !keyCheck.valid && wmKey.startsWith('wm_')) {
      const { validateUserApiKey } = await import('./_shared/user-api-key');
      const userKeyResult = await validateUserApiKey(wmKey);
      if (userKeyResult) {
        isUserApiKey = true;
        usage.isUserApiKey = true;
        usage.userApiKeyCustomerRef = userKeyResult.userId;
        keyCheck = { valid: true, required: true };
        // Inject x-user-id for downstream entitlement checks
        if (!sessionUserId) {
          sessionUserId = userKeyResult.userId;
          usage.sessionUserId = sessionUserId;
          request = new Request(request.url, {
            method: request.method,
            headers: (() => {
              const h = new Headers(request.headers);
              h.set('x-user-id', sessionUserId);
              return h;
            })(),
            body: request.body,
          });
        }
      }
    }

    // Enterprise API key (WORLDMONITOR_VALID_KEYS): require kind === 'enterprise'.
    // Without this, anonymous wms_ tokens slipped through (validateApiKey marks
    // them valid, wmKey is set, !isUserApiKey, and 'wms_' doesn't startsWith
    // 'wm_'), so telemetry mislabelled them as enterprise_api_key with
    // customer_id='enterprise-unmapped'. PR #3557 round-3 review.
    if (keyCheck.valid && wmKey && !isUserApiKey && keyCheck.kind === 'enterprise') {
      usage.enterpriseApiKey = wmKey;
    }

    // User API keys on PREMIUM_RPC_PATHS need verified pro-tier entitlement.
    // Admin keys (WORLDMONITOR_VALID_KEYS) bypass this since they are operator-issued.
    if (isUserApiKey && needsLegacyProBearerGate && sessionUserId) {
      const ent = await getEntitlements(sessionUserId);
      if (ent) usage.tier = typeof ent.features.tier === 'number' ? ent.features.tier : 0;
      if (!ent || !ent.features.apiAccess) {
        emitRequest(403, 'tier_403', null);
        return new Response(JSON.stringify({ error: 'API access subscription required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (keyCheck.required && !keyCheck.valid) {
      if (needsLegacyProBearerGate) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          const { validateBearerToken } = await import('./auth-session');
          const session = await validateBearerToken(authHeader.slice(7));
          if (!session.valid) {
            emitRequest(401, 'auth_401', null);
            return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          // Capture identity for telemetry — legacy bearer auth bypasses the
          // earlier resolveClerkSession() block (only runs for tier-gated routes),
          // so without this premium bearer requests would emit as anonymous.
          if (session.userId) {
            sessionUserId = session.userId;
            usage.sessionUserId = session.userId;
          }
          // Accept EITHER a Clerk 'pro' role OR a Convex Dodo entitlement with
          // tier >= 1. The Dodo webhook pipeline writes Convex entitlements but
          // does NOT sync Clerk publicMetadata.role, so a paying subscriber's
          // session.role stays 'free' indefinitely. A Clerk-role-only check
          // would block every paying user on legacy premium endpoints despite
          // a valid Dodo subscription. This mirrors the two-signal logic in
          // server/_shared/premium-check.ts::isCallerPremium so the gateway
          // gate and the per-handler gate agree on who is premium — same split
          // already documented at the frontend layer (panel-gating.ts:11-27).
          //
          // Note: validateBearerToken returns session.userId directly, so we
          // use it without needing to resolveSessionUserId() — sessionUserId
          // is intentionally only resolved for ENDPOINT_ENTITLEMENTS-tier-gated
          // endpoints earlier (line 292) to avoid a JWKS lookup on every
          // legacy premium request. validateBearerToken already does its own
          // verification here (line 360) and exposes userId on the result.
          let allowed = session.role === 'pro';
          if (!allowed && session.userId) {
            const ent = await getEntitlements(session.userId);
            if (ent) usage.tier = typeof ent.features.tier === 'number' ? ent.features.tier : 0;
            allowed = !!ent && ent.features.tier >= 1 && ent.validUntil >= Date.now();
          }
          if (!allowed) {
            emitRequest(403, 'tier_403', null);
            return new Response(JSON.stringify({ error: 'Pro subscription required' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          // Valid pro session (Clerk role OR Dodo entitlement) — fall through to route handling.
        } else {
          emitRequest(401, 'auth_401', null);
          return new Response(JSON.stringify({ error: keyCheck.error, _debug: (keyCheck as any)._debug }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } else {
        emitRequest(401, 'auth_401', null);
        return new Response(JSON.stringify({ error: keyCheck.error }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Entitlement check — blocks tier-gated endpoints for users below required tier.
    // Admin API-key holders (WORLDMONITOR_VALID_KEYS, kind: 'enterprise') bypass.
    // User API keys do NOT bypass — the key owner's tier is checked normally.
    // Anonymous wms_ session tokens (kind: 'session') do NOT bypass — they are
    // freely mintable by any caller and are NOT user-bound (PR #3557 review).
    //
    // Internal-MCP verified path also bypasses: we already confirmed
    // tier ≥ 1 + mcpAccess === true above, and `checkEntitlement` reads
    // x-user-id from the request — which IS set on the trusted request,
    // but ENDPOINT_ENTITLEMENTS treats `tier=2` (api) as required for
    // some routes. Pro = tier 1; we don't want a tier-2-required route
    // to 403 a Pro caller via the MCP path because Pro callers reach
    // the gateway only through the MCP edge's whitelisted tool set.
    const isEnterpriseAuth = keyCheck.valid && wmKey && !isUserApiKey && keyCheck.kind === 'enterprise';
    if (!isEnterpriseAuth && !internalMcpVerified) {
      const entitlementResponse = await checkEntitlement(request, pathname, corsHeaders);
      if (entitlementResponse) {
        const entReason: RequestReason =
          entitlementResponse.status === 401 ? 'auth_401'
          : entitlementResponse.status === 403 ? 'tier_403'
          : 'ok';
        emitRequest(entitlementResponse.status, entReason, null);
        return entitlementResponse;
      }
      // Allowed → record the resolved tier for telemetry. getEntitlements has
      // its own Redis cache + in-flight coalescing, so the second lookup here
      // does not double the cost when checkEntitlement already fetched.
      if (isTierGated && sessionUserId && usage.tier === null) {
        const ent = await getEntitlements(sessionUserId);
        if (ent) usage.tier = typeof ent.features.tier === 'number' ? ent.features.tier : 0;
      }
    }

    // IP-based rate limiting — two-phase: endpoint-specific first, then global fallback.
    //
    // Internal-MCP verified path skips IP rate limiting: the MCP edge
    // already enforced 50/day + 60/min per userId in api/mcp.ts. A second
    // limiter here would create misleading double-counting and could 429
    // legitimate Pro tool fetches that pass the upstream cap.
    if (!internalMcpVerified) {
      const endpointRlResponse = await checkEndpointRateLimit(request, pathname, corsHeaders);
      if (endpointRlResponse) {
        emitRequest(endpointRlResponse.status, 'rate_limit_429', null);
        return endpointRlResponse;
      }

      if (!hasEndpointRatePolicy(pathname)) {
        const rateLimitResponse = await checkRateLimit(request, corsHeaders);
        if (rateLimitResponse) {
          emitRequest(rateLimitResponse.status, 'rate_limit_429', null);
          return rateLimitResponse;
        }
      }
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
        emitRequest(405, 'method_not_allowed', null);
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: allowed.join(', '), ...corsHeaders },
        });
      }
      emitRequest(404, 'unknown_route', null);
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Execute handler with top-level error boundary.
    // Wrap in runWithUsageScope so deep fetch helpers (fetchJson,
    // cachedFetchJsonWithMeta) can attribute upstream calls to this customer
    // without leaf handlers having to thread a usage hook through every call.
    let response: Response;
    const identityForScope = buildUsageIdentity(usage);
    const handlerCall = matchedHandler;
    const requestForHandler = request;
    try {
      response = await runWithUsageScope(
        {
          ctx: ctx ?? { waitUntil: () => {} },
          requestId: deriveRequestId(originalRequest),
          customerId: identityForScope.customer_id,
          route: pathname,
          tier: identityForScope.tier,
        },
        () => handlerCall(requestForHandler),
      );
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
    let resolvedCacheTier: CacheTier | null = null;
    if (response.status === 200 && request.method === 'GET' && response.body) {
      const bodyBytes = await response.arrayBuffer();

      // Skip CDN caching for upstream-unavailable / empty responses so CF
      // doesn't serve stale error data for hours.
      //
      // Two field names are in active use across the RPC handlers because the
      // codebase grew two fallback conventions in parallel:
      //   - `upstreamUnavailable: true` — used by consumer-prices/intelligence/
      //     trade handlers that return ad-hoc JSON shapes.
      //   - `unavailable: true` — proto-typed handlers (every economic RPC
      //     including get-macro-signals — `bool unavailable = N` in the proto).
      // The original check only matched the first form, so proto-typed
      // fallback responses were getting full `medium` cache tier (CF s-maxage
      // 1200s, browser max-age 1800s). Production incident 2026-05-03: a
      // 30-min window of auth bug (PR #3541's wm-session interceptor) caused
      // every macroSignals RPC to return the fallback. Those responses got
      // cached for 30 min. Even after auth was fixed (PR #3574), browsers
      // and CF POPs kept serving "Upstream API unavailable" until the cache
      // TTL expired naturally — 30 min of false-bad UX per affected user.
      // Detecting both field names closes that window.
      const bodyStr = new TextDecoder().decode(bodyBytes);
      const isUpstreamUnavailable =
        bodyStr.includes('"upstreamUnavailable":true') ||
        bodyStr.includes('"unavailable":true');

      if (mergedHeaders.get('X-No-Cache') || isUpstreamUnavailable) {
        mergedHeaders.set('Cache-Control', 'no-store');
        mergedHeaders.set('X-Cache-Tier', 'no-store');
        resolvedCacheTier = 'no-store';
      } else {
        const rpcName = pathname.split('/').pop() ?? '';
        const envOverride = process.env[`CACHE_TIER_OVERRIDE_${rpcName.replace(/-/g, '_').toUpperCase()}`] as CacheTier | undefined;
        const isPremium = PREMIUM_RPC_PATHS.has(pathname) || getRequiredTier(pathname) !== null;
        const tier = isPremium ? 'slow-browser' as CacheTier
          : (envOverride && envOverride in TIER_HEADERS ? envOverride : null) ?? RPC_CACHE_TIER[pathname] ?? 'medium';
        resolvedCacheTier = tier;
        mergedHeaders.set('Cache-Control', TIER_HEADERS[tier]);
        // Only allow Vercel CDN caching for trusted origins (worldmonitor.app, Vercel previews,
        // Tauri). No-origin server-side requests (external scrapers) must always reach the edge
        // function so the auth check in validateApiKey() can run. Without this guard, a cached
        // 200 from a trusted-origin browser request could be served to a no-origin scraper,
        // bypassing auth entirely.
        const reqOrigin = request.headers.get('origin') || '';
        const cdnCache = !isPremium && isAllowedOrigin(reqOrigin) ? TIER_CDN_CACHE[tier] : null;
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
        emitRequest(304, 'ok', resolvedCacheTier, 0);
        maybeAttachDevHealthHeader(mergedHeaders);
        return new Response(null, { status: 304, headers: mergedHeaders });
      }

      emitRequest(response.status, 'ok', resolvedCacheTier, view.length);
      maybeAttachDevHealthHeader(mergedHeaders);
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

    // Streaming/non-GET-200 responses: res_bytes is best-effort 0 (Content-Length
    // is often absent on chunked responses; teeing the stream would add latency).
    const finalContentLen = response.headers.get('content-length');
    const finalResBytes = finalContentLen ? Number(finalContentLen) || 0 : 0;
    emitRequest(response.status, 'ok', resolvedCacheTier, finalResBytes);
    maybeAttachDevHealthHeader(mergedHeaders);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  };
}
