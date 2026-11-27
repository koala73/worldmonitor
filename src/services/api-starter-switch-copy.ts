/**
 * Copy for the in-place individual Pro → API Starter switch dialog.
 *
 * Pure functions so the copy is testable without a DOM, and so the /pro build
 * (pro-test/src/services/pro-business-upgrade.ts, which cannot import src/)
 * can mirror it under the parity test in tests/api-starter-switch-copy.test.mts.
 * English only, like the other plan-change dialogs.
 *
 * Inputs are a whitelisted plan name plus integers from the server's preview.
 * Raw provider text never reaches the dialog.
 */

import { formatMinorAmount, formatRenewalDate } from './pro-business-upgrade-copy';

/** Plans the server switches to API Starter in place (API_STARTER_SWITCH_TARGETS). */
export const API_STARTER_SWITCH_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_monthly_mcp', 'pro_annual']);
/** The plans a switch lands on. The server keeps the cadence: Pro Yearly moves to API Starter Annual. */
export const API_STARTER_SWITCH_TARGET_PLANS: ReadonlySet<string> = new Set(['api_starter', 'api_starter_annual']);

export interface ApiStarterSwitchPreview {
  fromPlanKey: string;
  chargeAmount: number;
  currency: string;
  renewalAmount: number | null;
  renewalCurrency: string | null;
  renewalDate: string | null;
  billingPeriod: 'monthly' | 'annual';
}

/** A whitelisted name for the plan being left; never the raw key. */
function apiStarterSwitchFromPlanName(planKey: string): string {
  if (planKey === 'pro_annual') return 'Pro Yearly';
  if (planKey === 'pro_monthly' || planKey === 'pro_monthly_mcp') return 'Pro Monthly';
  return 'Pro';
}

export function buildApiStarterSwitchBody(preview: ApiStarterSwitchPreview): string {
  const from = apiStarterSwitchFromPlanName(preview.fromPlanKey);
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const period = preview.billingPeriod === 'annual' ? 'year' : 'month';
  const date = formatRenewalDate(preview.renewalDate);
  // The charge currency is the customer's, not the plan's: never borrow it for the renewal.
  const price = preview.renewalAmount === null || !preview.renewalCurrency
    ? 'the API Starter price'
    : `${formatMinorAmount(preview.renewalAmount, preview.renewalCurrency)} a ${period} plus any tax`;
  const renewal = date ? `It renews at ${price} on ${date}.` : `It renews at ${price}.`;
  return (
    `Your ${from} subscription moves to API Starter now. ` +
    `You pay ${charge} today, less the unused part of this ${period}. Your billing period restarts today. ` +
    `${renewal} ` +
    'Your dashboard stays the same, and you can create an API key in Settings, under API keys. ' +
    `If the payment fails, you stay on ${from}.`
  );
}

// Its own constants, apart from the Pro Yearly switch's, so either dialog's
// wording (or its move to translated strings) leaves the other unchanged.
export const API_SWITCH_TITLE = 'Switch to API Starter';
export const API_SWITCH_ENTRY_LABEL = 'Switch to API Starter';
export const API_SWITCH_CONFIRM_LABEL = 'Switch now';
export const API_SWITCH_DISMISS_LABEL = 'Not now';
export const API_SWITCH_SUCCESS_TITLE = 'Switched to API Starter';
export const API_SWITCH_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute. Then you can create an API key in Settings, under API keys.';
export const API_SWITCH_CANCEL_SCHEDULED_TITLE = 'Resume Pro first';
export const API_SWITCH_CANCEL_SCHEDULED_BODY =
  'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then switch to API Starter.';
export const API_SWITCH_ACCOUNT_CHANGED_BODY =
  'You switched accounts after this quote. Start the switch again from the account you want to move to API Starter.';
export const API_SWITCH_FAILED_TITLE = 'Switch not confirmed';
// A lost response can follow an accepted change, so this never promises "no charge".
export const API_SWITCH_FAILED_BODY =
  'We could not confirm the switch. Check your plan in the billing portal before you try again, or email support@worldmonitor.app.';
// Shown above the fresh quote after a typed CHARGE_CHANGED: the server refused before any change.
export const API_SWITCH_CHARGE_CHANGED_NOTICE =
  'The price changed since your quote and your plan has not changed. Here is the new price.';
/** Shown when the account holds a Pro to switch but no quote comes back. */
export const API_SWITCH_UNAVAILABLE_BODY =
  'We could not price the switch right now. Try again in a few minutes, or email support@worldmonitor.app.';
