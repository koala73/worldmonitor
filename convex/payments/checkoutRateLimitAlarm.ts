/**
 * Rate alarm for terminal checkout 429s (#6698).
 *
 * #6027 built the bounded provider-retry ladder in `checkoutRateLimit.ts`.
 * This module watches its TAIL: the checkouts where the ladder ran, was
 * exhausted, and Dodo was still limiting the shared `DODO_API_KEY`, so the
 * buyer got a terminal `429 CHECKOUT_RATE_LIMITED`. Each of those is a
 * paying-intent click that ends in a manual retry.
 *
 * Why the signal is recorded server-side rather than read out of Sentry:
 * the browser event (`WORLDMONITOR-Y1`, level `info`) is emitted by the
 * client SDK after the fetch resolves, so it is subject to ad-blocking,
 * client sampling and project inbound filters, and it pages nobody. The
 * Convex action is the single choke point BOTH entry points funnel through
 * (`createCheckout` and the relay's `internalCreateCheckout`), so counting
 * here cannot miss an occurrence the buyer actually experienced.
 *
 * Shape: one row per terminal 429, evaluated on insert against a rolling
 * 24h burst threshold and a rolling 7d drift threshold. Crossing either one
 * emits a structured `console.error`, which Convex auto-Sentry forwards as an
 * error-level event — the same ops channel `reportDodoWebhookFailure` and the
 * refund alert already use. Below threshold the row is recorded silently, so
 * today's ~0.5/day floor never pages.
 *
 * Thresholds, their false-alarm rates, and the named owner are documented in
 * `docs/payments-checkout-rate-limit-operations.md`. Change them there too.
 *
 * Known bound: recording reads a bounded range of the `by_occurredAt` index in
 * the same transaction as its insert, so two terminal 429s landing at the same
 * instant contend on OCC and Convex retries them. At the observed rate
 * (~0.5/day) that never happens, and if a storm ever exhausts the retries the
 * caller's fail-open wrapper reports the dropped write as its own ops signal —
 * the alarm degrades loudly, not silently.
 */

import { v } from "convex/values";
import { internalMutation, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Burst window — "how bad is it right now". */
export const CHECKOUT_RATE_LIMIT_ALARM_DAY_WINDOW_MS = DAY_MS;

/** Drift window — "has the floor moved" (the issue's per-week ask). */
export const CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS = 7 * DAY_MS;

/**
 * Thresholds are sized against the observed floor, NOT against a test
 * fixture: 7 terminal 429s over 2026-08-01 -> 2026-08-13 is ~0.54/day and
 * ~3.8/week. Treating arrivals as Poisson at that rate, `>= 5 in 24h` is a
 * ~1-in-11-year false alarm and `>= 12 in 7d` is a ~1-in-35-year one, while a
 * 3x sustained rise pages in ~2 weeks and a 10x launch spike inside ~2 days.
 * The full sensitivity table is in the ops doc.
 */
export const CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD = 5;
export const CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD = 12;

/**
 * Minimum gap between two ops signals. A sustained storm keeps crossing the
 * threshold on every subsequent checkout; without this each buyer would emit
 * their own `console.error`. 6h keeps a live incident visible (4 events/day)
 * without turning one outage into an inbox.
 */
export const CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS = 6 * HOUR_MS;

/**
 * Rows older than this are deleted on insert. Strictly LONGER than the week
 * window so pruning can never remove a row the drift count still needs — a
 * retention equal to the window would silently shrink `weekCount` at the
 * boundary and make the drift alarm quietly unreachable.
 */
export const CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS =
  CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS + DAY_MS;

/**
 * Hard cap on rows read per evaluation, newest first. Far above both
 * thresholds, so truncation can only ever UNDERSTATE a count that is already
 * an order of magnitude past firing — it can delay nothing that the day
 * threshold has not already caught.
 */
export const CHECKOUT_RATE_LIMIT_ALARM_SCAN_LIMIT = 500;

/** Deletes per insert. Bounded so one mutation cannot blow the write limit. */
export const CHECKOUT_RATE_LIMIT_EVENT_PRUNE_BATCH = 50;

export interface CheckoutRateLimitOccurrence {
  occurredAt: number;
  /** Set on the row whose insert emitted an ops signal. */
  alertedAt?: number;
}

export type CheckoutRateLimitAlarmVerdict =
  | {
      kind: "alert";
      dayCount: number;
      weekCount: number;
      breachedWindows: ("day" | "week")[];
    }
  | {
      kind: "cooldown";
      dayCount: number;
      weekCount: number;
      nextEligibleAt: number;
    }
  | { kind: "below-threshold"; dayCount: number; weekCount: number };

/**
 * Pure classifier for the alarm branch, exported for unit tests.
 *
 * `occurrences` must already include the occurrence being recorded — the
 * verdict describes the state AFTER this terminal 429, which is what the
 * operator reading the Sentry event needs.
 *
 * The cooldown clock is derived from the `alertedAt` stamps carried by the
 * occurrences themselves rather than a separate singleton document, so there
 * is no pre-seeded state row whose absence could silently disarm the alarm.
 */
export function classifyCheckoutRateLimitAlarm(input: {
  occurrences: readonly CheckoutRateLimitOccurrence[];
  now: number;
}): CheckoutRateLimitAlarmVerdict {
  const dayFloor = input.now - CHECKOUT_RATE_LIMIT_ALARM_DAY_WINDOW_MS;
  const weekFloor = input.now - CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS;
  let dayCount = 0;
  let weekCount = 0;
  let lastAlertAt: number | null = null;
  for (const occurrence of input.occurrences) {
    // Inclusive at the floor: an occurrence exactly one window old still
    // counts. Undercounting is the failure mode that makes an alarm silent,
    // so the boundary resolves toward firing.
    if (occurrence.occurredAt >= dayFloor) dayCount += 1;
    if (occurrence.occurredAt >= weekFloor) weekCount += 1;
    if (
      typeof occurrence.alertedAt === "number" &&
      (lastAlertAt === null || occurrence.alertedAt > lastAlertAt)
    ) {
      lastAlertAt = occurrence.alertedAt;
    }
  }

  const breachedWindows: ("day" | "week")[] = [];
  if (dayCount >= CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD) breachedWindows.push("day");
  if (weekCount >= CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD) breachedWindows.push("week");
  if (breachedWindows.length === 0) {
    return { kind: "below-threshold", dayCount, weekCount };
  }

  // `lastAlertAt === null` is the never-alerted state and MUST fire. Defaulting
  // it to `now` (or to the newest occurrence) would put the very first breach
  // inside its own cooldown and the alarm would never speak.
  if (
    lastAlertAt !== null &&
    input.now - lastAlertAt < CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS
  ) {
    return {
      kind: "cooldown",
      dayCount,
      weekCount,
      nextEligibleAt: lastAlertAt + CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS,
    };
  }
  return { kind: "alert", dayCount, weekCount, breachedWindows };
}

/**
 * Records one terminal `CHECKOUT_RATE_LIMITED` and pages when the rate
 * crosses either window's threshold.
 *
 * Internal-only: the caller is the checkout action, which has already proven
 * the outcome came from an exhausted provider ladder. Nothing user-supplied
 * decides whether a row is written.
 */
export const recordCheckoutRateLimited = internalMutation({
  args: {
    userId: v.string(),
    productId: v.string(),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    const inserted = await ctx.db.insert("checkoutRateLimitEvents", {
      userId: args.userId,
      productId: args.productId,
      occurredAt: args.occurredAt,
    });

    // Read newest-first so a truncated scan keeps the most recent occurrences,
    // which are the ones both windows are measured over.
    const occurrences = await ctx.db
      .query("checkoutRateLimitEvents")
      .withIndex("by_occurredAt")
      .order("desc")
      .take(CHECKOUT_RATE_LIMIT_ALARM_SCAN_LIMIT);

    const verdict = classifyCheckoutRateLimitAlarm({
      occurrences,
      now: args.occurredAt,
    });

    if (verdict.kind === "alert") {
      await ctx.db.patch(inserted, { alertedAt: args.occurredAt });
      // sentry-coverage-ok: this console.error IS the deliverable. Convex
      // auto-Sentry forwards it as an error-level event; the message prefix is
      // held stable so every breach lands in one Sentry issue rather than
      // minting a new one per count.
      console.error(
        `[checkout-rate-limit-alarm] terminal CHECKOUT_RATE_LIMITED rate breached ` +
          `(day=${verdict.dayCount}/${CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD} in 24h, ` +
          `week=${verdict.weekCount}/${CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD} in 7d, ` +
          `windows=${verdict.breachedWindows.join("+")}, ` +
          `latestUserId=${args.userId}, latestProductId=${args.productId}). ` +
          `Dodo is limiting the shared DODO_API_KEY past the #6027 bounded ladder; ` +
          `buyers are being told to retry by hand. Runbook: ` +
          `docs/payments-checkout-rate-limit-operations.md`,
      );
    }

    // Prune AFTER evaluating, so a retention pass can never shrink the count
    // that decided this verdict.
    const expired = await ctx.db
      .query("checkoutRateLimitEvents")
      .withIndex("by_occurredAt", (q) =>
        q.lt("occurredAt", args.occurredAt - CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS),
      )
      .take(CHECKOUT_RATE_LIMIT_EVENT_PRUNE_BATCH);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    return verdict;
  },
});

/**
 * Fail-open recorder for the checkout action.
 *
 * The buyer already has a typed outcome and a retry hint; a degraded alarm
 * must never turn that into a hard checkout failure. But a swallowed write
 * would leave the alarm permanently silent with nothing to show for it, so
 * the failure path emits its own ops signal — a broken alarm alarms.
 */
export async function recordTerminalCheckoutRateLimit(
  ctx: ActionCtx,
  args: { userId: string; productId: string },
): Promise<void> {
  try {
    await ctx.runMutation(
      internal.payments.checkoutRateLimitAlarm.recordCheckoutRateLimited,
      { ...args, occurredAt: Date.now() },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // sentry-coverage-ok: the console.error below IS the Sentry report. It is
    // deliberately not rethrown — see the doc comment above.
    console.error(
      `[checkout-rate-limit-alarm] failed to record terminal CHECKOUT_RATE_LIMITED ` +
        `for user=${args.userId} product=${args.productId}; the rate alarm is blind ` +
        `until this recovers: ${msg}`,
    );
  }
}
