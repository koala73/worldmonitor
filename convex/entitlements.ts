/**
 * Entitlement queries.
 *
 * Two versions:
 *   - getEntitlementsForUser (public query): for frontend ConvexClient subscription.
 *     Derives the subject from Convex auth and returns free-tier defaults when
 *     unauthenticated.
 *   - getEntitlementsByUserId (internal query): for the gateway ConvexHttpClient
 *     cache-miss fallback. Trusted server-to-server call with no auth gap.
 */

import type { QueryCtx } from "./_generated/server";
import { query, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getFeaturesForPlan } from "./lib/entitlements";
import { resolveUserId } from "./lib/auth";

const FREE_TIER_DEFAULTS = {
  planKey: "free" as const,
  features: getFeaturesForPlan("free"),
  validUntil: 0,
};

/** Shared handler logic for both public and internal queries. */
async function getEntitlementsHandler(
  ctx: QueryCtx,
  userId: string,
) {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();

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
}

/**
 * Public query: returns entitlements for the authenticated user.
 *
 * Derives the caller from server-side auth identity. Unauthenticated
 * callers get free-tier defaults instead of arbitrary cross-user reads.
 */
export const getEntitlementsForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await resolveUserId(ctx);
    if (!userId) {
      return FREE_TIER_DEFAULTS;
    }
    return getEntitlementsHandler(ctx, userId);
  },
});

/**
 * Internal query: returns entitlements for a given userId.
 *
 * Used by the gateway ConvexHttpClient for cache-miss fallback.
 * Trusted server-to-server call — no auth gap.
 */
export const getEntitlementsByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return getEntitlementsHandler(ctx, args.userId);
  },
});
