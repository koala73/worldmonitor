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
import { query, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getFeaturesForPlan, mergeEntitlementFeatures } from "./lib/entitlements";
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

  // Read-time merge with the canonical product catalog so feature flags added
  // to PRODUCT_CATALOG since the row was last written by the Dodo webhook
  // are surfaced immediately — no need to wait for the next subscription
  // event to rewrite the row. Stored row's `features` win on conflict
  // (preserves any per-user overrides). New fields the row lacks (e.g.
  // `mcpAccess` post-plan-2026-05-10-001 U10) inherit the catalog default
  // for the user's plan.
  // `planLimits` is nested, so the shared helper merges it independently.
  const mergedFeatures = mergeEntitlementFeatures(
    entitlement.planKey,
    entitlement.features,
  );
  return {
    planKey: entitlement.planKey,
    features: mergedFeatures,
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

// ---------------------------------------------------------------------------
// Customer AI routing policies
// ---------------------------------------------------------------------------

// Provider names the edge understands (server/_shared/llm.ts). Kept here so a
// typo is rejected at write time instead of silently resolving to "no
// provider" at request time.
export const AI_ROUTING_PROVIDER_NAMES = [
  "anthropic",
  "openrouter",
  "openrouter-free",
  "openrouter-free-backup",
  "ollama",
  "generic",
] as const;

export function validateAllowedProviders(providers: string[]): string[] {
  const known = new Set<string>(AI_ROUTING_PROVIDER_NAMES);
  const out: string[] = [];
  for (const provider of providers) {
    if (!known.has(provider)) {
      throw new Error(`Unknown AI provider "${provider}". Allowed: ${AI_ROUTING_PROVIDER_NAMES.join(", ")}`);
    }
    if (!out.includes(provider)) out.push(provider);
  }
  if (out.length === 0) throw new Error("allowedProviders must name at least one provider");
  return out;
}

/** Edge lookup. `null` means the user has no restriction. */
export const getAiRoutingPolicyByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("aiRoutingPolicies")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return row ? { allowedProviders: row.allowedProviders } : null;
  },
});

/**
 * Operator-only (`npx convex run entitlements:setAiRoutingPolicy`). The edge
 * caches the lookup for 60 s; the cache delete below makes a change visible
 * immediately when Upstash is reachable.
 */
export const setAiRoutingPolicy = internalMutation({
  args: {
    userId: v.string(),
    allowedProviders: v.array(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.userId.trim()) throw new Error("userId is required");
    if (!args.reason.trim()) throw new Error("reason is required (e.g. the contract clause)");
    const allowedProviders = validateAllowedProviders(args.allowedProviders);
    const existing = await ctx.db
      .query("aiRoutingPolicies")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const row = { userId: args.userId, allowedProviders, reason: args.reason.trim(), updatedAt: Date.now() };
    if (existing) {
      await ctx.db.replace(existing._id, row);
    } else {
      await ctx.db.insert("aiRoutingPolicies", row);
    }
    await ctx.scheduler.runAfter(0, internal.payments.cacheActions.deleteAiRoutingPolicyCache, { userId: args.userId });
    return { userId: args.userId, allowedProviders };
  },
});

export const clearAiRoutingPolicy = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("aiRoutingPolicies")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.payments.cacheActions.deleteAiRoutingPolicyCache, { userId: args.userId });
    return { userId: args.userId, removed: rows.length };
  },
});
