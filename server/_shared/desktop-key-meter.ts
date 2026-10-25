// Typed compatibility API for the shared JavaScript desktop-key meter
// (plan 2026-10-25-001, KTD6). Same pairing as api-key-rate-limit.ts over
// api/_api-key-rate-limit.js: the decision logic lives once, in plain JS the
// bootstrap edge entry can also import.
// @ts-expect-error — JS module, no declaration file; typed API below.
import * as core from '../../api/_desktop-key-meter.js';
import type { RateLimitPipeline } from './api-key-rate-limit.js';

export type DesktopBudgetDecision =
  | { ok: true; dailyCount: number; minuteCount: number; rollback: () => Promise<void> }
  | { ok: false; limitType: 'daily' | 'per_minute'; limit: number; retryAfterSec: number; resetMs: number }
  | { ok: null; reason: 'unavailable' };

export interface DesktopKeyLimits {
  dailyLimit: number;
  burstPerMinute: number;
}

export const DESKTOP_KEY_DAILY_CEILING: 7_500 = core.DESKTOP_KEY_DAILY_CEILING;
export const DESKTOP_KEY_BURST_PER_MINUTE: 120 = core.DESKTOP_KEY_BURST_PER_MINUTE;
export const resolveDesktopKeyLimits = core.resolveDesktopKeyLimits as (
  entitlement: { features?: { planLimits?: { desktopKeyRequestsPerDay?: unknown; desktopKeyBurstPerMinute?: unknown } } } | null | undefined,
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
