/**
 * Entitlement queries.
 *
 * Two versions:
 *   - getEntitlementsForUser (public query): for frontend ConvexClient subscription.
 *     Requires authenticated identity; falls back to args.userId only for the
 *     pre-Clerk-auth period (TODO: remove fallback once ConvexClient.setAuth() is wired).
 *   - getEntitlementsByUserId (internal query): for the gateway ConvexHttpClient
 *     cache-miss fallback. Trusted server-to-server call with no auth gap.
 */

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
  ctx: { db: any },
  userId: string,
) {
  const entitlement = await ctx.db
    .query("entitlements")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
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
 * Prefers server-side auth identity. Falls back to args.userId for the
 * pre-Clerk-auth period (frontend ConvexClient has no setAuth wired).
 * TODO(clerk-auth): Remove userId arg and use requireUserId(ctx) once
 * ConvexClient.setAuth() is wired.
 */
export const getEntitlementsForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // When authenticated, enforce that the caller can only read their own data.
    // When unauthenticated (pre-Clerk-auth), allow the userId arg as fallback.
    const authedUserId = await resolveUserId(ctx);
    if (authedUserId && authedUserId !== args.userId) {
      return FREE_TIER_DEFAULTS;
    }
    const userId = authedUserId ?? args.userId;
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
