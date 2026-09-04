/**
 * Pure helpers for the checkout-intent-via-URL flow.
 *
 * Intent is bound to the specific sign-in attempt via Clerk's
 * afterSignInUrl / afterSignUpUrl. On successful sign-in from our
 * openSignIn call, Clerk navigates to a return URL carrying these
 * params. On page load, we parse, consume, and strip them.
 *
 * Extracted as a pure module (no DOM, no Clerk, no dodopayments
 * import) so tests can exercise the parse/strip/build logic without
 * a browser or SDK environment. Reviewer-requested after the
 * afterSignInUrl refactor introduced this flow.
 */
import {
  CHECKOUT_MISSION_PARAM,
  CHECKOUT_PANEL_PARAM,
  CHECKOUT_HANDOFF_PARAM,
  DESKTOP_CHECKOUT_HANDOFF,
  parseMissionPreviewAttribution,
  isDesktopCheckoutHandoff,
  type CheckoutAttribution,
  type MissionPreviewAttribution,
} from '../../../shared/checkout-attribution';

export const CHECKOUT_PRODUCT_PARAM = 'wm_checkout_product';
export const CHECKOUT_REF_PARAM = 'wm_checkout_ref';
export const CHECKOUT_DISCOUNT_PARAM = 'wm_checkout_discount';
export const CHECKOUT_ATTRIBUTION_PARAM = 'wm_checkout_attribution';

export interface CheckoutIntentFromUrl {
  productId: string;
  referralCode?: string;
  discountCode?: string;
  attributionSource?: string;
  checkoutAttribution?: MissionPreviewAttribution;
  desktopHandoff?: boolean;
}

/**
 * Parse checkout intent from a URL search string. Returns null when
 * the required productId param is missing — that's the common
 * "normal page load, no intent" case.
 */
export function parseCheckoutIntentFromSearch(search: string): CheckoutIntentFromUrl | null {
  const params = new URLSearchParams(search);
  const productId = params.get(CHECKOUT_PRODUCT_PARAM);
  if (!productId) return null;
  const checkoutAttribution = parseMissionPreviewAttribution(
    params.get(CHECKOUT_MISSION_PARAM),
    params.get(CHECKOUT_PANEL_PARAM),
  );
  return {
    productId,
    referralCode: params.get(CHECKOUT_REF_PARAM) ?? undefined,
    discountCode: params.get(CHECKOUT_DISCOUNT_PARAM) ?? undefined,
    attributionSource: params.get(CHECKOUT_ATTRIBUTION_PARAM) ?? undefined,
    ...(checkoutAttribution ? { checkoutAttribution } : {}),
    ...(isDesktopCheckoutHandoff(search) ? { desktopHandoff: true } : {}),
  };
}

/**
 * Strip checkout-intent params from a URL search string while
 * preserving all other query params. Returns '' (empty) when nothing
 * remains, '?a=b' when other params survive.
 *
 * Caller applies this BEFORE any await so a reload during the
 * post-strip async work can't re-fire checkout with the stale intent.
 */
export function stripCheckoutIntentFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CHECKOUT_PRODUCT_PARAM);
  params.delete(CHECKOUT_REF_PARAM);
  params.delete(CHECKOUT_DISCOUNT_PARAM);
  params.delete(CHECKOUT_ATTRIBUTION_PARAM);
  params.delete(CHECKOUT_MISSION_PARAM);
  params.delete(CHECKOUT_PANEL_PARAM);
  params.delete(CHECKOUT_HANDOFF_PARAM);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : '';
}

/**
 * Build a return URL with checkout intent appended. Called at click-
 * time to construct Clerk's afterSignInUrl / afterSignUpUrl.
 *
 * Strips any previously-set checkout-intent params so stacked intents
 * don't compound (user clicks Pro, dismisses, clicks Enterprise: the
 * returnUrl should carry Enterprise, not both).
 */
export function buildCheckoutReturnUrl(
  currentHref: string,
  productId: string,
  options?: {
    referralCode?: string;
    discountCode?: string;
    attributionSource?: string;
    checkoutAttribution?: CheckoutAttribution;
  },
): string {
  const url = new URL(currentHref);
  url.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
  url.searchParams.delete(CHECKOUT_REF_PARAM);
  url.searchParams.delete(CHECKOUT_DISCOUNT_PARAM);
  url.searchParams.delete(CHECKOUT_ATTRIBUTION_PARAM);
  url.searchParams.delete(CHECKOUT_MISSION_PARAM);
  url.searchParams.delete(CHECKOUT_PANEL_PARAM);
  url.searchParams.delete(CHECKOUT_HANDOFF_PARAM);
  url.searchParams.set(CHECKOUT_PRODUCT_PARAM, productId);
  if (options?.referralCode) url.searchParams.set(CHECKOUT_REF_PARAM, options.referralCode);
  if (options?.discountCode) url.searchParams.set(CHECKOUT_DISCOUNT_PARAM, options.discountCode);
  if (options?.attributionSource) {
    url.searchParams.set(CHECKOUT_ATTRIBUTION_PARAM, options.attributionSource);
  }
  const checkoutAttribution = parseMissionPreviewAttribution(
    options?.checkoutAttribution?.missionId,
    options?.checkoutAttribution?.panelKey,
  );
  if (checkoutAttribution) {
    url.searchParams.set(CHECKOUT_MISSION_PARAM, checkoutAttribution.missionId);
    url.searchParams.set(CHECKOUT_PANEL_PARAM, checkoutAttribution.panelKey);
  }
  if (options?.desktopHandoff) {
    url.searchParams.set(CHECKOUT_HANDOFF_PARAM, DESKTOP_CHECKOUT_HANDOFF);
  }
  return url.toString();
}
