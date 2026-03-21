/**
 * Plan-to-features configuration map.
 *
 * This is config, not code. To add a new plan, add an entry to PLAN_FEATURES.
 * To add a new feature dimension, extend PlanFeatures and update each entry.
 */

export type PlanFeatures = {
  maxDashboards: number; // -1 = unlimited
  apiAccess: boolean;
  apiRateLimit: number; // requests per minute, 0 = no access
  prioritySupport: boolean;
  exportFormats: string[];
};

/** Free tier defaults -- used as fallback for unknown plan keys. */
export const FREE_FEATURES: PlanFeatures = {
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
export const PLAN_FEATURES: Record<string, PlanFeatures> = {
  free: FREE_FEATURES,

  pro_monthly: {
    maxDashboards: 10,
    apiAccess: false,
    apiRateLimit: 0,
    prioritySupport: false,
    exportFormats: ["csv", "pdf"],
  },

  pro_annual: {
    maxDashboards: 10,
    apiAccess: false,
    apiRateLimit: 0,
    prioritySupport: false,
    exportFormats: ["csv", "pdf"],
  },

  api_starter: {
    maxDashboards: 25,
    apiAccess: true,
    apiRateLimit: 60,
    prioritySupport: false,
    exportFormats: ["csv", "pdf", "json"],
  },

  api_business: {
    maxDashboards: 100,
    apiAccess: true,
    apiRateLimit: 300,
    prioritySupport: true,
    exportFormats: ["csv", "pdf", "json", "xlsx"],
  },

  enterprise: {
    maxDashboards: -1,
    apiAccess: true,
    apiRateLimit: 1000,
    prioritySupport: true,
    exportFormats: ["csv", "pdf", "json", "xlsx", "api-stream"],
  },
};

/**
 * Returns the feature set for a given plan key.
 * Falls back to free tier defaults if the key is not recognized.
 */
export function getFeaturesForPlan(planKey: string): PlanFeatures {
  return PLAN_FEATURES[planKey] ?? FREE_FEATURES;
}
