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

export interface DuplicateSubscriptionDialogOptions {
  /** Whitelisted display name for the already-active plan (e.g., "Pro Monthly"). */
  planDisplayName: string;
  /** User clicked "Open billing portal". */
  onConfirm: () => void;
  /** User clicked "Dismiss" or the backdrop. */
  onDismiss: () => void;
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
    body: `Your account already has an active ${options.planDisplayName} subscription. Open the billing portal to manage it — you won't be charged twice.`,
    confirmLabel: 'Open billing portal',
    dismissLabel: 'Dismiss',
    onConfirm: options.onConfirm,
    onDismiss: options.onDismiss,
  });
}
