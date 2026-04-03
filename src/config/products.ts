/**
 * Dodo Payments product configuration.
 *
 * Single source of truth for product IDs used in frontend checkout CTAs.
 * These must match the IDs in convex/payments/seedProductPlans.ts.
 */

export const DODO_PRODUCTS = {
  PRO_MONTHLY: 'pdt_0Nbtt71uObulf7fGXhQup',
  PRO_ANNUAL: 'pdt_0NbttMIfjLWC10jHQWYgJ',
  API_STARTER: 'pdt_0NbttVmG1SERrxhygbbUq',
  API_BUSINESS: 'pdt_0Nbttg7NuOJrhbyBGCius',
  ENTERPRISE: 'pdt_0Nbttnqrfh51cRqhMdVLx',
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
