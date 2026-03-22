/**
 * Billing queries and actions for subscription management.
 *
 * Provides:
 * - getSubscriptionForUser: authenticated query for frontend status display
 * - getCustomerByUserId: internal query for portal session creation
 * - getActiveSubscription: internal query for plan change validation
 * - getCustomerPortalUrl: authenticated action to create a Dodo Customer Portal session
 * - changePlan: authenticated action to upgrade/downgrade subscription via Dodo SDK
 */

import { v } from "convex/values";
import { action, query, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";
import { resolveUserId } from "../lib/auth";

// ---------------------------------------------------------------------------
// Shared SDK config (for direct API calls, not the Convex component)
// ---------------------------------------------------------------------------

const apiKey = process.env.DODO_API_KEY ?? process.env.DODO_PAYMENTS_API_KEY;
const isLive = process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode";

function getDodoClient(): DodoPayments {
  if (!apiKey) {
    throw new Error("[billing] DODO_API_KEY not set — cannot call Dodo API");
  }
  return new DodoPayments({
    bearerToken: apiKey,
    ...(isLive ? {} : { environment: "test_mode" as const }),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the most recent subscription for a given user, enriched with
 * the plan's display name from the productPlans table.
 *
 * Used by the frontend billing UI to show current plan status.
 */
export const getSubscriptionForUser = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Auth: derive userId from authenticated session; accept client hint only as fallback
    const authedUserId = await resolveUserId(ctx);
    const userId = authedUserId ?? args.userId;
    if (!userId) return null;

    // Fetch all subscriptions for user and prefer active/on_hold over cancelled/expired.
    // Avoids the bug where a cancelled sub created after an active one hides the active one.
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    if (allSubs.length === 0) return null;

    const priorityOrder = ["active", "on_hold", "cancelled", "expired"];
    allSubs.sort((a, b) => {
      const pa = priorityOrder.indexOf(a.status);
      const pb = priorityOrder.indexOf(b.status);
      if (pa !== pb) return pa - pb; // active first
      return b.updatedAt - a.updatedAt; // then most recently updated
    });

    // Safe: we checked length > 0 above
    const subscription = allSubs[0]!;

    // Look up display name from productPlans
    const productPlan = await ctx.db
      .query("productPlans")
      .withIndex("by_planKey", (q) => q.eq("planKey", subscription.planKey))
      .first();

    return {
      planKey: subscription.planKey,
      displayName: productPlan?.displayName ?? subscription.planKey,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      dodoSubscriptionId: subscription.dodoSubscriptionId,
      dodoProductId: subscription.dodoProductId,
    };
  },
});

/**
 * Internal query to retrieve a customer record by userId.
 * Used by getCustomerPortalUrl to find the dodoCustomerId.
 */
export const getCustomerByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Use .first() instead of .unique() — defensive against duplicate customer rows
    return await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

/**
 * Internal query to retrieve the active subscription for a user.
 * Returns null if no subscription or if the subscription is cancelled/expired.
 */
export const getActiveSubscription = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Find an active subscription (not cancelled, expired, or on_hold).
    // on_hold subs have failed payment — don't allow plan changes on them.
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();

    const activeSub = allSubs.find((s) => s.status === "active");
    return activeSub ?? null;
  },
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Creates a Dodo Customer Portal session and returns the portal URL.
 *
 * The portal allows customers to manage billing details, payment methods,
 * and view invoices directly through Dodo's hosted UI.
 */
export const getCustomerPortalUrl = action({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Auth: derive userId from authenticated session; accept client hint only as fallback
    const authedUserId = await resolveUserId(ctx);
    const userId = authedUserId ?? args.userId;
    if (!userId) {
      throw new Error("Authentication required");
    }

    const customer = await ctx.runQuery(
      internal.payments.billing.getCustomerByUserId,
      { userId },
    );

    if (!customer || !customer.dodoCustomerId) {
      throw new Error("No Dodo customer found for this user");
    }

    const client = getDodoClient();
    const session = await client.customers.customerPortal.create(
      customer.dodoCustomerId,
      { send_email: false },
    );

    return { portal_url: session.link };
  },
});

/**
 * Changes the subscription plan for a user (upgrade or downgrade).
 *
 * Uses the direct Dodo SDK to call changePlan. The webhook
 * (subscription.plan_changed) will update Convex state and recompute
 * entitlements asynchronously.
 */
export const changePlan = action({
  args: {
    userId: v.optional(v.string()),
    newProductId: v.string(),
    prorationMode: v.union(
      v.literal("prorated_immediately"),
      v.literal("full_immediately"),
      v.literal("difference_immediately"),
    ),
  },
  handler: async (ctx, args) => {
    // Auth: derive userId from authenticated session; accept client hint only as fallback
    const authedUserId = await resolveUserId(ctx);
    const userId = authedUserId ?? args.userId;
    if (!userId) {
      throw new Error("Authentication required");
    }

    const subscription = await ctx.runQuery(
      internal.payments.billing.getActiveSubscription,
      { userId },
    );

    if (!subscription) {
      throw new Error("No active subscription found");
    }

    const client = getDodoClient();
    await client.subscriptions.changePlan(subscription.dodoSubscriptionId, {
      product_id: args.newProductId,
      quantity: 1,
      proration_billing_mode: args.prorationMode,
    });

    return { success: true };
  },
});
