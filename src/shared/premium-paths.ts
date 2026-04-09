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
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/supply-chain/v1/get-country-chokepoint-index',
]);
