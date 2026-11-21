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
 * For the same reason `rateLimitHeaders` is read from the shared JavaScript
 * core directly rather than through that module.
 */

// @ts-expect-error — JS module, no declaration file; typed below.
import * as core from '../../api/_api-key-rate-limit.js';

const rateLimitHeaders = core.rateLimitHeaders as (opts: {
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterSec: number;
  windowSec?: number;
}) => Record<string, string>;

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

/** The two facts the account responses read from a daily meter reservation. */
export interface AccountMeterReading {
  /** Pooled count for the UTC day after this request. */
  count: number;
  /** Seconds until UTC midnight, when the pool resets. */
  retryAfterSec: number;
}

/**
 * The REST 429 for a request that reached the account's safety limit. The
 * headers keep quoting the contract allowance the customer bought; the body
 * names the limit that tripped (`limit`) beside it (`allowance`). No upgrade
 * link: a contract has no self-serve step up. The MCP denial for the same
 * state (api/mcp/upgrade.ts) carries the same two numbers.
 */
export function accountSafetyLimitResponse(
  plan: AccountRateLimitPlan,
  meter: Pick<AccountMeterReading, 'retryAfterSec'>,
  corsHeaders: Record<string, string>,
  planKey: string,
): Response {
  const resetMs = Date.now() + meter.retryAfterSec * 1000;
  return new Response(JSON.stringify({
    error: 'Daily safety limit reached',
    message: "This account's daily safety limit was reached. Requests resume at the next UTC day.",
    plan: planKey || undefined,
    limit: plan.breakerCeiling,
    allowance: plan.dailyAllowance,
    limit_type: 'daily',
    reset: new Date(resetMs).toISOString(),
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...rateLimitHeaders({
        limit: plan.dailyAllowance,
        remaining: 0,
        resetMs,
        retryAfterSec: meter.retryAfterSec,
        windowSec: 86_400,
      }),
      ...corsHeaders,
    },
  });
}

/**
 * Headers for a served request counted on the account's pool: the contract
 * allowance as the advertised daily policy, and `X-WorldMonitor-Overage: true`
 * once the pooled count passes it. No `Retry-After`, since nothing here asks
 * the caller to wait.
 */
export function accountServedHeaders(plan: AccountRateLimitPlan, meter: AccountMeterReading): Record<string, string> {
  const { 'Retry-After': _retryAfter, ...allowanceHeaders } = rateLimitHeaders({
    limit: plan.dailyAllowance,
    remaining: plan.dailyAllowance - meter.count,
    resetMs: Date.now() + meter.retryAfterSec * 1000,
    retryAfterSec: meter.retryAfterSec,
    windowSec: 86_400,
  });
  return meter.count > plan.dailyAllowance
    ? { ...allowanceHeaders, [ACCOUNT_OVERAGE_HEADER]: 'true' }
    : allowanceHeaders;
}
