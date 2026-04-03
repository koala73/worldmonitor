// Seed mutation for Dodo product-to-plan mappings.
//
// Run this mutation after creating products in the Dodo dashboard.
// Replace REPLACE_WITH_DODO_ID with actual product IDs from the dashboard.
//
// Usage:
//   npx convex run payments/seedProductPlans:seedProductPlans
//   npx convex run payments/seedProductPlans:listProductPlans

import { internalMutation, query } from "../_generated/server";

const PRODUCT_PLANS = [
  {
    dodoProductId: "pdt_0Nbtt71uObulf7fGXhQup",
    planKey: "pro_monthly",
    displayName: "Pro Monthly",
    isActive: true,
  },
  {
    dodoProductId: "pdt_0NbttMIfjLWC10jHQWYgJ",
    planKey: "pro_annual",
    displayName: "Pro Annual",
    isActive: true,
  },
  {
    dodoProductId: "pdt_0NbttVmG1SERrxhygbbUq",
    planKey: "api_starter",
    displayName: "API Starter",
    isActive: true,
  },
  {
    dodoProductId: "pdt_0Nbttg7NuOJrhbyBGCius",
    planKey: "api_business",
    displayName: "API Business",
    isActive: true,
  },
  {
    dodoProductId: "pdt_0Nbttnqrfh51cRqhMdVLx",
    planKey: "enterprise",
    displayName: "Enterprise",
    isActive: true,
  },
] as const;

/**
 * Upsert 5 product-to-plan mappings into the productPlans table.
 * Idempotent: running twice will update existing records rather than
 * creating duplicates, thanks to the by_planKey index lookup.
 */
export const seedProductPlans = internalMutation({
  args: {},
  handler: async (ctx) => {
    let created = 0;
    let updated = 0;

    for (const plan of PRODUCT_PLANS) {
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
 * Useful for verifying the seed worked and for later phases
 * that need to map Dodo products to internal plan keys.
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
