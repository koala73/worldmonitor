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
import { internalAction, mutation, query, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";
import { resolveUserId, requireUserId } from "../lib/auth";
import { getFeaturesForPlan } from "../lib/entitlements";

// ---------------------------------------------------------------------------
// Shared SDK config (for direct API calls, not the Convex component)
// ---------------------------------------------------------------------------

function getDodoClient(): DodoPayments {
  const apiKey = process.env.DODO_API_KEY ?? process.env.DODO_PAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error("[billing] DODO_API_KEY not set — cannot call Dodo API");
  }
  const isLive = process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode";
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
    // Prefer auth identity when available; fall back to client-provided userId.
    // This pattern matches entitlements.ts/getEntitlementsForUser — both accept
    // userId as a public arg because the ConvexClient has no auth wired yet.
    // Once Clerk JWT is wired into ConvexClient.setAuth(), switch to requireUserId(ctx).
    const authedUserId = await resolveUserId(ctx);
    const userId = authedUserId ?? args.userId;

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
 * Internal action — not callable from the browser directly. The frontend
 * opens the fallback portal URL instead. Once Clerk auth is wired into
 * the ConvexClient, this can be promoted to a public action with
 * requireUserId(ctx) for auth gating.
 */
export const getCustomerPortalUrl = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const userId = args.userId;

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
 * Internal action — not callable from the browser directly. Plan changes
 * are delegated to the Dodo Customer Portal UI for now. Once Clerk auth
 * is wired into the ConvexClient, this can be promoted to a public action
 * with requireUserId(ctx) for auth gating.
 */
export const changePlan = internalAction({
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
    const userId = args.userId;

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

// ---------------------------------------------------------------------------
// Subscription claim (anon ID → authenticated user migration)
// ---------------------------------------------------------------------------

/**
 * Claims subscription, entitlement, and customer records from an anonymous
 * browser ID to the currently authenticated user.
 *
 * LIMITATION: Until Clerk auth is wired into the ConvexClient, anonymous
 * purchases are keyed to a `crypto.randomUUID()` stored in localStorage
 * (`wm-anon-id`). If the user clears storage, switches browsers, or later
 * creates a real account, there is no automatic way to link the purchase.
 *
 * This mutation provides the migration path: once authenticated, the client
 * calls claimSubscription(anonId) to reassign all payment records from the
 * anonymous ID to the real user ID.
 *
 * @see https://github.com/koala73/worldmonitor/issues/2078
 */
export const claimSubscription = mutation({
  args: { anonId: v.string() },
  handler: async (ctx, args) => {
    const realUserId = await requireUserId(ctx);

    // Reassign subscriptions
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.anonId))
      .collect();
    for (const sub of subs) {
      await ctx.db.patch(sub._id, { userId: realUserId });
    }

    // Reassign entitlements — compare by tier first, then validUntil
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.anonId))
      .unique();
    let winningPlanKey: string | null = null;
    let winningFeatures: ReturnType<typeof getFeaturesForPlan> | null = null;
    let winningValidUntil: number | null = null;
    if (entitlement) {
      const existingEntitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", realUserId))
        .unique();
      if (existingEntitlement) {
        // Compare by tier first, break ties with validUntil
        const anonTier = entitlement.features?.tier ?? 0;
        const existingTier = existingEntitlement.features?.tier ?? 0;
        const anonWins =
          anonTier > existingTier ||
          (anonTier === existingTier && entitlement.validUntil > existingEntitlement.validUntil);
        if (anonWins) {
          winningPlanKey = entitlement.planKey;
          winningFeatures = entitlement.features;
          winningValidUntil = entitlement.validUntil;
          await ctx.db.patch(existingEntitlement._id, {
            planKey: entitlement.planKey,
            features: entitlement.features,
            validUntil: entitlement.validUntil,
            updatedAt: Date.now(),
          });
        } else {
          winningPlanKey = existingEntitlement.planKey;
          winningFeatures = existingEntitlement.features;
          winningValidUntil = existingEntitlement.validUntil;
        }
        await ctx.db.delete(entitlement._id);
      } else {
        winningPlanKey = entitlement.planKey;
        winningFeatures = entitlement.features;
        winningValidUntil = entitlement.validUntil;
        await ctx.db.patch(entitlement._id, { userId: realUserId });
      }
    }

    // Reassign customer records
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_userId", (q) => q.eq("userId", args.anonId))
      .collect();
    for (const customer of customers) {
      await ctx.db.patch(customer._id, { userId: realUserId });
    }

    // Reassign payment events
    const payments = await ctx.db
      .query("paymentEvents")
      .withIndex("by_userId", (q) => q.eq("userId", args.anonId))
      .collect();
    for (const payment of payments) {
      await ctx.db.patch(payment._id, { userId: realUserId });
    }

    // Sync Redis cache: clear stale anon entry + write real user's entitlement
    if (process.env.UPSTASH_REDIS_REST_URL) {
      // Delete the anon ID's stale Redis cache entry
      await ctx.scheduler.runAfter(
        0,
        internal.payments.cacheActions.deleteEntitlementCache,
        { userId: args.anonId },
      );
      // Sync the real user's entitlement to Redis
      if (winningPlanKey && winningFeatures && winningValidUntil) {
        await ctx.scheduler.runAfter(
          0,
          internal.payments.cacheActions.syncEntitlementCache,
          {
            userId: realUserId,
            planKey: winningPlanKey,
            features: winningFeatures,
            validUntil: winningValidUntil,
          },
        );
      }
    }

    return {
      claimed: {
        subscriptions: subs.length,
        entitlements: entitlement ? 1 : 0,
        customers: customers.length,
        payments: payments.length,
      },
    };
  },
});
