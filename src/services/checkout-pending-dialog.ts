/**
 * Modal confirmation dialog for the `PAYMENT_IN_PROGRESS` 409 (#4438).
 *
 * Surfaced when the user tries to start a checkout while a recent 3DS/SCA
 * payment is still pending in the same tier group. Rather than silently
 * stacking another duplicate payment (the original incident — a customer
 * stacked 4–5 payments all "Requires customer action"), we confirm: the
 * pending one may still be completing; start a NEW checkout anyway?
 *
 * Thin wrapper over the shared checkout-dialog-factory (the scaffold +
 * lifecycle live there once, shared with the duplicate-subscription dialog).
 * Content is static copy + a whitelist-resolved plan name only; raw server
 * text never reaches the dialog.
 */

import { showCheckoutConfirmDialog } from './checkout-dialog-factory';

const DIALOG_ID = 'wm-pending-payment-dialog';

export interface CheckoutPendingDialogOptions {
  /** Whitelisted display name for the plan with a pending payment (e.g., "Pro Monthly"). */
  planDisplayName: string;
  /** User clicked "Start new checkout". */
  onConfirm: () => void;
  /** User clicked "Cancel", pressed Esc, or clicked the backdrop. */
  onDismiss: () => void;
}

/**
 * Render the pending-payment dialog. Idempotent: a second call while a dialog
 * is already mounted is a no-op — the first dialog's callbacks remain in effect.
 */
export function showCheckoutPendingDialog(options: CheckoutPendingDialogOptions): void {
  showCheckoutConfirmDialog({
    id: DIALOG_ID,
    title: 'Payment in progress',
    body: `You have a ${options.planDisplayName} payment in progress. It may still be completing — if it does and you're charged twice, contact support and we'll refund the duplicate. Start a new checkout anyway?`,
    confirmLabel: 'Start new checkout',
    dismissLabel: 'Cancel',
    onConfirm: options.onConfirm,
    onDismiss: options.onDismiss,
  });
}
