/**
 * Seed mutation for Dodo product-to-plan mappings.
 *
 * Reads from the canonical product catalog (convex/config/productCatalog.ts).
 * Run after creating/updating products in the Dodo dashboard.
 *
 * Usage:
 *   npx convex run payments/seedProductPlans:seedProductPlans
 *   npx convex run payments/seedProductPlans:listProductPlans
 */

import { internalMutation, query } from "../_generated/server";
import { getSeedableProducts } from "../config/productCatalog";

/**
 * Upsert product-to-plan mappings from the canonical catalog.
 * Idempotent: running twice will update existing records rather than
 * creating duplicates, thanks to the by_planKey index lookup.
 */
export const seedProductPlans = internalMutation({
  args: {},
  handler: async (ctx) => {
    let created = 0;
    let updated = 0;

    for (const plan of getSeedableProducts()) {
      const existing = await ctx.db
        .query("productPlans")
        .withIndex("by_planKey", (q) => q.eq("planKey", plan.planKey))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          dodoProductId: plan.dodoProductId,
          displayName: plan.displayName,
          isActive: plan.isActive,
        });
        updated++;
      } else {
        await ctx.db.insert("productPlans", {
          dodoProductId: plan.dodoProductId,
          planKey: plan.planKey,
          displayName: plan.displayName,
          isActive: plan.isActive,
        });
        created++;
      }
    }

    return { created, updated };
  },
});

/**
 * List all active product plans, sorted by planKey.
 */
export const listProductPlans = query({
  args: {},
  handler: async (ctx) => {
    const plans = await ctx.db.query("productPlans").collect();
    return plans
      .filter((p) => p.isActive)
      .sort((a, b) => a.planKey.localeCompare(b.planKey));
  },
});
