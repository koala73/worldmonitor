/**
 * Copy for the in-place Pro → Pro Business upgrade dialog.
 *
 * Pure functions so the copy is testable without a DOM, and so the /pro build
 * (pro-test/src/services/checkout.ts, which cannot import src/) can mirror
 * the load-bearing sentences under the parity test in
 * tests/pro-business-upgrade-copy.test.mts.
 *
 * Inputs are a whitelisted plan display name plus integers from the server's
 * preview. Raw provider text never reaches the dialog.
 */

/** Plans the server can upgrade in place (see PRO_BUSINESS_UPGRADE_TARGETS). */
export const IN_PLACE_UPGRADE_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_monthly_mcp', 'pro_annual']);

export interface ProBusinessUpgradePreview {
  /** Amount charged now, lowest unit of `currency` (the customer's billing currency). */
  chargeAmount: number;
  currency: string;
  /** Recurring price of the new plan before tax, lowest unit of `renewalCurrency`. */
  renewalAmount: number | null;
  /** Dodo charges in the customer's currency but prices the plan in its own. */
  renewalCurrency: string | null;
  /** First renewal on Pro Business, ISO 8601. The change restarts the billing period. */
  renewalDate: string | null;
  billingPeriod: 'monthly' | 'annual';
}

/** Formats a lowest-unit amount, e.g. 667 USD → "$6.67". Falls back to "6.67 XYZ" for an unknown currency. */
export function formatMinorAmount(amount: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    // Dodo amounts are in the currency's minor unit: cents for USD, whole yen for JPY.
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

/** Formats an ISO date as "December 7, 2026" (UTC, en-US by default), or null when it does not parse. */
export function formatRenewalDate(iso: string | null, locale = 'en-US'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}

export function buildUpgradePreviewBody(planDisplayName: string, preview: ProBusinessUpgradePreview): string {
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const period = preview.billingPeriod === 'annual' ? 'year' : 'month';
  const date = formatRenewalDate(preview.renewalDate);
  // The charge currency is the customer's, not the plan's: never borrow it for the renewal.
  const price = preview.renewalAmount === null || !preview.renewalCurrency
    ? 'the Pro Business price'
    : `${formatMinorAmount(preview.renewalAmount, preview.renewalCurrency)} a ${period} plus any tax`;
  const renewal = date ? `It renews at ${price} on ${date}.` : `It renews at ${price}.`;
  return (
    `Your ${planDisplayName} subscription moves to Pro Business now. ` +
    `You pay ${charge} today and your billing period restarts today. ${renewal} ` +
    'If the payment fails, you stay on Pro.'
  );
}

export const UPGRADE_SUCCESS_TITLE = 'Upgraded to Pro Business';
export const UPGRADE_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute. Reload to see Pro Business features.';

export const UPGRADE_CANCEL_SCHEDULED_BODY =
  'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then upgrade to Pro Business.';

// A lost response can follow an accepted change, so this never promises "no charge".
export const UPGRADE_FAILED_BODY =
  'We could not confirm the upgrade. Check your plan in the billing portal before you try again, or email support@worldmonitor.app.';

export const UPGRADE_ACCOUNT_CHANGED_BODY =
  'You switched accounts after this quote. Start the upgrade again from the account you want to upgrade.';

// ── Pro Monthly → Pro Yearly switch ─────────────────────────────────────────
//
// Translated through the app catalog (settings.account.switchYearly.*). The
// caller passes its `t` so this module stays free of the i18n runtime and
// testable in node. Prices stay en-US formatted, as on /pro; the renewal date
// follows the reader's locale because it sits inside a translated sentence.

/** The one plan the server switches to Pro Yearly in place (selectProAnnualSwitchCandidate). */
export const PRO_ANNUAL_SWITCH_SOURCE_PLAN = 'pro_monthly';

/** i18next's `t`, or a stand-in with the same {{placeholder}} contract. */
export type SwitchTranslate = (key: string, vars?: Record<string, string | number>) => string;

const SWITCH_KEY = 'settings.account.switchYearly';

/** Every fixed label and message of the switch flow, in the reader's language. */
export function switchCopy(t: SwitchTranslate) {
  const k = (name: string): string => t(`${SWITCH_KEY}.${name}`);
  return {
    entryLabel: k('entryLabel'),
    title: k('title'),
    confirmLabel: k('confirm'),
    dismissLabel: k('dismiss'),
    doneLabel: k('done'),
    closeLabel: t('common.close'),
    openPortalLabel: k('openPortal'),
    successTitle: k('successTitle'),
    successBody: k('successBody'),
    cancelScheduledTitle: k('cancelScheduledTitle'),
    cancelScheduledBody: k('cancelScheduledBody'),
    failedTitle: k('failedTitle'),
    // A lost response can follow an accepted change, so this never promises "no charge".
    failedBody: k('failedBody'),
    accountChangedTitle: k('accountChangedTitle'),
    accountChangedBody: k('accountChangedBody'),
    // Shown above the fresh quote after a typed PROMO_ENDED / PROMO_CODE_REJECTED:
    // the server refused before any change, so the plan is known to be unchanged.
    quoteChangedNotice: k('quoteChanged'),
    // Shown above a first quote at list price while the offer runs (Dodo refused
    // the code for this subscription), so nobody reads it as the offer price.
    offerNotAppliedNotice: k('offerNotApplied'),
    // Shown above the fresh quote after a typed CHARGE_CHANGED: the charge grew
    // past the accepted one (the unused-month credit shrinks with time), and the
    // server refused before any change.
    chargeChangedNotice: k('chargeChanged'),
    /** Settings toast when no quote comes back. */
    unavailableBody: k('unavailable'),
  };
}

export type SwitchCopy = ReturnType<typeof switchCopy>;

/** Joins translated sentences: a space after Latin punctuation, none after a CJK full stop. */
export function joinSentences(sentences: readonly string[]): string {
  return sentences.reduce((out, sentence) => {
    if (!out) return sentence;
    return /[。！？]$/.test(out) ? out + sentence : `${out} ${sentence}`;
  }, '');
}

export interface ProAnnualSwitchPreview {
  chargeAmount: number;
  currency: string;
  /** The list renewal: the server quotes the catalog price when the first year is discounted. */
  renewalAmount: number | null;
  renewalCurrency: string | null;
  renewalDate: string | null;
  /** The quote carries the running offer's code. */
  discounted: boolean;
  /** Dodo's whole percent off the first year, only on a discounted quote. */
  percentOff: number | null;
}

export function buildSwitchPreviewBody(
  preview: ProAnnualSwitchPreview,
  t: SwitchTranslate,
  /** BCP 47 tag for the renewal date; the dashboard passes getLocale(). */
  locale = 'en-US',
): string {
  const k = (name: string, vars?: Record<string, string | number>): string => t(`${SWITCH_KEY}.${name}`, vars);
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const date = formatRenewalDate(preview.renewalDate, locale);
  // The charge currency is the customer's, not the plan's: never borrow it for the renewal.
  const price = preview.renewalAmount === null || !preview.renewalCurrency
    ? null
    : formatMinorAmount(preview.renewalAmount, preview.renewalCurrency);
  const renewal = price === null
    ? (date ? k('renewsListDate', { date }) : k('renewsList'))
    : (date ? k('renewsPriceDate', { price, date }) : k('renewsPrice', { price }));
  const chargeLine = preview.discounted && typeof preview.percentOff === 'number'
    ? k('previewChargeOffer', { charge, percent: preview.percentOff })
    : k('previewCharge', { charge });
  return joinSentences([k('previewMoves'), chargeLine, k('previewRestart'), renewal, k('previewTerms')]);
}

/** The PromoDisplayPrices figures the Settings offer line names (USD cents). */
export interface SwitchPromoLinePrices {
  listCents: number;
  perMonthCents: number;
  monthlyTotalCents: number;
  savingsVsMonthlyPct: number;
}

/**
 * Settings line beside the switch button while the offer runs. The savings
 * figure is against twelve monthly payments, so it stands beside the monthly
 * price (the banner's wording), with the renewal and the cancel terms.
 */
export function buildSwitchPromoLine(prices: SwitchPromoLinePrices, t: SwitchTranslate): string {
  return t(`${SWITCH_KEY}.offerLine`, {
    perMonth: formatMinorAmount(prices.perMonthCents, 'USD'),
    monthly: formatMinorAmount(Math.round(prices.monthlyTotalCents / 12), 'USD'),
    renewal: formatMinorAmount(prices.listCents, 'USD'),
    percent: prices.savingsVsMonthlyPct,
  });
}
