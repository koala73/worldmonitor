/**
 * Dodo Payments product configuration.
 *
 * Single source of truth for product IDs used in frontend checkout CTAs.
 * These must match the IDs in convex/payments/seedProductPlans.ts.
 */

export const DODO_PRODUCTS = {
  PRO_MONTHLY: 'pdt_0NaysSFAQ0y30nJOJMBpg',
  PRO_ANNUAL: 'pdt_0NaysWqJBx3laiCzDbQfr',
  API_STARTER: 'pdt_0NaysZwxCyk9Satf1jbqU',
  API_BUSINESS: 'pdt_0NaysdZLwkMAPEVJQja5G',
  ENTERPRISE: 'pdt_0NaysgHSQTTqGjJdLtuWP',
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
