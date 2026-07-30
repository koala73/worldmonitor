/**
 * Modal confirmation dialog for the `ACTIVE_SUBSCRIPTION_EXISTS` 409.
 *
 * Before this dialog, the dashboard silently opened the billing portal
 * in a new tab on 409. The user got teleported with no context — not a
 * friendly "you're already subscribed" moment, just "a new tab appeared."
 *
 * Thin wrapper over the shared checkout-dialog-factory (scaffold + lifecycle
 * shared with the payment-in-progress dialog). Lives in the services layer
 * (not components/) to match the project's layering rule: services can touch
 * the DOM directly but must not import from the components tree.
 *
 * Content comes only from a whitelist-resolved plan name (see
 * checkout-plan-names.ts) and static copy shipped in this file. Raw server
 * text NEVER reaches the dialog — it goes to Sentry via the error taxonomy
 * reporter instead.
 */

import { showCheckoutConfirmDialog } from './checkout-dialog-factory';

const DIALOG_ID = 'wm-duplicate-subscription-dialog';

const SUPPORT_EMAIL = 'support@worldmonitor.app';

export interface DuplicateSubscriptionDialogOptions {
  /** Whitelisted display name for the already-active plan (e.g., "Pro Monthly"). */
  planDisplayName: string;
  /**
   * True when the blocked checkout targeted Pro Business. The 409 payload names
   * the plan the user ALREADY has, never the one they were trying to buy, so
   * the caller resolves this — see `isProBusinessCheckoutTarget` in checkout.ts.
   */
  isProBusinessUpgrade?: boolean;
  /** User clicked "Open billing portal". */
  onConfirm: () => void;
  /** User clicked "Dismiss" or the backdrop. */
  onDismiss: () => void;
}

/**
 * Body copy for the dialog.
 *
 * Pro Business is the one blocked pairing that is really an upgrade attempt.
 * Pro and Pro Business are separate Dodo products (not an updatable
 * collection), so "open the portal to manage it" is a dead end there — the
 * portal cannot perform the change. That variant spells out the two steps
 * instead, plus what happens to the term they already paid for (the backend
 * carve-out lets the re-purchase through the moment Pro is cancelled, so they
 * are not waiting for the period to end) and a human to ask.
 *
 * Exported for the copy test — runtime callers go through the dialog.
 */
export function buildDuplicateSubscriptionBody(options: {
  planDisplayName: string;
  isProBusinessUpgrade?: boolean;
}): string {
  const { planDisplayName } = options;
  if (options.isProBusinessUpgrade === true) {
    return (
      `Your account already has an active ${planDisplayName} subscription. ` +
      'Pro Business is a separate plan, so the upgrade takes two steps: cancel ' +
      `${planDisplayName} in the billing portal, then start the Pro Business ` +
      "checkout again — you don't have to wait for your current term to end. " +
      `Your ${planDisplayName} access continues until the term you've already ` +
      'paid for runs out, and Pro Business starts a new billing cycle as soon ' +
      `as you buy it. Need a hand? Email ${SUPPORT_EMAIL}.`
    );
  }
  return `Your account already has an active ${planDisplayName} subscription. Open the billing portal to manage it — you won't be charged twice.`;
}

/**
 * Render the duplicate-subscription dialog. Idempotent: a second
 * call while a dialog is already mounted is a no-op — the first
 * dialog's callbacks remain in effect.
 */
export function showDuplicateSubscriptionDialog(options: DuplicateSubscriptionDialogOptions): void {
  showCheckoutConfirmDialog({
    id: DIALOG_ID,
    title: 'Subscription already active',
    body: buildDuplicateSubscriptionBody(options),
    confirmLabel: 'Open billing portal',
    dismissLabel: 'Dismiss',
    onConfirm: options.onConfirm,
    onDismiss: options.onDismiss,
  });
}
