/**
 * Plan-to-features resolution.
 *
 * Features are defined in the canonical product catalog
 * (convex/config/productCatalog.ts). This module re-exports the type
 * and lookup function for backward compatibility.
 */

import {
  type PlanFeatures,
  getEntitlementFeatures,
  PRODUCT_CATALOG,
  SHARED_API_BUDGET,
} from "../config/productCatalog";

export type { PlanFeatures };

/** Free tier defaults — used as fallback for unknown plan keys. */
export const FREE_FEATURES: PlanFeatures = PRODUCT_CATALOG.free!.features;

/**
 * Returns the feature set for a given plan key.
 * Throws on unrecognized keys so misconfigured products fail loudly
 * instead of silently downgrading paid users to free tier.
 */
export function getFeaturesForPlan(planKey: string): PlanFeatures {
  return getEntitlementFeatures(planKey);
}

/** Merge stored per-user overrides with newly added catalog defaults. */
export function mergeEntitlementFeatures(
  planKey: string,
  storedFeatures: Omit<PlanFeatures, "planLimits"> & {
    planLimits?: Partial<NonNullable<PlanFeatures["planLimits"]>>;
  },
): PlanFeatures {
  const catalogDefaults = getFeaturesForPlan(planKey);
  const planLimits = {
    ...catalogDefaults.planLimits,
    ...storedFeatures.planLimits,
  } as PlanFeatures["planLimits"];
  // `mcpCallsPerDay` is plan STRUCTURE, not a per-user override: it decides
  // WHICH counter the plan charges, so the catalog has to win when it names the
  // shared budget. Rows written before that move still carry the old numeric
  // (1,000 / 10,000), and a plain spread would let it through — leaving an
  // existing API-tier subscriber on a separate MCP allowance ON TOP of their
  // REST one, twenty times what they have today, until a billing event happened
  // to rewrite the row.
  if (planLimits && catalogDefaults.planLimits?.mcpCallsPerDay === SHARED_API_BUDGET) {
    planLimits.mcpCallsPerDay = SHARED_API_BUDGET;
  }
  return {
    ...catalogDefaults,
    ...storedFeatures,
    planLimits,
  };
}
