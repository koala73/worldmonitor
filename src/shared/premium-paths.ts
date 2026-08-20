/**
 * Premium RPC paths that require either an API key or a Pro session.
 *
 * Single source of truth consumed by both the server gateway (auth enforcement)
 * and the web client runtime (token injection).
 */
export const PREMIUM_RPC_PATHS = new Set<string>([
  '/api/market/v1/analyze-stock',
  '/api/market/v1/get-stock-analysis-history',
  '/api/market/v1/backtest-stock',
  '/api/market/v1/list-stored-stock-backtests',
  // /api/intelligence/v1/classify-event: LLM-backed classifier. Keep in the
  // premium path set so browser Pro callers attach the Clerk Bearer and
  // anonymous wms_ sessions cannot mint cache-miss LLM spend.
  '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation',
  // Browser calls must attach Clerk auth and bypass wm-session recovery:
  // anonymous 401s here are expected Pro denials, not dead session cookies.
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/intelligence/v1/list-market-implications',
  '/api/intelligence/v1/get-regional-snapshot',
  '/api/intelligence/v1/get-regime-history',
  '/api/intelligence/v1/get-regional-brief',
  // Historical intelligence memory (#5694). Read-only over the Convex history
  // store; the two semantic routes also spend one embeddings call per cache
  // miss, which is why they carry fail-closed rate policies as well.
  '/api/intelligence/v1/search-intel-history',
  '/api/intelligence/v1/get-intel-timeline',
  '/api/intelligence/v1/get-similar-events',
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/resilience/v1/get-food-stocks',
  '/api/resilience/v1/get-demographics-capability',
  '/api/supply-chain/v1/get-country-chokepoint-index',
  '/api/supply-chain/v1/get-bypass-options',
  '/api/supply-chain/v1/get-country-cost-shock',
  '/api/supply-chain/v1/get-route-explorer-lane',
  '/api/supply-chain/v1/get-route-impact',
  '/api/supply-chain/v1/get-country-products',
  '/api/supply-chain/v1/get-multi-sector-cost-shock',
  '/api/supply-chain/v1/get-sector-dependency',
  '/api/economic/v1/get-national-debt',
  // Global procurement is a Pro product surface. Keep this in the shared
  // registry so premiumFetch attaches the Clerk bearer and the gateway enforces
  // the same route as the entitlement map.
  '/api/economic/v1/list-global-tenders',
  '/api/sanctions/v1/list-sanctions-pressure',
  '/api/trade/v1/list-comtrade-flows',
  '/api/trade/v1/get-tariff-trends',
  '/api/scenario/v1/run-scenario',
  '/api/scenario/v1/get-scenario-status',
  // #3734: PRO-gated mutation that enqueues a simulation task. Companion
  // /get-simulation-outcome remains public (existing convention).
  '/api/forecast/v1/trigger-simulation',
  '/api/v2/shipping/route-intelligence',
  '/api/v2/shipping/webhooks',
  // /api/mcp-proxy: Pro-gated outbound MCP proxy (PR #3768, issue #3723).
  // Path-gated here so premiumFetch attaches the Clerk Bearer for normal
  // web Pro users; the server gate in api/mcp-proxy.ts uses isCallerPremium
  // which validates enterprise key, wm_ user key, or Bearer JWT.
  '/api/mcp-proxy',
  // /api/chat-analyst: Pro-gated streaming SSE endpoint for WM Analyst panel.
  // ChatAnalystPanel.send() calls premiumFetch('/api/chat-analyst', ...) and
  // the server uses isCallerPremium; without this entry premiumFetch never
  // attaches the Clerk Bearer for browser Pro users → every send returned
  // 403 "Pro subscription required" despite a valid subscription. Symptom
  // stayed hidden until PR #3797 fixed the unlock-wipe so users could
  // actually type and click Send.
  '/api/chat-analyst',
  // The three AviationStack-METERED routes. Each cache miss buys a paid
  // upstream call and get-carrier-ops buys one PER AIRPORT, so anonymous access
  // was a standing invitation: one scripted client took ~1,000 calls/day, ~43%
  // of spend, in August 2026. Registered here for the same reason /api/chat-
  // analyst is — without the entry premiumFetch never attaches the Clerk Bearer
  // and browser Pro users get 403 on a subscription they are paying for.
  // The seeder-backed aviation routes (list-airport-delays,
  // get-airport-ops-summary) stay OFF this list on purpose: they serve
  // aviation:delays:intl:v3, already bought by cron, so gating them would cost
  // the free map its airport-delay layer and save nothing.
  '/api/aviation/v1/list-airport-flights',
  '/api/aviation/v1/get-carrier-ops',
  '/api/aviation/v1/get-flight-status',
  // TravelPayouts, billed per search — a different provider from the three
  // above but the same exposure, and the same scraper was spending on it.
  '/api/aviation/v1/search-flight-prices',
]);
