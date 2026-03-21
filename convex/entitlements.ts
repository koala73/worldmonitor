/**
 * Public entitlement queries for frontend subscriptions and gateway fallback.
 *
 * Returns the user's entitlements with free-tier defaults for unknown or
 * expired users. Used by:
 *   - Frontend ConvexClient subscription for reactive panel gating
 *   - Gateway ConvexHttpClient as cache-miss fallback
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import { getFeaturesForPlan } from "./lib/entitlements";

const FREE_TIER_DEFAULTS = {
  planKey: "free" as const,
  features: getFeaturesForPlan("free"),
  validUntil: 0,
};

/**
 * Returns the entitlements for a given userId.
 *
 * - No row found -> free-tier defaults
 * - Row found but validUntil < now -> free-tier defaults (expired)
 * - Row found and valid -> actual entitlements
 */
export const getEntitlementsForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (!entitlement) {
      return FREE_TIER_DEFAULTS;
    }

    // Expired entitlements fall back to free tier (Pitfall 7 from research)
    if (entitlement.validUntil < Date.now()) {
      return FREE_TIER_DEFAULTS;
    }

    return {
      planKey: entitlement.planKey,
      features: entitlement.features,
      validUntil: entitlement.validUntil,
    };
  },
});
