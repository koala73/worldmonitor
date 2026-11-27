/**
 * The one time-boxed checkout promotion, read by the Convex checkout action
 * (which applies the code), the /pro pricing cards and the dashboard banner
 * (which only display it). Nothing else knows the code, the product or the
 * end instant.
 *
 * Pure and import-free so Convex, edge, the dashboard and pro-test can all
 * load it.
 *
 * The offer ends by clock: the server stops applying the code and the clients
 * stop rendering it at `endsAtMs`, with no deploy. The Dodo code itself
 * expires 15 minutes later as a backstop. After the offer, set
 * `ACTIVE_PROMO = null`.
 */

export interface PromoCampaign {
  /** Stamped on checkout metadata as `wm_promo`. */
  id: string;
  /** Dodo discount code (restricted to `productId` in Dodo). */
  discountCode: string;
  /** Dodo product the code applies to. */
  productId: string;
  /** PRODUCT_CATALOG plan key of `productId`. */
  planKey: string;
  /** Monthly plan the "compared with paying monthly" copy measures against. */
  monthlyPlanKey: string;
  /** Whole percent off the first billing cycle. */
  percentOff: number;
  /**
   * First instant the offer is available (UTC epoch ms). Already past when it
   * ships; it keeps tests that pin an old clock off the promotion path.
   */
  startsAtMs: number;
  /** First instant the offer is no longer available (UTC epoch ms). */
  endsAtMs: number;
}

/**
 * Black Friday 2026: 60% off the first year of Pro Yearly, until 23:45 UTC on
 * Friday 4 December. Dodo discount dsc_0NsmwQ6SsXiCP60KPHg4X: amount 6000 bps,
 * one cycle, restricted to Pro Yearly, expiring 2026-12-04T23:59:59.999Z, so
 * the server stops 15 minutes before Dodo does. `percentOff` must match the
 * Dodo amount; it is never derived from the code text.
 */
export const ACTIVE_PROMO: PromoCampaign | null = {
  id: 'black-friday-2026',
  discountCode: 'BLACKFRIDAY',
  productId: 'pdt_0NbttMIfjLWC10jHQWYgJ',
  planKey: 'pro_annual',
  monthlyPlanKey: 'pro_monthly',
  percentOff: 60,
  startsAtMs: Date.UTC(2026, 10, 26, 0, 0, 0),
  endsAtMs: Date.UTC(2026, 11, 4, 23, 45, 0),
};

/** The running promotion, or null when none is configured or it has ended. */
export function activePromo(
  nowMs: number,
  promo: PromoCampaign | null = ACTIVE_PROMO,
): PromoCampaign | null {
  if (!promo || !Number.isFinite(nowMs)) return null;
  return nowMs >= promo.startsAtMs && nowMs < promo.endsAtMs ? promo : null;
}

/** The running promotion when it applies to this Dodo product, else null. */
export function activePromoFor(
  productId: string,
  nowMs: number,
  promo: PromoCampaign | null = ACTIVE_PROMO,
): PromoCampaign | null {
  const running = activePromo(nowMs, promo);
  return running && running.productId === productId ? running : null;
}

/**
 * What the buyer pays for the discounted cycle, in cents. Dodo rounds the
 * discount down and the charge up: 50% off 35999 charged 18000 and 60% off
 * 35999 charges 14400 (live checkout form and change-plan preview, 2026-11-26).
 */
export function promoPriceCents(listCents: number, percentOff: number): number {
  return listCents - Math.floor((listCents * percentOff) / 100);
}

export interface PromoDisplayPrices {
  /** Full yearly price in cents (renewal price). */
  listCents: number;
  /** First-year price in cents, as Dodo charges it. */
  promoCents: number;
  /** The first-year price spread over twelve months, in cents. */
  perMonthCents: number;
  /** Twelve monthly payments in cents, or null when the monthly price is unknown. */
  monthlyTotalCents: number | null;
  /**
   * Whole percent saved against twelve monthly payments, or null when the
   * monthly price is unknown. Marketing copy only: Dodo applies `percentOff`
   * to the yearly price, so this figure is always shown beside its monthly
   * reference (`monthlyTotalCents` or the per-month price).
   */
  savingsVsMonthlyPct: number | null;
}

/**
 * Display figures from live catalog prices in dollars (the shape /pro and the
 * product facts use). Null when the yearly price is unusable.
 */
export function promoDisplayPrices(
  promo: PromoCampaign,
  annualPrice: number | null | undefined,
  monthlyPrice: number | null | undefined,
): PromoDisplayPrices | null {
  if (typeof annualPrice !== 'number' || !(annualPrice > 0)) return null;
  const listCents = Math.round(annualPrice * 100);
  const promoCents = promoPriceCents(listCents, promo.percentOff);
  const monthlyCents = typeof monthlyPrice === 'number' && monthlyPrice > 0
    ? Math.round(monthlyPrice * 100)
    : null;
  const monthlyTotalCents = monthlyCents === null ? null : 12 * monthlyCents;
  const savings = monthlyTotalCents === null
    ? null
    : Math.round((1 - promoCents / monthlyTotalCents) * 100);
  // A monthly comparison weaker than the direct discount (odd catalog
  // prices) is never the headline; callers fall back to the yearly wording.
  const useMonthly = savings !== null && savings > promo.percentOff;
  return {
    listCents,
    promoCents,
    perMonthCents: Math.round(promoCents / 12),
    monthlyTotalCents: useMonthly ? monthlyTotalCents : null,
    savingsVsMonthlyPct: useMonthly ? savings : null,
  };
}

/** "$144" for whole dollars, "$359.99" otherwise. */
export function formatUsdCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** Always two decimals: "$12.00". For per-month figures next to "$39.99/mo". */
export function formatUsdCentsExact(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The last minute of the offer in the viewer's locale and time zone, e.g.
 * "Fri, Dec 4, 3:44 PM" in Los Angeles or "Sat, Dec 5, 12:44 AM" in Paris.
 * The last minute rather than the end instant, so an end on the hour never
 * reads as the start of the next day.
 */
export function formatPromoEnd(endsAtMs: number, locale?: string, timeZone?: string): string {
  const lastMinute = new Date(endsAtMs - 60_000);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(lastMinute);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(lastMinute);
  }
}
