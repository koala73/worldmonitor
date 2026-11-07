/**
 * In-place Pro → Pro Business upgrade flow for the dashboard.
 *
 * Reached from the checkout 409 (ACTIVE_SUBSCRIPTION_EXISTS) when a Pro
 * subscriber starts a Pro Business checkout. Instead of the old
 * cancel-then-rebuy instructions, it previews the prorated charge, asks for
 * confirmation, and moves the existing Dodo subscription to Pro Business.
 * When the preview cannot be produced, the caller's fallback (the guided
 * duplicate-subscription dialog) runs, so the user is never stranded.
 *
 * Every service this flow needs is passed in by checkout.ts, which already
 * holds them. Importing them here would make Vite emit this chunk's whole
 * dependency graph as preload hints inside the checkout chunk (bundle budget).
 */

import type { ProBusinessUpgradeResponse } from './billing';
import type { CheckoutConfirmDialogOptions } from './checkout-dialog-factory';
import {
  IN_PLACE_UPGRADE_SOURCE_PLANS,
  UPGRADE_ACCOUNT_CHANGED_BODY,
  UPGRADE_CANCEL_SCHEDULED_BODY,
  UPGRADE_FAILED_BODY,
  UPGRADE_SUCCESS_BODY,
  UPGRADE_SUCCESS_TITLE,
  buildUpgradePreviewBody,
} from './pro-business-upgrade-copy';

const DIALOG_ID = 'wm-pro-business-upgrade-dialog';
const RESULT_DIALOG_ID = 'wm-pro-business-upgrade-result-dialog';

export interface ProBusinessUpgradeFlowOptions {
  /** Plan the user already holds, from the 409 payload. */
  planKey: unknown;
  planDisplayName: string;
  /** Renders the guided cancel-then-rebuy dialog. */
  fallback: () => void;
  requestUpgrade: (confirm: boolean) => Promise<ProBusinessUpgradeResponse>;
  /** Signed-in Clerk user id; the confirm must come from the account that saw the quote. */
  currentUserId: () => string | null | undefined;
  openPortal: () => void;
  showDialog: (options: CheckoutConfirmDialogOptions) => void;
  /** Structured ConvexError kind, e.g. PRO_CANCEL_SCHEDULED. */
  errorKind: (err: unknown) => string | null | undefined;
  reportError: (action: string, err: unknown) => void;
}

/** Resolves after the first dialog is shown, or after the fallback ran. */
export async function runProBusinessUpgradeFlow(options: ProBusinessUpgradeFlowOptions): Promise<void> {
  if (typeof options.planKey !== 'string' || !IN_PLACE_UPGRADE_SOURCE_PLANS.has(options.planKey)) {
    options.fallback();
    return;
  }

  const showResult = (title: string, body: string, onConfirm: () => void = () => {}, confirmLabel = 'Done'): void => {
    options.showDialog({
      id: RESULT_DIALOG_ID,
      title,
      body,
      confirmLabel,
      dismissLabel: 'Close',
      onConfirm,
      onDismiss: () => {},
    });
  };

  const previewUserId = options.currentUserId();
  if (!previewUserId) {
    options.fallback();
    return;
  }

  let preview: ProBusinessUpgradeResponse;
  try {
    preview = await options.requestUpgrade(false);
  } catch (err) {
    if (options.errorKind(err) === 'PRO_CANCEL_SCHEDULED') {
      showResult('Resume Pro first', UPGRADE_CANCEL_SCHEDULED_BODY, options.openPortal, 'Open billing portal');
      return;
    }
    options.reportError('previewProBusinessUpgrade', err);
    options.fallback();
    return;
  }
  if (preview.kind !== 'preview') {
    options.fallback();
    return;
  }

  options.showDialog({
    id: DIALOG_ID,
    title: 'Upgrade to Pro Business',
    body: buildUpgradePreviewBody(options.planDisplayName, preview),
    confirmLabel: 'Upgrade now',
    dismissLabel: 'Not now',
    onConfirm: () => {
      void (async () => {
        if (options.currentUserId() !== previewUserId) {
          showResult('Account changed', UPGRADE_ACCOUNT_CHANGED_BODY);
          return;
        }
        try {
          await options.requestUpgrade(true);
          showResult(UPGRADE_SUCCESS_TITLE, UPGRADE_SUCCESS_BODY, () => window.location.reload(), 'Reload');
        } catch (err) {
          options.reportError('applyProBusinessUpgrade', err);
          showResult('Upgrade not confirmed', UPGRADE_FAILED_BODY);
        }
      })();
    },
    onDismiss: () => {},
  });
}
