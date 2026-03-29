/**
 * Entitlement queries for frontend subscriptions and gateway fallback.
 *
 * Returns the user's entitlements with free-tier defaults for unknown or
 * expired users. Used by:
 *   - Frontend ConvexClient subscription for reactive panel gating
 *   - Gateway ConvexHttpClient as cache-miss fallback
 *
 * AUTH NOTE: This query accepts a userId arg because both the frontend
 * ConvexClient and the gateway ConvexHttpClient do not have Clerk JWT
 * auth wired yet. Once ConvexClient.setAuth() is wired, replace
 * args.userId with requireUserId(ctx) and make the gateway use an
 * internal query instead.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import { getFeaturesForPlan } from "./lib/entitlements";
import { resolveUserId } from "./lib/auth";

const FREE_TIER_DEFAULTS = {
  planKey: "free" as const,
  features: getFeaturesForPlan("free"),
  validUntil: 0,
};

/**
 * Returns the entitlements for a given userId.
 *
 * Prefers authenticated identity when available; falls back to the
 * client-provided userId for the pre-Clerk-auth period.
 *
 * - No row found -> free-tier defaults
 * - Row found but validUntil < now -> free-tier defaults (expired)
 * - Row found and valid -> actual entitlements
 */
export const getEntitlementsForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Prefer auth identity when available; fall back to client-provided userId
    const authedUserId = await resolveUserId(ctx);
    const userId = authedUserId ?? args.userId;

    const entitlement = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
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
