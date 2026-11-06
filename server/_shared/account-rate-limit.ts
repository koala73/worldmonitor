/**
 * Pooled limits of an Enterprise contract account (convex/enterpriseAccounts.ts).
 *
 * One shape for both doors — the gateway's REST meter and the MCP budget
 * (api/mcp/quota.ts) — so they cannot disagree on the pool's identity, its
 * burst, or where the safety limit sits:
 *
 *   identity       `acct:<id>` — the shared per-minute burst bucket and the
 *                  pooled day key (`apiKeyDailyKey('acct:<id>')`)
 *   dailyAllowance the contract allowance; requests past it are served and
 *                  billed as overage
 *   breakerCeiling dailyAllowance × breakerMultiple; requests past it are
 *                  rejected (the leaked-key breaker)
 *
 * Kept out of `api-key-rate-limit.ts` because gateway unit tests replace that
 * module wholesale; a new export there would be undefined under their mocks.
 */

/** Response header on a served contract-account request that fell past the
 *  account's daily allowance and bills as overage. Value `true`; absent
 *  otherwise. Documented in docs/usage-rate-limits.mdx. */
export const ACCOUNT_OVERAGE_HEADER = 'X-WorldMonitor-Overage';

export interface AccountRateLimitPlan {
  id: string;
  identity: string;
  dailyAllowance: number;
  perMinuteBurst: number;
  breakerCeiling: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The pooled limits an entitlement's `account` block buys, or null when the
 * block is absent or malformed — the caller then keeps the member on their
 * per-user plan path. Convex validates every field as a positive integer on
 * write (validateTerms), so anything else is a corrupt cache entry, never a
 * reason to meter at a guessed number.
 */
export function accountRateLimitPlan(account: unknown): AccountRateLimitPlan | null {
  if (!account || typeof account !== 'object') return null;
  const { id, dailyAllowance, perMinuteBurst, breakerMultiple } = account as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return null;
  if (!isPositiveInteger(dailyAllowance) || !isPositiveInteger(perMinuteBurst) || !isPositiveInteger(breakerMultiple)) {
    return null;
  }
  return {
    id,
    identity: `acct:${id}`,
    dailyAllowance,
    perMinuteBurst,
    breakerCeiling: dailyAllowance * breakerMultiple,
  };
}
