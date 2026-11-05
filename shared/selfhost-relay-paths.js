/**
 * Paths a self-hosted (docker mode) sidecar relays to the World Monitor cloud
 * with a browser user's own desktop key (plan 2026-11-04-001, KTD6).
 *
 * This is PREMIUM_RPC_PATHS (src/shared/premium-paths.ts) minus the API-only
 * set (server/_shared/api-only-paths.ts): REST v2, MCP and OAuth stay closed
 * to desktop keys. The Docker runtime image ships neither src/ nor server/,
 * so the sidecar reads this mirror instead.
 * tests/selfhost-relay-paths-parity.test.mts fails when either source set
 * changes without this file.
 *
 * Membership is exact: a trailing slash or a suffix is not a relayed path.
 */

const RELAY_PATHS = new Set([
  '/api/market/v1/analyze-stock',
  '/api/market/v1/get-stock-analysis-history',
  '/api/market/v1/get-insider-transactions',
  '/api/market/v1/backtest-stock',
  '/api/market/v1/list-stored-stock-backtests',
  '/api/market/v1/get-physical-premiums',
  '/api/market/v1/get-physical-divergence-index',
  '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/intelligence/v1/get-country-coverage',
  '/api/intelligence/v1/list-market-implications',
  '/api/intelligence/v1/list-wsb-tickers',
  '/api/intelligence/v1/get-regional-snapshot',
  '/api/intelligence/v1/get-regime-history',
  '/api/intelligence/v1/get-regional-brief',
  '/api/intelligence/v1/search-intel-history',
  '/api/intelligence/v1/get-intel-timeline',
  '/api/intelligence/v1/get-similar-events',
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-indicators',
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
  '/api/supply-chain/v1/get-mineral-production',
  '/api/supply-chain/v1/get-country-vulnerabilities',
  '/api/supply-chain/v1/get-chokepoint-dependencies',
  '/api/supply-chain/v1/list-vulnerability-rankings',
  '/api/economic/v1/list-global-tenders',
  '/api/news/v1/list-media-perspective',
  '/api/news/v1/list-news-pool',
  '/api/trade/v1/list-comtrade-flows',
  '/api/trade/v1/get-tariff-trends',
  '/api/trade/v1/get-bilateral-tariff',
  '/api/trade/v1/get-us-import-duty',
  '/api/scenario/v1/run-scenario',
  '/api/scenario/v1/get-scenario-status',
  '/api/forecast/v1/trigger-simulation',
  '/api/mcp-proxy',
  '/api/chat-analyst',
  '/api/military/v1/get-aircraft-details',
  '/api/military/v1/get-defense-industrial-base',
  '/api/aviation/v1/list-airport-flights',
  '/api/aviation/v1/get-carrier-ops',
  '/api/aviation/v1/get-flight-status',
  '/api/aviation/v1/search-flight-prices',
]);

function refuseMutation() {
  throw new TypeError('SELFHOST_RELAY_PATHS is read-only');
}
RELAY_PATHS.add = refuseMutation;
RELAY_PATHS.delete = refuseMutation;
RELAY_PATHS.clear = refuseMutation;

/** @type {ReadonlySet<string>} */
export const SELFHOST_RELAY_PATHS = Object.freeze(RELAY_PATHS);

/** True when a docker sidecar relays `pathname` for a browser holding a desktop key. */
export function isSelfHostRelayPath(pathname) {
  return RELAY_PATHS.has(pathname);
}
