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
  PRO_ANNUAL_SWITCH_SOURCE_PLAN,
  type SwitchTranslate,
  UPGRADE_ACCOUNT_CHANGED_BODY,
  UPGRADE_CANCEL_SCHEDULED_BODY,
  UPGRADE_FAILED_BODY,
  UPGRADE_SUCCESS_BODY,
  UPGRADE_SUCCESS_TITLE,
  buildSwitchPreviewBody,
  buildUpgradePreviewBody,
  joinSentences,
  switchCopy,
} from './pro-business-upgrade-copy';

const DIALOG_ID = 'wm-pro-business-upgrade-dialog';
const RESULT_DIALOG_ID = 'wm-pro-business-upgrade-result-dialog';
// The confirmed quote dialog keeps DIALOG_ID through its 200 ms fade-out, and
// the factory skips an id that is still mounted, so a fresh quote that comes
// back inside that window needs its own id.
const REQUOTE_DIALOG_ID = 'wm-pro-business-upgrade-requote-dialog';

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

/** Typed refusals that mean the quote's offer no longer holds and nothing changed. */
const SWITCH_REQUOTE_ERRORS: ReadonlySet<string> = new Set(['PROMO_ENDED', 'PROMO_CODE_REJECTED']);

/**
 * A preview, or a confirm of the quote the user saw. `listPrice` and the
 * accepted charge go only to a server whose quote set `acceptsQuoteGuards`:
 * an older Convex rejects arguments it does not know.
 */
export type ProAnnualSwitchRequest =
  | { confirm: false; listPrice?: true }
  | { confirm: true; discounted: boolean; acceptedChargeAmount?: number; acceptedChargeCurrency?: string };

export interface ProAnnualSwitchFlowOptions {
  /** Plan the user holds: the 409 payload's, or the Settings subscription's. */
  planKey: unknown;
  /** Runs when no quote comes back. */
  fallback: () => void;
  /**
   * Preview (confirm=false) or apply. The confirm echoes the quote's
   * `discounted` flag and, when the server checks it, the charge the quote
   * showed, so the server applies the price the user saw or refuses.
   */
  requestSwitch: (request: ProAnnualSwitchRequest) => Promise<ProBusinessUpgradeResponse>;
  currentUserId: () => string | null | undefined;
  openPortal: () => void;
  /** Where "Done" goes after the switch; the dashboard reloads to pick up the new plan. */
  afterSuccess: () => void;
  showDialog: (options: CheckoutConfirmDialogOptions) => void;
  errorKind: (err: unknown) => string | null | undefined;
  reportError: (action: string, err: unknown) => void;
  /** Runs when the user dismisses one of this flow's dialogs; a confirm never calls it. */
  onDismiss?: () => void;
  /** The app's `t`: every label and sentence of this flow comes from the catalog. */
  translate: SwitchTranslate;
  /** BCP 47 tag for the renewal date. Defaults to en-US. */
  locale?: string;
}

/**
 * In-place Pro Monthly → Pro Yearly switch. Same shape as the Pro Business
 * upgrade, plus quote integrity: when the offer ends or Dodo rejects its code
 * between the quote and the confirm, the server refuses with a typed error,
 * and this flow fetches a fresh quote once and shows it instead of charging a
 * price the user did not see.
 */
export async function runProAnnualSwitchFlow(options: ProAnnualSwitchFlowOptions): Promise<void> {
  if (options.planKey !== PRO_ANNUAL_SWITCH_SOURCE_PLAN) {
    options.fallback();
    return;
  }
  const onDismiss = (): void => { options.onDismiss?.(); };
  const copy = switchCopy(options.translate);
  const showResult = (title: string, body: string, onConfirm: () => void = () => {}, confirmLabel = copy.doneLabel): void => {
    options.showDialog({
      id: RESULT_DIALOG_ID,
      title,
      body,
      confirmLabel,
      dismissLabel: copy.closeLabel,
      onConfirm,
      onDismiss,
    });
  };

  const previewUserId = options.currentUserId();
  if (!previewUserId) {
    options.fallback();
    return;
  }

  // Resolves to a quote, or null after it handled the failure itself.
  const fetchQuote = async (
    onFailure: () => void,
    listPrice = false,
  ): Promise<Extract<ProBusinessUpgradeResponse, { kind: 'preview' }> | null> => {
    try {
      const quote = await options.requestSwitch(listPrice ? { confirm: false, listPrice: true } : { confirm: false });
      // Only a quote for Pro Yearly may reach this dialog.
      if (quote.kind === 'preview' && quote.toPlanKey === 'pro_annual') return quote;
    } catch (err) {
      if (options.errorKind(err) === 'PRO_CANCEL_SCHEDULED') {
        showResult(copy.cancelScheduledTitle, copy.cancelScheduledBody, options.openPortal, copy.openPortalLabel);
        return null;
      }
      options.reportError('previewProAnnualSwitch', err);
    }
    onFailure();
    return null;
  };

  // `notice` is set on a re-quote; a re-quote is never re-quoted again. A
  // first quote that lost the running offer says so too.
  const showQuote = (quote: Extract<ProBusinessUpgradeResponse, { kind: 'preview' }>, requoteNotice: string | null): void => {
    const requoted = requoteNotice !== null;
    const discounted = quote.discounted === true;
    const notice = requoteNotice ?? (quote.offerNotApplied === true ? copy.offerNotAppliedNotice : null);
    const body = buildSwitchPreviewBody(
      { ...quote, discounted, percentOff: quote.percentOff ?? null },
      options.translate,
      options.locale,
    );
    options.showDialog({
      id: requoted ? REQUOTE_DIALOG_ID : DIALOG_ID,
      title: copy.title,
      body: notice ? joinSentences([notice, body]) : body,
      confirmLabel: copy.confirmLabel,
      dismissLabel: copy.dismissLabel,
      onConfirm: () => {
        void (async () => {
          if (options.currentUserId() !== previewUserId) {
            showResult(copy.accountChangedTitle, copy.accountChangedBody);
            return;
          }
          try {
            const applied = await options.requestSwitch({
              confirm: true,
              discounted,
              ...(quote.acceptsQuoteGuards === true
                ? { acceptedChargeAmount: quote.chargeAmount, acceptedChargeCurrency: quote.currency }
                : {}),
            });
            // Only a reply that says the plan is now Pro Yearly is a switch.
            if (applied.kind !== 'upgraded' || applied.toPlanKey !== 'pro_annual') {
              options.reportError('applyProAnnualSwitch', new Error(`unexpected switch result: ${applied.kind}/${applied.toPlanKey}`));
              showResult(copy.failedTitle, copy.failedBody);
              return;
            }
            showResult(copy.successTitle, copy.successBody, options.afterSuccess, copy.doneLabel);
          } catch (err) {
            const kind = options.errorKind(err);
            if (!requoted && kind && SWITCH_REQUOTE_ERRORS.has(kind)) {
              // Ask for the list price outright: re-sending a code the confirm
              // refused could quote it again, and the switch would never go through.
              const fresh = await fetchQuote(
                () => showResult(copy.failedTitle, copy.failedBody),
                quote.acceptsQuoteGuards === true,
              );
              // The notice says the offer is gone; a fresh quote that still
              // carries it would contradict that, so it ends here instead.
              if (fresh && fresh.discounted !== true) showQuote(fresh, copy.quoteChangedNotice);
              else if (fresh) showResult(copy.failedTitle, copy.failedBody);
              return;
            }
            // The charge grew past the one accepted; the server sent nothing.
            if (!requoted && kind === 'CHARGE_CHANGED') {
              const fresh = await fetchQuote(() => showResult(copy.failedTitle, copy.failedBody));
              const lostOffer = discounted && fresh?.discounted !== true;
              if (fresh) showQuote(fresh, lostOffer ? copy.quoteChangedNotice : copy.chargeChangedNotice);
              return;
            }
            options.reportError('applyProAnnualSwitch', err);
            showResult(copy.failedTitle, copy.failedBody);
          }
        })();
      },
      onDismiss,
    });
  };

  const quote = await fetchQuote(options.fallback);
  if (quote) showQuote(quote, null);
}
