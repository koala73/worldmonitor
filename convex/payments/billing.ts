/**
 * Billing queries and actions for subscription management.
 *
 * Provides:
 * - getSubscriptionForUser: public query for frontend status display
 * - getCustomerByUserId: internal query for portal session creation
 * - getActiveSubscription: internal query for plan change validation
 * - getCustomerPortalUrl: action to create a Dodo Customer Portal session
 * - changePlan: action to upgrade/downgrade subscription via Dodo SDK
 */

import { v } from "convex/values";
import { action, query, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";

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
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .first();

    if (!subscription) return null;

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
    return await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

/**
 * Internal query to retrieve the active subscription for a user.
 * Returns null if no subscription or if the subscription is cancelled/expired.
 */
export const getActiveSubscription = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .first();

    if (!subscription) return null;
    if (
      subscription.status === "cancelled" ||
      subscription.status === "expired"
    ) {
      return null;
    }

    return subscription;
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
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const customer = await ctx.runQuery(
      internal.payments.billing.getCustomerByUserId,
      { userId: args.userId },
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
    userId: v.string(),
    newProductId: v.string(),
    prorationMode: v.union(
      v.literal("prorated_immediately"),
      v.literal("full_immediately"),
      v.literal("difference_immediately"),
    ),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.runQuery(
      internal.payments.billing.getActiveSubscription,
      { userId: args.userId },
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
