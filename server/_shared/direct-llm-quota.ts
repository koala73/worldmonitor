import { getKeyPrefix } from './redis';
import { PRO_DAILY_QUOTA_TTL_SECONDS, secondsUntilUtcMidnight } from './pro-mcp-token';

// Dashboard/API LLM work is a separate budget from MCP calls. The old value of
// 50 was copied from the MCP allowance and caused normal dashboard hydration to
// exhaust a Pro user's spend budget almost immediately.
export const DIRECT_LLM_DAILY_QUOTA_LIMIT = 500;
export const DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/**
 * Daily direct-LLM allowance for a caller whose PAID entitlement could not be
 * confirmed: no Convex row at all, a free-tier row, a lapsed row, or a
 * verification outage (`getEntitlements` never throws — it answers with a
 * tier-0 `verificationUnavailable` marker, which must not read as "free to
 * spend").
 *
 * This is deliberately the ceiling main enforced for EVERY non-enterprise
 * caller before the plan-scoped split, so raising the paid default from 50 to
 * 500 cannot raise what an unconfirmed caller is able to spend. It is a safety
 * floor, not a product allowance — the catalog sells free plans
 * `dashboardAiCallsPerDay: 0`, and the tier-gated AI routes still deny those
 * callers before the handler runs. Keeping it non-zero is what stops an
 * entitlement-service outage from 429-ing paying customers.
 */
export const DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT = 50;

export type DirectLlmEntitlementShape = {
  features?: {
    tier?: number;
    planLimits?: {
      mcpCallsPerDay?: number | null;
      dashboardAiCallsPerDay?: number | null;
    };
  };
  validUntil?: number;
  /** Synthesized when a lookup was attempted but could not be completed. */
  verificationUnavailable?: boolean;
};

/**
 * Resolve the dashboard-AI allowance from a catalog-backed entitlement row.
 * A member missing from an otherwise-confirmed PAID row is a legacy row that
 * predates the dimension, so it inherits the Pro default; explicit null means
 * unlimited and zero remains a real zero allowance.
 *
 * Callers must not hand unconfirmed rows to this function — route them through
 * `resolveActiveDirectLlmLimit`, which is what decides "is this caller paid".
 */
export function resolveDirectLlmDailyLimit(planDailyLimit?: number | null): number | null {
  if (planDailyLimit === null) return null;
  if (typeof planDailyLimit === 'number' && Number.isFinite(planDailyLimit) && planDailyLimit >= 0) {
    return planDailyLimit;
  }
  return DIRECT_LLM_DAILY_QUOTA_LIMIT;
}

export function directLlmDailyLimitFromEntitlements(
  entitlements: DirectLlmEntitlementShape | null | undefined,
): number | null | undefined {
  return entitlements?.features?.planLimits?.dashboardAiCallsPerDay;
}

/** A row that currently proves paid access — not merely present. */
function isActivePaidEntitlement(ent: DirectLlmEntitlementShape | null | undefined): boolean {
  if (!ent || ent.verificationUnavailable) return false;
  const tier = ent.features?.tier;
  if (typeof tier !== 'number' || tier < 1) return false;
  return typeof ent.validUntil === 'number' && ent.validUntil >= Date.now();
}

/**
 * THE decision point for "what daily direct-LLM budget does this caller get".
 *
 * Both enforcement surfaces — `server/gateway.ts` and `api/chat-analyst.ts`
 * (via `resolvePremiumCallerIdentity`) — INCR the same
 * `llm:direct-usage:<userId>:<date>` key, so they must agree. One counter
 * enforced against two different caps is the class of bug this centralizes
 * away: it tells a Pro Business customer "limit 500" on one surface while
 * another surface serves them 2,500 against the very same counter.
 *
 * - Confirmed active paid row -> that plan's catalog allowance (null = unlimited).
 * - Anything else (free, lapsed, absent, unverifiable) ->
 *   `DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT`, never the paid default.
 */
export function resolveActiveDirectLlmLimit(
  ent: DirectLlmEntitlementShape | null | undefined,
): number | null {
  if (!isActivePaidEntitlement(ent)) return DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT;
  return resolveDirectLlmDailyLimit(directLlmDailyLimitFromEntitlements(ent));
}

export const DIRECT_LLM_GATEWAY_QUOTA_PATHS = new Set<string>([
  '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/market/v1/analyze-stock',
  '/api/news/v1/summarize-article',
]);

export const DIRECT_LLM_SELF_METERED_QUOTA_PATHS = new Set<string>([
  '/api/chat-analyst',
]);

export const DIRECT_LLM_QUOTA_PATHS = new Set<string>([
  ...DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  ...DIRECT_LLM_SELF_METERED_QUOTA_PATHS,
]);

export type DirectLlmQuotaReservation =
  | { ok: true; newCount: number; rollback: () => Promise<void> }
  | {
      ok: false;
      reason: 'cap-exceeded' | 'redis-unavailable';
      floor?: number;
      retryAfterSec: number;
    };

export type DirectLlmQuotaPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown }>>;

export function directLlmDailyQuotaKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${getKeyPrefix()}llm:direct-usage:${userId}:${yyyy}-${mm}-${dd}`;
}

export async function reserveDirectLlmQuota(opts: {
  userId: string;
  pipeline: DirectLlmQuotaPipeline;
  limit?: number | null;
  date?: Date;
}): Promise<DirectLlmQuotaReservation> {
  const limit = resolveDirectLlmDailyLimit(opts.limit);
  const retryAfterSec = secondsUntilUtcMidnight(opts.date);
  const key = directLlmDailyQuotaKey(opts.userId, opts.date);
  if (!key) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let pipeResult: Array<{ result?: unknown }> | null;
  try {
    pipeResult = await opts.pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await opts.pipeline([['DECR', key]]);
    } catch {
      // Best-effort: over-counting by one is the cost-protection-correct direction.
    }
  };

  if (limit !== null && newCount > limit) {
    await rollback();
    return {
      ok: false,
      reason: 'cap-exceeded',
      floor: limit,
      retryAfterSec,
    };
  }

  return { ok: true, newCount, rollback };
}
