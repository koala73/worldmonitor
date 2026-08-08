/**
 * Billing-mode resolution for pricing-card CTAs (#4946 round 4).
 *
 * Pure and React-free so the annual-toggle contract is directly unit-
 * testable: with the page-level toggle on "Annual", a tier that has no
 * annual product (API Business) must still check out its monthly product
 * — but EXPLICITLY, with `billedMonthlyOnly` driving a visible "billed
 * monthly" note on the card. Silently selling the monthly product from
 * an annual-selected state is the bug this module exists to prevent.
 */

export interface BillingModeTier {
  monthlyProductId?: string;
  annualProductId?: string;
}

export interface ResolvedCheckoutProduct {
  productId: string;
  /**
   * True when the user is in annual mode but this tier only exists as a
   * monthly product — the card must say so next to the price.
   */
  billedMonthlyOnly: boolean;
}

export function resolveCheckoutProduct(
  tier: BillingModeTier,
  billing: 'monthly' | 'annual',
): ResolvedCheckoutProduct | null {
  if (!tier.monthlyProductId) return null;
  if (billing === 'annual' && tier.annualProductId) {
    return { productId: tier.annualProductId, billedMonthlyOnly: false };
  }
  return {
    productId: tier.monthlyProductId,
    billedMonthlyOnly: billing === 'annual' && !tier.annualProductId,
  };
}
