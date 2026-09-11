// Typed compatibility API for the shared JavaScript quota implementation.
import type { Ratelimit } from '@upstash/ratelimit';
// @ts-expect-error — JS module, no declaration file; typed API below.
import * as core from '../../api/_api-key-rate-limit.js';
export type BurstDecision =
  | { ok: true }
  | { ok: false; limit: number; reset: number };

export type RateLimitPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown }>>;

export interface MeterResult {
  /** Post-INCR count for this UTC day (0 when not metered). */
  count: number;
  /** True when count exceeded the sold daily allowance. */
  overLimit: boolean;
  /** False when Redis was unavailable (fail-open: serve uncounted). */
  metered: boolean;
  /** Seconds until UTC midnight — the daily 429 `Retry-After`. */
  retryAfterSec: number;
  /** Idempotent DECR rollback. The gateway calls this only when it actually
   *  rejects (enforce + overLimit); in shadow the request is served, so the
   *  increment stands and reflects true demand. */
  rollback: () => Promise<void>;
}

export const ENTERPRISE_API_RATE_LIMIT: 1000 = core.ENTERPRISE_API_RATE_LIMIT;
export const API_DAILY_TTL_SECONDS: 172800 = core.API_DAILY_TTL_SECONDS;
export const getBurstLimiter = core.getBurstLimiter as (perMinute: number) => Ratelimit | null;
export const checkBurst = core.checkBurst as (perMinute: number, identity: string) => Promise<BurstDecision>;
export const apiKeyDailyKey = core.apiKeyDailyKey as (userId: string, date?: Date) => string;
export const reserveDailyMeter = core.reserveDailyMeter as (opts: { userId: string; allowance: number; pipeline: RateLimitPipeline; date?: Date }) => Promise<MeterResult>;
export const rateLimitHeaders = core.rateLimitHeaders as (opts: { limit: number; remaining: number; resetMs: number; retryAfterSec: number; windowSec?: number }) => Record<string, string>;

export const secondsUntilUtcMidnight = core.secondsUntilUtcMidnight as (now?: Date) => number;
