// Per-account REST rate-limit layer for #3199 (Phase 1). Two limit types:
//
//   1. Per-minute burst  — infra/abuse protection. Hard limit; the gateway
//      returns 429 on violation (in enforce mode). Value from the catalog
//      `apiRateLimit` (user keys) or a hardcoded constant (enterprise).
//   2. Daily usage meter — the commercial "included allowance". Counts every
//      served request but NEVER rejects at the allowance. The only hard reject
//      on this axis is a safety ceiling at CEILING_MULTIPLIER × allowance.
//
// This module is decision-only: it never builds a Response and never reads the
// enforce flag — the gateway (the single chokepoint at server/gateway.ts:1034)
// owns enforce-vs-shadow, per-IP bypass, and Response construction. That keeps
// the burst/meter math unit-testable in isolation (inject the pipeline + date;
// stub this module's decisions in the gateway-wiring test).
//
// Patterns cloned: api/mcp/quota.ts (INCR-first meter + DECR rollback),
// api/_rate-limit.js (lazy Upstash singleton, NODE_TEST_CONTEXT retry skip,
// X-RateLimit-* header shape), server/_shared/pro-mcp-token.ts UTC helpers.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { getKeyPrefix } from './redis';
import { secondsUntilUtcMidnight } from './pro-mcp-token';

/** Hardcoded per-minute burst for enterprise env keys — they carry no Convex
 *  entitlement (gateway.ts:1006-1007 skips checkEntitlement), so this cannot
 *  be sourced from `features.apiRateLimit`. Mirrors ENTERPRISE_FEATURES. */
export const ENTERPRISE_API_RATE_LIMIT = 1000;

/** Safety ceiling = this × the included daily allowance. The allowance itself
 *  is metered (never rejects); the ceiling is pure runaway/cost protection. */
export const CEILING_MULTIPLIER = 10;

// One Redis client shared across every per-minute Ratelimit instance; one
// Ratelimit per distinct numeric limit (60, 300, 1000) cached in the Map so two
// Starter accounts share a limiter *config* but get separate buckets via the
// per-account identifier passed to `.limit()`.
let redisSingleton: Redis | null = null;
const burstLimiters = new Map<number, Ratelimit>();

function getRedis(): Redis | null {
  if (redisSingleton) return redisSingleton;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // Skip the @upstash/redis retry backoff under the node test runner so
  // fail-open tests pointed at a fake host degrade immediately; production
  // (env unset) keeps the resilient default. Mirrors api/_rate-limit.js.
  // `retry: false` must stay a literal (not a spread) or it widens to
  // `boolean` and fails tsconfig.api.json's RetryConfig type.
  redisSingleton = process.env.NODE_TEST_CONTEXT
    ? new Redis({ url, token, retry: false })
    : new Redis({ url, token });
  return redisSingleton;
}

/**
 * The per-minute burst limiter for `perMinute` requests / 60s, cached by limit.
 * Returns null when Upstash is not configured (caller fail-opens).
 */
export function getBurstLimiter(perMinute: number): Ratelimit | null {
  const existing = burstLimiters.get(perMinute);
  if (existing) return existing;
  const redis = getRedis();
  if (!redis) return null;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(perMinute, '60 s'),
    // Env-scope the prefix exactly like the daily meter (runRedisPipeline's
    // prefixKey) so a preview deployment sharing one Upstash database doesn't
    // consume/pollute the production burst namespace. Empty in production.
    prefix: `${getKeyPrefix()}rl:apikey:min`,
    analytics: false,
  });
  burstLimiters.set(perMinute, limiter);
  return limiter;
}

export type BurstDecision =
  | { ok: true }
  | { ok: false; limit: number; reset: number };

/**
 * Evaluate the per-minute burst window for `identity`. Fail-OPEN: a missing
 * Upstash config or any Redis error resolves to `{ ok: true }` so a paying
 * customer is never 429'd for our outage (mirrors api/_rate-limit.js).
 */
export async function checkBurst(perMinute: number, identity: string): Promise<BurstDecision> {
  const limiter = getBurstLimiter(perMinute);
  if (!limiter) return { ok: true };
  try {
    const { success, limit, reset } = await limiter.limit(identity);
    if (!success) return { ok: false, limit, reset };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Plain (un-prefixed) daily-meter key — `runRedisPipeline` applies the
 *  deployment/env prefix. UTC calendar day so the ceiling resets at midnight.
 *  `date` is injectable for deterministic tests. */
export function apiKeyDailyKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `rl:apikey:day:${userId}:${yyyy}-${mm}-${dd}`;
}

/** 48h TTL: covers UTC-midnight rollover + an inspection window. Mirrors
 *  PRO_DAILY_QUOTA_TTL_SECONDS. */
export const API_DAILY_TTL_SECONDS = 172_800;

/** Minimal pipeline contract — the subset of `runRedisPipeline` this module
 *  needs. The gateway passes `(cmds) => runRedisPipeline(cmds)`; tests inject a
 *  mock. Returns `[]` on failure (fail-open), never throws by contract. */
export type RateLimitPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown }>>;

export interface MeterResult {
  /** Post-INCR count for this UTC day (0 when not metered). */
  count: number;
  /** True when count exceeded CEILING_MULTIPLIER × allowance. */
  overCeiling: boolean;
  /** False when Redis was unavailable (fail-open: serve uncounted). */
  metered: boolean;
  /** Seconds until UTC midnight — the ceiling 429 `Retry-After`. */
  retryAfterSec: number;
  /** Idempotent DECR rollback. The gateway calls this only when it actually
   *  rejects (enforce + overCeiling); in shadow the request is served, so the
   *  increment stands and reflects true demand. */
  rollback: () => Promise<void>;
}

/**
 * Increment the per-account daily meter and report whether the safety ceiling
 * is now exceeded. INCR-first (atomic; no check-then-incr race), mirroring
 * api/mcp/quota.ts::reserveQuota.
 *
 * - `allowance < 0` (unlimited, e.g. enterprise) → no Redis call; never metered.
 * - Redis unavailable / pipeline failure → `metered:false`, `overCeiling:false`
 *   (fail-open: the gateway serves uncounted).
 */
export async function reserveDailyMeter(opts: {
  userId: string;
  allowance: number;
  pipeline: RateLimitPipeline;
  date?: Date;
}): Promise<MeterResult> {
  const { userId, allowance, pipeline, date } = opts;
  const noop = async (): Promise<void> => {};
  const retryAfterSec = secondsUntilUtcMidnight(date);

  // No daily limit: `-1` is unlimited (enterprise); `0` is a misconfiguration
  // (positive burst but zero allowance) that we fail OPEN on rather than
  // ceiling-429 every request (ceiling would be 0×10 = 0, so request #1 trips).
  // Callers already gate eligibility on apiRateLimit > 0, so this is defensive.
  if (allowance <= 0) {
    return { count: 0, overCeiling: false, metered: false, retryAfterSec, rollback: noop };
  }

  const key = apiKeyDailyKey(userId, date);
  if (!key) {
    return { count: 0, overCeiling: false, metered: false, retryAfterSec, rollback: noop };
  }

  let pipeResult: Array<{ result?: unknown }> | null;
  try {
    pipeResult = await pipeline([
      ['INCR', key],
      ['EXPIRE', key, API_DAILY_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  // Fail-open: couldn't meter → serve uncounted (never punish a paying
  // customer for our Redis outage).
  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    return { count: 0, overCeiling: false, metered: false, retryAfterSec, rollback: noop };
  }

  const incrRaw = pipeResult[0]?.result;
  const count = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(count) || count < 1) {
    return { count: 0, overCeiling: false, metered: false, retryAfterSec, rollback: noop };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a failed DECR overshoots the meter by 1, the
      // cost-protection-correct direction.
    }
  };

  const ceiling = allowance * CEILING_MULTIPLIER;
  return { count, overCeiling: count > ceiling, metered: true, retryAfterSec, rollback };
}

/**
 * Standard rate-limit response headers for a 429. Emits the IETF RateLimit
 * fields (draft-ietf-httpapi-ratelimit-headers) — RateLimit-Policy advertises
 * the quota/window, the combined RateLimit member carries live remaining +
 * delta-seconds reset — alongside the legacy X-RateLimit-* set for back-compat,
 * so customers get a uniform self-throttle contract across the per-IP and
 * per-account limiters. Mirrors api/_rate-limit.js. The gateway merges these
 * with corsHeaders.
 *
 * `resetMs` is a Unix epoch in MILLISECONDS; the IETF reset (`t` /
 * RateLimit-Reset) is delta-SECONDS, so it is derived here. `windowSec` is the
 * policy window in seconds (defaults to the 60 s burst window).
 */
export function rateLimitHeaders(opts: {
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterSec: number;
  windowSec?: number;
}): Record<string, string> {
  const remaining = Math.max(0, opts.remaining);
  const resetSeconds = Math.max(0, Math.ceil((opts.resetMs - Date.now()) / 1000));
  const windowSec = opts.windowSec ?? 60;
  return {
    // IETF RateLimit fields.
    'RateLimit-Policy': `"default";q=${opts.limit};w=${windowSec}`,
    'RateLimit-Limit': String(opts.limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetSeconds),
    RateLimit: `"default";r=${remaining};t=${resetSeconds}`,
    // Legacy X-RateLimit-* retained for back-compat (Reset is epoch-ms).
    'X-RateLimit-Limit': String(opts.limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(opts.resetMs),
    'Retry-After': String(Math.max(1, opts.retryAfterSec)),
  };
}
