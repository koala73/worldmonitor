// Typed compatibility API for the shared JavaScript desktop-key meter
// (plan 2026-10-25-001, KTD6). Same pairing as api-key-rate-limit.ts over
// api/_api-key-rate-limit.js: the decision logic lives once, in plain JS the
// bootstrap edge entry can also import.
// @ts-expect-error — JS module, no declaration file; typed API below.
import * as core from '../../api/_desktop-key-meter.js';
import type { RateLimitPipeline } from './api-key-rate-limit.js';

export type DesktopBudgetAdmitted = { ok: true; dailyCount: number; minuteCount: number; rollback: () => Promise<void> };

export type DesktopBudgetDecision =
  | DesktopBudgetAdmitted
  | { ok: false; limitType: 'daily' | 'per_minute'; limit: number; retryAfterSec: number; resetMs: number }
  | { ok: null; reason: 'unavailable' };

/**
 * A refusal rendered with the shared contract: the 429 for either limit or the
 * degraded 503. `headers` already carry `Cache-Control: no-store` and the
 * rate-limit or degraded markers; callers add CORS and `Content-Type`.
 */
export interface DesktopBudgetDenial {
  ok: false;
  status: 429 | 503;
  reason: 'daily' | 'per_minute' | 'unavailable';
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface DesktopKeyLimits {
  dailyLimit: number;
  burstPerMinute: number;
}

/** The subset of an entitlement the meter reads: plan name and the sold limits. */
export type DesktopKeyMeterEntitlement = {
  planKey?: string;
  features?: { planLimits?: { desktopKeyRequestsPerDay?: unknown; desktopKeyBurstPerMinute?: unknown } };
} | null | undefined;

export const DESKTOP_KEY_DAILY_CEILING: 7_500 = core.DESKTOP_KEY_DAILY_CEILING;
export const DESKTOP_KEY_BURST_PER_MINUTE: 120 = core.DESKTOP_KEY_BURST_PER_MINUTE;
export const DESKTOP_KEY_METER_UNAVAILABLE_ERROR: 'Rate-limit service temporarily unavailable' = core.DESKTOP_KEY_METER_UNAVAILABLE_ERROR;
export const DESKTOP_KEY_DAILY_LIMIT_ERROR: 'Daily request limit reached' = core.DESKTOP_KEY_DAILY_LIMIT_ERROR;
export const DESKTOP_KEY_BURST_LIMIT_ERROR: 'Too many requests' = core.DESKTOP_KEY_BURST_LIMIT_ERROR;
export const resolveDesktopKeyLimits = core.resolveDesktopKeyLimits as (
  entitlement: DesktopKeyMeterEntitlement,
) => DesktopKeyLimits;
export const desktopKeyDailyKey = core.desktopKeyDailyKey as (userId: string, date?: Date) => string;
export const desktopKeyMinuteKey = core.desktopKeyMinuteKey as (userId: string, date?: Date) => string;
export const reserveDesktopKeyBudget = core.reserveDesktopKeyBudget as (opts: {
  userId: string;
  dailyLimit: number;
  burstPerMinute: number;
  pipeline: RateLimitPipeline;
  date?: Date;
}) => Promise<DesktopBudgetDecision>;
export const desktopKeyBudgetDenial = core.desktopKeyBudgetDenial as (
  decision: Exclude<DesktopBudgetDecision, { ok: true }>,
  planKey: string | undefined,
) => DesktopBudgetDenial;
/**
 * The whole per-request meter step for a desktop principal: resolve the
 * owner's limits, charge both counters, and render a refusal with the shared
 * 429 / 503 contract. Every surface that admits a desktop principal calls this.
 */
export const chargeDesktopKeyBudget = core.chargeDesktopKeyBudget as (opts: {
  userId: string;
  entitlement: DesktopKeyMeterEntitlement;
  pipeline: RateLimitPipeline;
  date?: Date;
}) => Promise<DesktopBudgetAdmitted | DesktopBudgetDenial>;

/** A `Response` for a denial, for the TypeScript edges that build their own. */
export function desktopKeyBudgetResponse(denial: DesktopBudgetDenial, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(denial.body), {
    status: denial.status,
    headers: { 'Content-Type': 'application/json', ...denial.headers, ...corsHeaders },
  });
}
