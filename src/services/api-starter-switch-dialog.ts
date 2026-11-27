/**
 * In-place individual Pro → API Starter switch for the dashboard.
 *
 * Runs before an API Starter checkout and from Settings → Account. It asks
 * the server for a prorated quote first. An account the server would switch
 * gets the switch dialog instead of a second subscription. Any other account
 * resolves 'not-switchable', and the checkout caller continues to the normal
 * checkout exactly as before.
 *
 * Every service this flow needs is passed in by checkout.ts, which already
 * holds them. Importing them here would make Vite emit this chunk's whole
 * dependency graph as preload hints inside the checkout chunk (bundle budget).
 */

import type { ProBusinessUpgradeResponse } from './billing';
import type { CheckoutConfirmDialogOptions } from './checkout-dialog-factory';
import {
  API_STARTER_SWITCH_TARGET_PLANS,
  API_SWITCH_ACCOUNT_CHANGED_BODY,
  API_SWITCH_CANCEL_SCHEDULED_BODY,
  API_SWITCH_CANCEL_SCHEDULED_TITLE,
  API_SWITCH_CHARGE_CHANGED_NOTICE,
  API_SWITCH_CONFIRM_LABEL,
  API_SWITCH_DISMISS_LABEL,
  API_SWITCH_FAILED_BODY,
  API_SWITCH_FAILED_TITLE,
  API_SWITCH_SUCCESS_BODY,
  API_SWITCH_SUCCESS_TITLE,
  API_SWITCH_TITLE,
  API_SWITCH_UNAVAILABLE_BODY,
  buildApiStarterSwitchBody,
} from './api-starter-switch-copy';

const DIALOG_ID = 'wm-api-starter-switch-dialog';
const RESULT_DIALOG_ID = 'wm-api-starter-switch-result-dialog';
// The confirmed quote dialog keeps DIALOG_ID through its fade-out, and the
// factory skips an id that is still mounted, so a fresh quote needs its own id.
const REQUOTE_DIALOG_ID = 'wm-api-starter-switch-requote-dialog';

/**
 * Refusals the server sends only after it picked the Pro subscription to
 * switch. The account holds one, so the purchase stops here: a checkout
 * would sell it a second subscription.
 */
const HOLDER_ERRORS: ReadonlySet<string> = new Set(['UPGRADE_RATE_LIMITED', 'UPGRADE_IN_PROGRESS', 'DODO_PLAN_CHANGE_ERROR']);

/**
 * How long a quote may take. Every API Starter checkout waits for it, Pro
 * holder or not, so a Convex call that never settles must not hold the
 * purchase. The server's Dodo previews share 16 s; the rest is transport.
 */
export const API_STARTER_QUOTE_TIMEOUT_MS = 20_000;

/** A preview, or a confirm that names the charge the quote showed. */
export type ApiStarterSwitchRequest =
  | { confirm: false }
  | { confirm: true; acceptedChargeAmount: number; acceptedChargeCurrency: string };

export interface ApiStarterSwitchFlowOptions {
  requestSwitch: (request: ApiStarterSwitchRequest) => Promise<ProBusinessUpgradeResponse>;
  /** Signed-in Clerk user id; the confirm must come from the account that saw the quote. */
  currentUserId: () => string | null | undefined;
  openPortal: () => void;
  /** Where "Done" goes after the switch; the dashboard reloads to pick up the new plan. */
  afterSuccess: () => void;
  showDialog: (options: CheckoutConfirmDialogOptions) => void;
  /** Structured ConvexError kind, e.g. PRO_CANCEL_SCHEDULED. */
  errorKind: (err: unknown) => string | null | undefined;
  reportError: (action: string, err: unknown) => void;
  /** Runs when the user dismisses one of this flow's dialogs; a confirm never calls it. */
  onDismiss?: () => void;
  /** Overrides API_STARTER_QUOTE_TIMEOUT_MS; tests only. */
  quoteTimeoutMs?: number;
}

const QUOTE_TIMED_OUT = Symbol('quote timed out');

/** The request's reply, or QUOTE_TIMED_OUT once `ms` pass; a later reply is dropped. */
function withinQuoteTimeout<T>(request: Promise<T>, ms: number): Promise<T | typeof QUOTE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof QUOTE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(QUOTE_TIMED_OUT), ms);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/** 'shown': this flow owns the next step. 'not-switchable': no dialog was shown. */
export type ApiStarterSwitchOutcome = 'shown' | 'not-switchable';

type Quote = Extract<ProBusinessUpgradeResponse, { kind: 'preview' }>;

function isApiStarterQuote(reply: ProBusinessUpgradeResponse): reply is Quote {
  return reply.kind === 'preview'
    && API_STARTER_SWITCH_TARGET_PLANS.has(reply.toPlanKey)
    && Number.isFinite(reply.chargeAmount)
    && typeof reply.currency === 'string';
}

/** Resolves once the first dialog is shown, or with 'not-switchable' when none is. */
export async function runApiStarterSwitchFlow(options: ApiStarterSwitchFlowOptions): Promise<ApiStarterSwitchOutcome> {
  const onDismiss = (): void => { options.onDismiss?.(); };
  const showResult = (title: string, body: string, onConfirm: () => void = () => {}, confirmLabel = 'Done'): void => {
    options.showDialog({ id: RESULT_DIALOG_ID, title, body, confirmLabel, dismissLabel: 'Close', onConfirm, onDismiss });
  };

  const previewUserId = options.currentUserId();
  if (!previewUserId) return 'not-switchable';

  // A quote; 'shown' after this flow showed the next step; null when the
  // account has no Pro the server would switch.
  const fetchQuote = async (): Promise<Quote | 'shown' | null> => {
    try {
      const reply = await withinQuoteTimeout(
        options.requestSwitch({ confirm: false }),
        options.quoteTimeoutMs ?? API_STARTER_QUOTE_TIMEOUT_MS,
      );
      if (reply === QUOTE_TIMED_OUT) {
        options.reportError('previewApiStarterSwitch', new Error('quote timed out'));
        return null;
      }
      if (isApiStarterQuote(reply)) return reply;
    } catch (err) {
      const kind = options.errorKind(err);
      if (kind === 'PRO_CANCEL_SCHEDULED') {
        showResult(API_SWITCH_CANCEL_SCHEDULED_TITLE, API_SWITCH_CANCEL_SCHEDULED_BODY, options.openPortal, 'Open billing portal');
        return 'shown';
      }
      if (kind && HOLDER_ERRORS.has(kind)) {
        options.reportError('previewApiStarterSwitch', err);
        showResult(API_SWITCH_TITLE, API_SWITCH_UNAVAILABLE_BODY);
        return 'shown';
      }
    }
    return null;
  };

  const showQuote = (quote: Quote, notice: string | null): void => {
    const requoted = notice !== null;
    const body = buildApiStarterSwitchBody(quote);
    options.showDialog({
      id: requoted ? REQUOTE_DIALOG_ID : DIALOG_ID,
      title: API_SWITCH_TITLE,
      body: notice ? `${notice} ${body}` : body,
      confirmLabel: API_SWITCH_CONFIRM_LABEL,
      dismissLabel: API_SWITCH_DISMISS_LABEL,
      onConfirm: () => {
        void (async () => {
          if (options.currentUserId() !== previewUserId) {
            showResult('Account changed', API_SWITCH_ACCOUNT_CHANGED_BODY);
            return;
          }
          try {
            const applied = await options.requestSwitch({
              confirm: true,
              acceptedChargeAmount: quote.chargeAmount,
              acceptedChargeCurrency: quote.currency,
            });
            // Only a reply that says the plan is now API Starter is a switch.
            if (applied.kind !== 'upgraded' || !API_STARTER_SWITCH_TARGET_PLANS.has(applied.toPlanKey)) {
              options.reportError('applyApiStarterSwitch', new Error(`unexpected switch result: ${applied.kind}/${applied.toPlanKey}`));
              showResult(API_SWITCH_FAILED_TITLE, API_SWITCH_FAILED_BODY);
              return;
            }
            showResult(API_SWITCH_SUCCESS_TITLE, API_SWITCH_SUCCESS_BODY, options.afterSuccess, 'Done');
          } catch (err) {
            // The charge grew past the one accepted; the server sent nothing.
            if (!requoted && options.errorKind(err) === 'CHARGE_CHANGED') {
              const fresh = await fetchQuote();
              if (fresh === null) showResult(API_SWITCH_FAILED_TITLE, API_SWITCH_FAILED_BODY);
              else if (fresh !== 'shown') showQuote(fresh, API_SWITCH_CHARGE_CHANGED_NOTICE);
              return;
            }
            options.reportError('applyApiStarterSwitch', err);
            showResult(API_SWITCH_FAILED_TITLE, API_SWITCH_FAILED_BODY);
          }
        })();
      },
      onDismiss,
    });
  };

  const quote = await fetchQuote();
  if (quote === null) return 'not-switchable';
  if (quote !== 'shown') showQuote(quote, null);
  return 'shown';
}
