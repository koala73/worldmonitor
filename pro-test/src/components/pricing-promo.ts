/**
 * Promotion figures for one pricing card (shared/promo-campaign). Pure and
 * React-free so the figures the cards show are unit-tested against what Dodo
 * charges.
 *
 * Display only: the server applies the code to the checkout. Prices come from
 * the live catalog tier, never a hardcoded figure.
 */
import {
  formatUsdCents,
  formatUsdCentsExact,
  promoDisplayPrices,
  type PromoCampaign,
} from '../../../shared/promo-campaign';

export interface PromoTierPrice {
  annualProductId?: string;
  annualPrice?: number | null;
  monthlyPrice?: number | null;
}

export interface PromoPricing {
  /** Full yearly price ("$359.99"). */
  listLabel: string;
  /** First-year price ("$144"). */
  promoLabel: string;
  /** First-year price per month ("$12.00"). */
  perMonthLabel: string;
  /** Whole percent off the yearly price, as Dodo applies it. */
  percentOff: number;
  /** Twelve monthly payments ("$479.88"), or null without a monthly price. */
  monthlyTotalLabel: string | null;
  /** Whole percent saved against paying monthly, or null without a monthly price. */
  savingsVsMonthlyPct: number | null;
}

/** Promo figures for this tier, or null when the promotion is not for it. */
export function promoPricingForTier(
  tier: PromoTierPrice,
  promo: PromoCampaign | null,
): PromoPricing | null {
  if (!promo || tier.annualProductId !== promo.productId) return null;
  const prices = promoDisplayPrices(promo, tier.annualPrice, tier.monthlyPrice);
  if (!prices) return null;
  return {
    listLabel: formatUsdCents(prices.listCents),
    promoLabel: formatUsdCents(prices.promoCents),
    perMonthLabel: formatUsdCentsExact(prices.perMonthCents),
    percentOff: promo.percentOff,
    monthlyTotalLabel: prices.monthlyTotalCents === null ? null : formatUsdCents(prices.monthlyTotalCents),
    savingsVsMonthlyPct: prices.savingsVsMonthlyPct,
  };
}
