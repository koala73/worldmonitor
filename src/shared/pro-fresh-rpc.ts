/**
 * Caller-invariant market reads that active Pro-or-higher plans may refresh
 * more aggressively in the browser.
 *
 * This is an opt-in authentication surface, not an authorization gate: free
 * and anonymous callers keep access with the ordinary private cache policy.
 * The gateway must verify the attached user identity and entitlement before
 * selecting the shorter cache tier.
 */
export const PRO_FRESH_CACHE_RPC_PATHS = new Set<string>([
  '/api/market/v1/list-market-quotes',
  '/api/market/v1/list-crypto-quotes',
  '/api/market/v1/list-commodity-quotes',
  '/api/market/v1/list-stablecoin-markets',
  '/api/market/v1/list-gulf-quotes',
]);
