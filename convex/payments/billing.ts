/**
 * Billing queries and actions for subscription management.
 *
 * Provides:
 * - getSubscriptionForUser: authenticated query for frontend status display
 * - getCustomerByUserId: internal query for portal session creation
 * - getActiveSubscription: internal query for plan change validation
 * - getCustomerPortalUrl: authenticated action to create a Dodo Customer Portal session
 * - claimSubscription: mutation to migrate entitlements from anon ID to authed user
 */

import { v } from "convex/values";
import { action, mutation, query, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { DodoPayments } from "dodopayments";
import { resolveUserId, requireUserId } from "../lib/auth";
import { getFeaturesForPlan } from "../lib/entitlements";

// UUID v4 regex matching values produced by crypto.randomUUID() in user-identity.ts.
// Hoisted to module scope to avoid re-allocation on every claimSubscription call.
const ANON_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Shared SDK config (direct REST SDK, not the Convex component from lib/dodo.ts)
// ---------------------------------------------------------------------------

/**
 * Returns a direct DodoPayments REST SDK client.
 *
 * This uses the "dodopayments" npm package (REST SDK) for API calls
 * such as customer portal creation and plan changes. It is distinct from
 * the @dodopayments/convex component SDK in lib/dodo.ts, which handles
 * checkout and webhook verification.
 *
 * Canonical env var: DODO_API_KEY.
 */
function getDodoClient(): DodoPayments {
  const apiKey = process.env.DODO_API_KEY;
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
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (!userId) {
      return null;
    }

    // Fetch all subscriptions for user and prefer active/on_hold over cancelled/expired.
    // Avoids the bug where a cancelled sub created after an active one hides the active one.
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(50);

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
      .take(50);

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
 * Public action callable from the browser. Auth-gated via requireUserId(ctx).
 */
export const getCustomerPortalUrl = action({
  args: {},
  handler: async (ctx, _args) => {
    const userId = await requireUserId(ctx);

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

    // Validate anonId is a UUID v4 (format produced by crypto.randomUUID() in user-identity.ts).
    // Rejects injected Clerk IDs ("user_xxx") which are structurally distinct from UUID v4,
    // preventing cross-user subscription theft via localStorage injection.
    if (!ANON_ID_REGEX.test(args.anonId) || args.anonId === realUserId) {
      return { claimed: { subscriptions: 0, entitlements: 0, customers: 0, payments: 0 } };
    }

    // Parallel reads for all anonId data — bounded to prevent runaway memory
    const [subs, anonEntitlement, customers, payments] = await Promise.all([
      ctx.db.query("subscriptions").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(50),
      ctx.db.query("entitlements").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).first(),
      ctx.db.query("customers").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(10),
      ctx.db.query("paymentEvents").withIndex("by_userId", (q) => q.eq("userId", args.anonId)).take(1000),
    ]);

    // Reassign subscriptions
    for (const sub of subs) {
      await ctx.db.patch(sub._id, { userId: realUserId });
    }

    // Reassign entitlements — compare by tier first, then validUntil
    // Use .first() instead of .unique() to avoid throwing on duplicate rows
    let winningPlanKey: string | null = null;
    let winningFeatures: ReturnType<typeof getFeaturesForPlan> | null = null;
    let winningValidUntil: number | null = null;
    if (anonEntitlement) {
      const existingEntitlement = await ctx.db
        .query("entitlements")
        .withIndex("by_userId", (q) => q.eq("userId", realUserId))
        .first();
      if (existingEntitlement) {
        // Compare by tier first, break ties with validUntil
        const anonTier = anonEntitlement.features?.tier ?? 0;
        const existingTier = existingEntitlement.features?.tier ?? 0;
        const anonWins =
          anonTier > existingTier ||
          (anonTier === existingTier && anonEntitlement.validUntil > existingEntitlement.validUntil);
        if (anonWins) {
          winningPlanKey = anonEntitlement.planKey;
          winningFeatures = anonEntitlement.features;
          winningValidUntil = anonEntitlement.validUntil;
          await ctx.db.patch(existingEntitlement._id, {
            planKey: anonEntitlement.planKey,
            features: anonEntitlement.features,
            validUntil: anonEntitlement.validUntil,
            updatedAt: Date.now(),
          });
        } else {
          winningPlanKey = existingEntitlement.planKey;
          winningFeatures = existingEntitlement.features;
          winningValidUntil = existingEntitlement.validUntil;
        }
        await ctx.db.delete(anonEntitlement._id);
      } else {
        winningPlanKey = anonEntitlement.planKey;
        winningFeatures = anonEntitlement.features;
        winningValidUntil = anonEntitlement.validUntil;
        await ctx.db.patch(anonEntitlement._id, { userId: realUserId });
      }
    }

    // Reassign customer records
    for (const customer of customers) {
      await ctx.db.patch(customer._id, { userId: realUserId });
    }

    // Reassign payment events — bounded to prevent runaway memory on pathological sessions
    // (already fetched above in the parallel Promise.all)
    for (const payment of payments) {
      await ctx.db.patch(payment._id, { userId: realUserId });
    }

    // ACCEPTED BOUND: cache sync runs after mutation commits. Stale cache
    // survives up to ENTITLEMENT_CACHE_TTL_SECONDS (900s) if scheduler fails.
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
        entitlements: anonEntitlement ? 1 : 0,
        customers: customers.length,
        payments: payments.length,
      },
    };
  },
});
