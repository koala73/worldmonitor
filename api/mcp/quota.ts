import { apiKeyDailyKey } from '../../server/_shared/api-key-rate-limit';
import {
  dailyCounterKey,
  dailyQuotaFloorKey,
  envPrefix,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../../server/_shared/pro-mcp-token';
import { MCP_QUOTA_RESERVE_SCRIPT as RESERVE_QUOTA_SCRIPT } from '../../shared/mcp-quota-reserve-script.mjs';
import type { PipelineFn, QuotaRejected, QuotaReserved } from './types';

// ---------------------------------------------------------------------------
// Daily quota helpers (Pro-only). Reservation runs synchronously on the
// critical path BEFORE tool dispatch — never inside `waitUntil` — as a
// single Redis EVAL so increment, owner-only rollback, and F4 residue
// clamp cannot interleave. Once dispatch begins, callers keep the slot
// charged even if execution later errors or exceeds budget.
//
// The cap itself is plan-driven (plan 2026-07-25-001 U3): the caller passes the
// allowance resolved from the entitlement, and `PRO_DAILY_QUOTA_LIMIT` is the
// fallback for anyone who can't supply one.
// ---------------------------------------------------------------------------

/**
 * Normalise a plan-resolved allowance into the value this module enforces.
 *
 * `null` (unlimited) passes through; a finite non-negative number is honoured
 * verbatim — including `0`, which is a real "no allowance" and must not be
 * mistaken for a missing one. EVERYTHING else — undefined, a legacy row with no
 * `planLimits`, NaN/Infinity, a negative, a stringified number — resolves to
 * `PRO_DAILY_QUOTA_LIMIT`. That direction is deliberate: an unreadable limit
 * must never buy a caller a HIGHER cap than the plan default.
 *
 * Exported because the settings-UI reader (`api/user/mcp-quota.ts`) must DISPLAY
 * exactly the limit this module ENFORCES. A second copy of this normalisation
 * would be the drift the endpoint's whole reason for existing is to prevent.
 */
export function resolveDailyLimit(planDailyLimit?: number | null): number | null {
  if (planDailyLimit === null) return null;
  if (typeof planDailyLimit === 'number' && Number.isFinite(planDailyLimit) && planDailyLimit >= 0) {
    return planDailyLimit;
  }
  return PRO_DAILY_QUOTA_LIMIT;
}

/** Catalog marker for a plan whose MCP calls charge its REST budget. Duplicated
 *  from `convex/config/productCatalog.ts` rather than imported: the MCP edge
 *  bundle must not pull the Convex config graph in. The parity test asserts the
 *  two literals stay equal. */
export const SHARED_API_BUDGET = 'shared-api-budget';

/**
 * Whether the per-account daily meter REJECTS or merely records.
 *
 * The same flag `server/gateway.ts` reads, and deliberately so: the shared
 * budget is only a cap when both doors treat it as one. Read at call time
 * rather than module load so a deploy that flips the flag takes effect without
 * waiting for an edge instance to recycle.
 */
export function isRestEnforcementEnabled(): boolean {
  return process.env.API_RATE_LIMIT_ENFORCE === 'true';
}

/**
 * Which number a plan sold, and where it is counted.
 *
 * `allowance` decides the PRICE: `'api'` charges the per-tool weight, so a unit
 * of work costs the same whichever door it arrives through; `'mcp'` charges one
 * unit per call, which is what `docs/usage-rate-limits.mdx` sells on the
 * dedicated counter and what the GHSA-hcq5 no-refund slot assumes.
 *
 * `counter` decides the PLACE, and exists only on the `api` arm — so "a
 * dedicated MCP allowance charged to the shared REST key" has no field to live
 * in. The three states below are the only ones representable:
 *
 *   - `{allowance: 'mcp'}` — Pro 50, Pro Business 250, the free-account
 *     ceiling, Enterprise `null`. `apiAccess: false` with a zero REST budget,
 *     so they keep `mcp:pro-usage:…` at one unit per call.
 *   - `{allowance: 'api', counter: 'mcp'}` — API tiers while
 *     `API_RATE_LIMIT_ENFORCE` is off: the sold REST number, weighted, on the
 *     dedicated counter.
 *   - `{allowance: 'api', counter: 'api'}` — API tiers once the flag flips:
 *     the same number on `rl:apikey:day:…`, shared with REST.
 *
 * This replaces the KTD6 plan-key exception list, which existed only because
 * the catalog published an MCP number the edge refused to honour — leaving
 * OAuth and `user_key` free to disagree about the cap.
 *
 * When the flag flip becomes permanent, delete `counter` and the shadow branch
 * in `resolveMcpBudget`: no variant is renamed and no call site moves.
 */
export type McpBudget =
  | { allowance: 'mcp'; limit: number | null }
  | { allowance: 'api'; counter: 'mcp' | 'api'; limit: number | null };

/**
 * Resolve which budget a plan's MCP calls charge.
 *
 * Shared by enforcement (`checkMcpEntitlementGate`), the settings display
 * (`api/user/mcp-quota.ts`), and the `account/mcp-allowance` resource so the
 * number a user reads is the number the reservation applies. An unreadable
 * entitlement resolves to the dedicated Pro default, never to a shared budget:
 * a missing limit must never buy a caller a HIGHER cap than the plan default.
 */
export function resolveMcpBudget(
  mcpCallsPerDay: number | null | string | undefined,
  apiRequestsPerDay?: number | null,
  restEnforced: boolean = isRestEnforcementEnabled(),
): McpBudget {
  if (mcpCallsPerDay === SHARED_API_BUDGET) {
    // The LIMIT is the sold one either way — Starter 1,000, Business 10,000 —
    // because that is the number every published surface quotes and the number
    // enforcement must therefore apply. Only the COUNTER moves with the flag:
    // while REST runs in shadow the gateway SERVES over-allowance requests and
    // leaves their increments on `rl:apikey:day:…` (`reserveDailyMeter` only
    // rolls back when it actually rejects), so that key is a demand signal
    // sitting far above the limit for exactly the heaviest accounts, not a cap.
    // Rejecting MCP against it would 429 those accounts for the rest of the UTC
    // day the moment this ships — the opposite of the advisory behaviour the
    // flag promises. The dedicated counter carries the same ceiling until the
    // flag makes the shared budget real for REST and MCP together.
    return {
      allowance: 'api',
      counter: restEnforced ? 'api' : 'mcp',
      limit: resolveDailyLimit(apiRequestsPerDay),
    };
  }
  return {
    allowance: 'mcp',
    limit: resolveDailyLimit(typeof mcpCallsPerDay === 'string' ? undefined : mcpCallsPerDay),
  };
}

/**
 * The daily counter a budget charges. Exported because the settings reader
 * (`api/user/mcp-quota.ts`) and the `account/mcp-allowance` resource must READ
 * the counter this module WRITES; a second copy of this choice would be exactly
 * the drift those surfaces exist to prevent.
 *
 * Shared-counter keys are prefixed here because this path talks to the raw
 * Upstash pipeline. REST's `apiKeyDailyKey` is a logical key — `runRedisPipeline`
 * adds `envPrefix()` for it. Dedicated MCP keys already carry that prefix
 * inside `dailyCounterKey`.
 */
export function budgetCounterKey(budget: McpBudget | undefined, userId: string, date?: Date): string {
  if (budget?.allowance !== 'api' || budget.counter !== 'api') return dailyCounterKey(userId, date);
  const key = apiKeyDailyKey(userId, date);
  return key ? `${envPrefix()}${key}` : key;
}

function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Charge one `tools/call` against `budget`.
 *
 * `toolUnits` is what the tool costs (`toolWeight`), not what it is charged:
 * only an `api` allowance pays it. A dedicated MCP allowance is one call, one
 * unit — the number `docs/usage-rate-limits.mdx` sells — so applying the weight
 * there would double-charge Pro's 50/day, and the price question is answered
 * here, next to the budget that decides it, rather than at the call site.
 */
export async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
  budget?: McpBudget,
  toolUnits = 1,
): Promise<QuotaReserved | QuotaRejected> {
  const weight = budget?.allowance === 'api' ? toolUnits : 1;
  // `null` = unlimited: the counter still moves (metering is not optional) but
  // the rejection branch below is skipped entirely.
  // Normalise even a caller-supplied budget: `resolveMcpBudget` already does
  // this, but a hand-built budget carrying a garbage limit must still land on
  // the plan default rather than skipping the check and enforcing `undefined`.
  const limit = budget ? resolveDailyLimit(budget.limit) : PRO_DAILY_QUOTA_LIMIT;
  // Once the flag flips, a shared-budget plan charges the REST meter, so an MCP
  // call and a REST call draw down the same number the customer was sold.
  // `budgetCounterKey` is the deployment-namespaced form of `apiKeyDailyKey` —
  // REST prefixes that logical key in `runRedisPipeline`; this raw MCP pipeline
  // must prefix it here. The floor key is namespaced separately so the clamp
  // cannot collide with REST.
  const key = budgetCounterKey(budget, userId);
  const floorKey = dailyQuotaFloorKey(userId);
  if (!key || !floorKey) return { ok: false, reason: 'redis-unavailable' };

  let pipeResult: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    pipeResult = await pipeline([[
      'EVAL',
      RESERVE_QUOTA_SCRIPT,
      2,
      key,
      floorKey,
      limit === null ? '' : limit,
      PRO_DAILY_QUOTA_TTL_SECONDS,
      weight,
    ]]);
  } catch {
    pipeResult = null;
  }

  const entry = pipeResult?.[0];
  if (
    !pipeResult
    || !Array.isArray(pipeResult)
    || pipeResult.length !== 1
    || !entry
    || (entry.error !== undefined && entry.error !== null)
    || !Array.isArray(entry.result)
  ) {
    // Hard cap correctness: NEVER dispatch on reservation failure.
    return { ok: false, reason: 'redis-unavailable' };
  }

  const status = asFiniteNumber(entry.result[0]);
  const newCount = asFiniteNumber(entry.result[1]);
  if (status === null || newCount === null) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  // Build idempotent rollback. `await rollback()` runs DECR once; subsequent
  // calls are no-ops. Dispatch does not call this after a successful reserve
  // (GHSA-hcq5: the slot stays charged once tool execution begins).
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECRBY', key, weight]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots by
      // the charged weight, which is the cost-protection-correct direction.
    }
  };

  if (status === 1 && newCount >= weight) {
    return { ok: true, newCount, rollback };
  }

  if (status === 0 && limit !== null && newCount >= 0) {
    // F4 clamp lives inside the script: residue above the RESOLVED limit is
    // written back to that limit in the same atomic turn. The floor reported
    // to the caller is the limit that was enforced, not a live snapshot.
    return { ok: false, reason: 'cap-exceeded', floor: limit };
  }

  return { ok: false, reason: 'redis-unavailable' };
}
