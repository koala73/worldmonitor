/**
 * One row per Dodo checkout session we hand a buyer.
 *
 * The funnel step between "clicked upgrade" (Umami `checkout-start`) and
 * "tried to pay" (a Dodo payment row) had no durable record: Dodo creates a
 * subscription only on a payment attempt, and `/api/create-checkout` request
 * logs keep one day. These rows count buyers who reached the Dodo form, and
 * `sessionId` joins them to Dodo payments by `checkout_session_id`.
 *
 * Keyed by account so account deletion removes them; older rows self-prune.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { isAccountDeleting } from "../accountDeletion/guard";

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHECKOUT_SESSION_EVENT_RETENTION_MS = 90 * DAY_MS;

/** Deletes per insert. Bounded so one mutation cannot blow the write limit. */
export const CHECKOUT_SESSION_EVENT_PRUNE_BATCH = 50;

/** Read cap for one count; a day's sessions are two orders of magnitude below it. */
export const CHECKOUT_SESSION_COUNT_SCAN_LIMIT = 5_000;

export const recordCheckoutSessionCreated = internalMutation({
  args: {
    userId: v.string(),
    productId: v.string(),
    sessionId: v.optional(v.string()),
    anonymous: v.boolean(),
    occurredAt: v.number(),
  },
  handler: async (ctx, args) => {
    // A deletion that began after admission must not get a row back.
    if (await isAccountDeleting(ctx, args.userId)) return;
    await ctx.db.insert("checkoutSessionEvents", args);
    const expired = await ctx.db
      .query("checkoutSessionEvents")
      .withIndex("by_occurredAt", (q) =>
        q.lt("occurredAt", args.occurredAt - CHECKOUT_SESSION_EVENT_RETENTION_MS),
      )
      .take(CHECKOUT_SESSION_EVENT_PRUNE_BATCH);
    for (const row of expired) await ctx.db.delete(row._id);
  },
});

/** Never fails the checkout: the buyer already has a live session to pay on. */
export async function recordCreatedCheckoutSession(
  ctx: ActionCtx,
  args: { userId: string; productId: string; sessionId?: string; anonymous: boolean },
): Promise<void> {
  try {
    await ctx.runMutation(
      internal.payments.checkoutSessionLog.recordCheckoutSessionCreated,
      { ...args, occurredAt: Date.now() },
    );
  } catch (err) {
    // sentry-coverage-ok: Convex forwards this failed durable write to Sentry.
    console.error(
      `[checkout-session-log] failed to record created session user=${args.userId}: ${String(err)}`,
    );
  }
}

/**
 * Sessions created in [sinceMs, untilMs). Run with
 * `npx convex run payments/checkoutSessionLog:countCheckoutSessions '{"sinceMs":…,"untilMs":…}'`.
 */
export const countCheckoutSessions = internalQuery({
  args: { sinceMs: v.number(), untilMs: v.number() },
  handler: async (ctx, { sinceMs, untilMs }) => {
    const rows = await ctx.db
      .query("checkoutSessionEvents")
      .withIndex("by_occurredAt", (q) => q.gte("occurredAt", sinceMs).lt("occurredAt", untilMs))
      .take(CHECKOUT_SESSION_COUNT_SCAN_LIMIT);
    const signedIn = rows.filter((r) => !r.anonymous);
    return {
      sessions: rows.length,
      accounts: new Set(rows.map((r) => r.userId)).size,
      signedInSessions: signedIn.length,
      signedInAccounts: new Set(signedIn.map((r) => r.userId)).size,
      truncated: rows.length === CHECKOUT_SESSION_COUNT_SCAN_LIMIT,
    };
  },
});
