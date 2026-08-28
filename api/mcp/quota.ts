import {
  dailyCounterKey,
  dailyQuotaFloorKey,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../../server/_shared/pro-mcp-token';
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

/**
 * Plans whose catalog `mcpCallsPerDay` must NOT drive the daily cap on the
 * pro (OAuth) MCP context. The KTD6 boundary is a PLAN boundary, not a
 * credential boundary: API-tier subscribers can mint pro OAuth tokens too
 * (tier>=1 + mcpAccess), and without this gate their catalog allowance
 * (1000/10000) would leak through the OAuth door while their `user_key`
 * stays hardcoded at 50. Raising API-tier MCP allowances is a deliberate
 * follow-up; until then both credential classes must agree on the cap.
 */
const API_TIER_MCP_CAPPED_PLAN_KEYS = new Set([
  'api_starter',
  'api_starter_annual',
  'api_business',
  'api_business_annual',
]);

/**
 * Gate a plan-resolved MCP allowance on plan family: API-tier plans report
 * `undefined` (→ the 50/day default via `resolveDailyLimit`); every other
 * plan's allowance passes through verbatim — pro/pro_business plan-driven
 * numbers, enterprise's `null` (unlimited), free's `0`.
 *
 * Shared by the enforcement path (`checkMcpEntitlementGate`) and the
 * settings display (`api/user/mcp-quota.ts`) so the number a user reads is
 * the number the reservation applies.
 */
export function resolvePlanDrivenMcpAllowance(
  planKey: string | undefined,
  mcpCallsPerDay: number | null | undefined,
): number | null | undefined {
  if (planKey && API_TIER_MCP_CAPPED_PLAN_KEYS.has(planKey)) return undefined;
  return mcpCallsPerDay;
}

/**
 * Atomic reservation + owner-only reject/clamp.
 *
 * Redis serializes EVAL, so increment, this-request rollback, and F4
 * residue clamp cannot interleave with another reservation. After this
 * script's DECR, any remaining overshoot is failed-rollback residue —
 * not another request's still-live increment — so SET cannot steal a
 * concurrent reservation and later undercount the meter (#7272).
 *
 * KEYS[2] records the highest allowance that successfully reserved today
 * (`-1` = unlimited). Clamp never drops the shared counter below that
 * floor, so a user_key 50/day rejection cannot SET away a Pro Business
 * 250/day charge on the same key.
 *
 * KEYS[1] = daily counter
 * KEYS[2] = max successful limit today (`-1` = unlimited seen)
 * ARGV[1] = finite limit, or empty for unlimited (meter only)
 * ARGV[2] = TTL seconds
 *
 * Returns {status, count}:
 *   1, n  reserved at n
 *   0, n  rejected; n is the post-recovery count
 *  -1, 0  unreadable limit (fail closed after rolling back this INCR)
 */
const RESERVE_QUOTA_SCRIPT = `
local ttl = tonumber(ARGV[2])
local n = redis.call('INCR', KEYS[1])
if ttl ~= nil and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end

local function read_floor()
  local raw = redis.call('GET', KEYS[2])
  if raw == false or raw == nil or raw == '' then return nil end
  return tonumber(raw)
end

local function write_floor(value)
  redis.call('SET', KEYS[2], value)
  if ttl ~= nil and ttl > 0 then
    redis.call('EXPIRE', KEYS[2], ttl)
  end
end

local function remember_success(limit)
  local seen = read_floor()
  if seen == -1 then return end
  if seen == nil or limit > seen then
    write_floor(limit)
  end
end

local limit_raw = ARGV[1]
if limit_raw == nil or limit_raw == false or limit_raw == '' then
  write_floor(-1)
  return {1, n}
end

local limit = tonumber(limit_raw)
if limit == nil or limit < 0 then
  redis.call('DECR', KEYS[1])
  return {-1, 0}
end

if n <= limit then
  remember_success(limit)
  return {1, n}
end

n = redis.call('DECR', KEYS[1])
local seen = read_floor()
if seen ~= -1 then
  local clamp_to = limit
  if seen ~= nil and seen > clamp_to then clamp_to = seen end
  if n > clamp_to then
    redis.call('SET', KEYS[1], clamp_to)
    if ttl ~= nil and ttl > 0 then
      redis.call('EXPIRE', KEYS[1], ttl)
    end
    n = clamp_to
  end
end
return {0, n}
`;

function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
  planDailyLimit?: number | null,
): Promise<QuotaReserved | QuotaRejected> {
  // `null` = unlimited: the counter still moves (metering is not optional) but
  // the rejection branch below is skipped entirely.
  const limit = resolveDailyLimit(planDailyLimit);
  const key = dailyCounterKey(userId);
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
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots
      // by 1, which is the cost-protection-correct direction.
    }
  };

  if (status === 1 && newCount >= 1) {
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
