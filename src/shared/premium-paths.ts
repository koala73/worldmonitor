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
  '/api/intelligence/v1/deduct-situation',
  '/api/intelligence/v1/list-market-implications',
  '/api/intelligence/v1/get-regional-snapshot',
  '/api/intelligence/v1/get-regime-history',
  '/api/intelligence/v1/get-regional-brief',
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/supply-chain/v1/get-country-chokepoint-index',
  '/api/supply-chain/v1/get-bypass-options',
  '/api/supply-chain/v1/get-country-cost-shock',
  '/api/supply-chain/v1/get-route-explorer-lane',
  '/api/supply-chain/v1/get-route-impact',
  '/api/supply-chain/v1/get-country-products',
  '/api/supply-chain/v1/get-multi-sector-cost-shock',
  '/api/supply-chain/v1/get-sector-dependency',
  '/api/economic/v1/get-national-debt',
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
]);
