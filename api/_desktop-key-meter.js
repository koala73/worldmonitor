// @ts-check
// Per-account desktop-key meter (plan 2026-10-25-001, KTD6 / R6).
//
// One counter per OWNER userId per UTC day plus one per-minute burst bucket,
// so an account's desktop-key traffic has a ceiling and a desktop key cannot
// serve as a backend for other applications. Keyed on the owner, not the key,
// matching the #3199 rule: two keys share one allowance, and revoking a key
// to mint another does not reset it.
//
// Decision-only, like api/_api-key-rate-limit.js: it never builds a Response
// and never reads an enforce flag. The caller injects the Redis pipeline, so
// the same module serves the edge gateway (server/_shared/redis.ts
// runRedisPipeline) and the self-contained bootstrap entry
// (api/_upstash-json.js redisPipeline), which lint:boundaries forbids from
// importing server/. The typed mirror is server/_shared/desktop-key-meter.ts.
//
// Unlike the #3199 daily meter this FAILS CLOSED: a Redis error is reported as
// `unavailable`, and both callers answer it with the existing
// rate-limit-degraded 503 (X-RateLimit-Mode: degraded, Retry-After: 5).

/**
 * Catalog ceilings (convex/config/productCatalog.ts). Duplicated rather than
 * imported: this plain-JS module is bundled into the bootstrap edge entry,
 * which must not pull the Convex config graph in — the same reasoning as
 * `SHARED_API_BUDGET` in api/mcp/quota.ts. tests/gateway-desktop-key.test.mts
 * pins both literals equal to the catalog.
 */
export const DESKTOP_KEY_DAILY_CEILING = 7_500;
export const DESKTOP_KEY_BURST_PER_MINUTE = 120;

/** 48 h: covers the UTC-midnight rollover plus an inspection window. */
export const DESKTOP_KEY_DAILY_TTL_SECONDS = 172_800;
/** Two minutes: the fixed minute window plus one of slack for clock skew. */
export const DESKTOP_KEY_MINUTE_TTL_SECONDS = 120;

const DAILY_KEY_PREFIX = 'rl:desktopkey:day:';
const MINUTE_KEY_PREFIX = 'rl:desktopkey:min:';

/**
 * Which numbers this owner is metered against. The plan's own limits win
 * when it sells desktop keys; an owner admitted through `apiAccess` instead
 * (R8 — a Pro subscriber who upgraded to an API plan) has `0` on both fields
 * and falls back to the catalog ceiling, never to "unlimited".
 *
 * @param {{ features?: { planLimits?: { desktopKeyRequestsPerDay?: unknown, desktopKeyBurstPerMinute?: unknown } } } | null | undefined} entitlement
 * @returns {{ dailyLimit: number, burstPerMinute: number }}
 */
export function resolveDesktopKeyLimits(entitlement) {
  const limits = entitlement?.features?.planLimits;
  return {
    dailyLimit: positiveInteger(limits?.desktopKeyRequestsPerDay) ?? DESKTOP_KEY_DAILY_CEILING,
    burstPerMinute: positiveInteger(limits?.desktopKeyBurstPerMinute) ?? DESKTOP_KEY_BURST_PER_MINUTE,
  };
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Plain (un-prefixed) daily key; the caller's pipeline applies the deployment
 * prefix. UTC calendar day so the meter resets at UTC midnight (AE5).
 * @param {string} userId
 * @param {Date} [date]
 */
export function desktopKeyDailyKey(userId, date) {
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${DAILY_KEY_PREFIX}${userId}:${yyyy}-${mm}-${dd}`;
}

/**
 * Fixed one-minute window keyed by epoch minute. A fixed window needs no Lua
 * and no TTL read, so one INCR/EXPIRE pipeline serves both counters and the
 * reset is computable from the clock alone.
 * @param {string} userId
 * @param {Date} [date]
 */
export function desktopKeyMinuteKey(userId, date) {
  const ms = (date ?? new Date()).getTime();
  return `${MINUTE_KEY_PREFIX}${userId}:${Math.floor(ms / 60_000)}`;
}

/** @param {Date} [now] */
export function secondsUntilUtcMidnight(now) {
  const d = now ?? new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return Math.max(1, Math.ceil((next.getTime() - d.getTime()) / 1000));
}

/** @param {Date} [now] */
export function secondsUntilNextMinute(now) {
  const ms = (now ?? new Date()).getTime();
  const next = (Math.floor(ms / 60_000) + 1) * 60_000;
  return Math.max(1, Math.ceil((next - ms) / 1000));
}

/**
 * @typedef {{ ok: true, dailyCount: number, minuteCount: number, rollback: () => Promise<void> }} DesktopBudgetAdmitted
 * @typedef {{ ok: false, limitType: 'daily' | 'per_minute', limit: number, retryAfterSec: number, resetMs: number }} DesktopBudgetRejected
 * @typedef {{ ok: null, reason: 'unavailable' }} DesktopBudgetUnavailable
 */

/**
 * Charge one request against the owner's daily ceiling and burst bucket.
 *
 * INCR-first (atomic, no check-then-increment race), mirroring
 * api/mcp/quota.ts and api/_api-key-rate-limit.js. A rejected request is
 * rolled back (DECR both keys) so a rejection never consumes allowance; an
 * admitted request keeps its increments unless the caller later rolls it
 * back (a downstream limiter rejecting the same request). Both failures are
 * reported with the seconds until their window resets: UTC midnight for the
 * day, the next minute boundary for the burst.
 *
 * @param {{
 *   userId: string,
 *   dailyLimit: number,
 *   burstPerMinute: number,
 *   pipeline: (commands: Array<Array<string | number>>) => Promise<Array<{ result?: unknown }> | null | undefined>,
 *   date?: Date,
 * }} opts
 * @returns {Promise<DesktopBudgetAdmitted | DesktopBudgetRejected | DesktopBudgetUnavailable>}
 */
export async function reserveDesktopKeyBudget(opts) {
  const { userId, dailyLimit, burstPerMinute, pipeline } = opts;
  const now = opts.date ?? new Date();
  const dayKey = desktopKeyDailyKey(userId, now);
  const minuteKey = desktopKeyMinuteKey(userId, now);
  /** @type {DesktopBudgetUnavailable} */
  const unavailable = { ok: null, reason: 'unavailable' };
  if (!userId) return unavailable;

  let result;
  try {
    result = await pipeline([
      ['INCR', dayKey],
      ['EXPIRE', dayKey, DESKTOP_KEY_DAILY_TTL_SECONDS],
      ['INCR', minuteKey],
      ['EXPIRE', minuteKey, DESKTOP_KEY_MINUTE_TTL_SECONDS],
    ]);
  } catch {
    result = null;
  }
  // Fail closed: runRedisPipeline returns [] on any failure and redisPipeline
  // returns null, so anything short of four results is "could not meter".
  if (!Array.isArray(result) || result.length < 4) return unavailable;
  const dailyCount = toCount(result[0]?.result);
  const minuteCount = toCount(result[2]?.result);
  if (dailyCount === null || minuteCount === null) return unavailable;

  let rolledBack = false;
  const rollback = async () => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', dayKey], ['DECR', minuteKey]]);
    } catch {
      // Best-effort: a failed DECR overshoots by one in the cost-protection
      // direction, exactly as the #3199 meter accepts.
    }
  };

  if (dailyCount > dailyLimit) {
    await rollback();
    const retryAfterSec = secondsUntilUtcMidnight(now);
    return { ok: false, limitType: 'daily', limit: dailyLimit, retryAfterSec, resetMs: now.getTime() + retryAfterSec * 1000 };
  }
  if (minuteCount > burstPerMinute) {
    await rollback();
    const retryAfterSec = secondsUntilNextMinute(now);
    return { ok: false, limitType: 'per_minute', limit: burstPerMinute, retryAfterSec, resetMs: now.getTime() + retryAfterSec * 1000 };
  }
  return { ok: true, dailyCount, minuteCount, rollback };
}

/** @param {unknown} raw */
function toCount(raw) {
  const count = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(count) && count >= 1 ? count : null;
}
