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
  storedFeatures: Omit<PlanFeatures, "planLimits" | "historyDays"> & {
    historyDays?: number;
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
  // The same structural rule for the retired "unlimited" markers. Rows store
  // the catalog's features at grant time and nothing writes per-user limit
  // overrides, so a stored `null` daily limit or `-1` allowance can only be the
  // Enterprise catalog's old value. Now that the catalog sets a finite ceiling,
  // it wins; otherwise every row granted before the change would stay uncapped
  // until a billing event happened to rewrite it.
  if (planLimits && catalogDefaults.planLimits) {
    for (const field of ["apiRequestsPerDay", "mcpCallsPerDay", "dashboardAiCallsPerDay"] as const) {
      if (planLimits[field] === null && typeof catalogDefaults.planLimits[field] === "number") {
        (planLimits as Record<typeof field, unknown>)[field] = catalogDefaults.planLimits[field];
      }
    }
  }
  // The desktop-key limits are plan structure too (plan 2026-10-25-001, KTD1):
  // the cap and the per-account ceilings are set from measurement and change
  // with the catalog, so a stored row's grant-time copy must never outlive a
  // catalog change. Nothing writes per-user overrides for them.
  if (planLimits && catalogDefaults.planLimits) {
    planLimits.desktopKeyRequestsPerDay = catalogDefaults.planLimits.desktopKeyRequestsPerDay;
    planLimits.desktopKeyBurstPerMinute = catalogDefaults.planLimits.desktopKeyBurstPerMinute;
  }
  const apiDailyAllowance =
    storedFeatures.apiDailyAllowance === -1 && (catalogDefaults.apiDailyAllowance ?? -1) >= 0
      ? catalogDefaults.apiDailyAllowance
      : storedFeatures.apiDailyAllowance;
  return {
    ...catalogDefaults,
    ...storedFeatures,
    ...(apiDailyAllowance !== undefined ? { apiDailyAllowance } : {}),
    ...(catalogDefaults.maxDesktopKeys !== undefined
      ? { maxDesktopKeys: catalogDefaults.maxDesktopKeys }
      : {}),
    planLimits,
  };
}
