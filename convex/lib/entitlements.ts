/**
 * Plan-to-features configuration map.
 *
 * This is config, not code. To add a new plan, add an entry to PLAN_FEATURES.
 * To add a new feature dimension, extend PlanFeatures and update each entry.
 */

export type PlanFeatures = {
  tier: number; // 0=free, 1=pro, 2=api, 3=enterprise — higher includes lower
  maxDashboards: number; // -1 = unlimited
  apiAccess: boolean;
  apiRateLimit: number; // requests per minute, 0 = no access
  prioritySupport: boolean;
  exportFormats: string[];
};

/** Free tier defaults -- used as fallback for unknown plan keys. */
export const FREE_FEATURES: PlanFeatures = {
  tier: 0,
  maxDashboards: 3,
  apiAccess: false,
  apiRateLimit: 0,
  prioritySupport: false,
  exportFormats: ["csv"],
};

/**
 * Maps plan keys to their entitled feature sets.
 *
 * Plan keys match the `planKey` field in the `productPlans` and
 * `subscriptions` tables.
 */
/** Shared features for all Pro billing cycles (monthly/annual). */
const PRO_FEATURES: PlanFeatures = {
  tier: 1,
  maxDashboards: 10,
  apiAccess: false,
  apiRateLimit: 0,
  prioritySupport: false,
  exportFormats: ["csv", "pdf"],
};

export const PLAN_FEATURES: Record<string, PlanFeatures> = {
  free: FREE_FEATURES,

  pro_monthly: PRO_FEATURES,
  pro_annual: PRO_FEATURES,

  api_starter: {
    tier: 2,
    maxDashboards: 25,
    apiAccess: true,
    apiRateLimit: 60,
    prioritySupport: false,
    exportFormats: ["csv", "pdf", "json"],
  },

  api_business: {
    tier: 2,
    maxDashboards: 100,
    apiAccess: true,
    apiRateLimit: 300,
    prioritySupport: true,
    exportFormats: ["csv", "pdf", "json", "xlsx"],
  },

  enterprise: {
    tier: 3,
    maxDashboards: -1,
    apiAccess: true,
    apiRateLimit: 1000,
    prioritySupport: true,
    exportFormats: ["csv", "pdf", "json", "xlsx", "api-stream"],
  },
};

/**
 * Returns the feature set for a given plan key.
 * Throws on unrecognized keys so misconfigured products fail loudly
 * instead of silently downgrading paid users to free tier.
 */
export function getFeaturesForPlan(planKey: string): PlanFeatures {
  const features = PLAN_FEATURES[planKey];
  if (!features) {
    throw new Error(
      `[entitlements] Unknown planKey "${planKey}". ` +
        `Add it to PLAN_FEATURES in convex/lib/entitlements.ts.`,
    );
  }
  return features;
}
