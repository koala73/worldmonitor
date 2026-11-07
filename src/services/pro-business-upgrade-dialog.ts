/**
 * In-place Pro → Pro Business upgrade flow for the dashboard.
 *
 * Reached from the checkout 409 (ACTIVE_SUBSCRIPTION_EXISTS) when a Pro
 * subscriber starts a Pro Business checkout. Instead of the old
 * cancel-then-rebuy instructions, it previews the prorated charge, asks for
 * confirmation, and moves the existing Dodo subscription to Pro Business.
 * When the preview cannot be produced, the caller's fallback (the guided
 * duplicate-subscription dialog) runs, so the user is never stranded.
 */

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { extractBillingErrorKind } from './_billing-error';
import { openBillingPortal, prereserveBillingPortalTab, requestProBusinessUpgrade } from './billing';
import { showCheckoutConfirmDialog } from './checkout-dialog-factory';
import {
  UPGRADE_CANCEL_SCHEDULED_BODY,
  UPGRADE_FAILED_BODY,
  UPGRADE_SUCCESS_BODY,
  UPGRADE_SUCCESS_TITLE,
  buildUpgradePreviewBody,
} from './pro-business-upgrade-copy';

const DIALOG_ID = 'wm-pro-business-upgrade-dialog';
const RESULT_DIALOG_ID = 'wm-pro-business-upgrade-result-dialog';

function reportUpgradeError(action: string, err: unknown): void {
  const kind = extractBillingErrorKind(err);
  enqueueSentryCall((s) => s.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { component: 'dodo-billing', action, ...(kind ? { billing_error_kind: kind } : {}) },
    level: 'warning',
  }));
}

function showResult(title: string, body: string, onConfirm: () => void = () => {}, confirmLabel = 'Done'): void {
  showCheckoutConfirmDialog({
    id: RESULT_DIALOG_ID,
    title,
    body,
    confirmLabel,
    dismissLabel: 'Close',
    onConfirm,
    onDismiss: () => {},
  });
}

/**
 * Runs the flow. Resolves after the first dialog is shown (or the fallback
 * ran). `fallback` renders the guided cancel-then-rebuy dialog.
 */
export async function runProBusinessUpgradeFlow(options: {
  planDisplayName: string;
  fallback: () => void;
}): Promise<void> {
  let preview;
  try {
    preview = await requestProBusinessUpgrade(false);
  } catch (err) {
    if (extractBillingErrorKind(err) === 'PRO_CANCEL_SCHEDULED') {
      showResult('Resume Pro first', UPGRADE_CANCEL_SCHEDULED_BODY, () => {
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin);
      }, 'Open billing portal');
      return;
    }
    reportUpgradeError('previewProBusinessUpgrade', err);
    options.fallback();
    return;
  }
  if (preview.kind !== 'preview') {
    options.fallback();
    return;
  }

  showCheckoutConfirmDialog({
    id: DIALOG_ID,
    title: 'Upgrade to Pro Business',
    body: buildUpgradePreviewBody(options.planDisplayName, preview),
    confirmLabel: 'Upgrade now',
    dismissLabel: 'Not now',
    onConfirm: () => {
      void (async () => {
        try {
          await requestProBusinessUpgrade(true);
          showResult(UPGRADE_SUCCESS_TITLE, UPGRADE_SUCCESS_BODY, () => window.location.reload(), 'Reload');
        } catch (err) {
          reportUpgradeError('applyProBusinessUpgrade', err);
          showResult('Upgrade not completed', UPGRADE_FAILED_BODY);
        }
      })();
    },
    onDismiss: () => {},
  });
}
