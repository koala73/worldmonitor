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
export const IN_PLACE_UPGRADE_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_annual']);

export interface ProBusinessUpgradePreview {
  /** Amount charged now, lowest currency unit. */
  chargeAmount: number;
  currency: string;
  /** Recurring price of the new plan before tax, lowest currency unit. */
  renewalAmount: number | null;
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

export function buildUpgradePreviewBody(planDisplayName: string, preview: ProBusinessUpgradePreview): string {
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const period = preview.billingPeriod === 'annual' ? 'year' : 'month';
  const renewal = preview.renewalAmount === null
    ? 'then the Pro Business price from your next renewal'
    : `then ${formatMinorAmount(preview.renewalAmount, preview.currency)} a ${period} plus any tax from your next renewal`;
  return (
    `Your ${planDisplayName} subscription moves to Pro Business now. ` +
    `You pay ${charge} today for the rest of this billing period, ${renewal}. ` +
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
