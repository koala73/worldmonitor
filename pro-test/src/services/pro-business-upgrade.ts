/**
 * In-place Pro → Pro Business upgrade for the /pro page.
 *
 * Mirrors src/services/pro-business-upgrade-dialog.ts for this sealed build
 * (no src/ imports, no Convex client): it calls the edge routes
 * /api/pro-business-upgrade, /api/pro-annual-switch and /api/api-starter-switch,
 * which relay to the same Convex runner. The copy functions below hand-mirror
 * src/services/pro-business-upgrade-copy.ts and src/services/api-starter-switch-copy.ts
 * and are pinned by tests/pro-business-upgrade-copy.test.mts and
 * tests/api-starter-switch-copy.test.mts.
 */

import * as Sentry from '@sentry/react';
import { createTimeoutSignal } from './timeout-signal';

export const IN_PLACE_UPGRADE_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_monthly_mcp', 'pro_annual']);

interface UpgradePreview {
  kind: 'preview';
  chargeAmount: number;
  currency: string;
  renewalAmount: number | null;
  renewalCurrency: string | null;
  renewalDate: string | null;
  billingPeriod: 'monthly' | 'annual';
}

function formatMinorAmount(amount: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    // Dodo amounts are in the currency's minor unit: cents for USD, whole yen for JPY.
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

/** Formats an ISO date as "December 7, 2026" (UTC), or null when it does not parse. */
function formatRenewalDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function buildUpgradePreviewBody(planDisplayName: string, preview: UpgradePreview): string {
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

const UPGRADE_SUCCESS_TITLE = 'Upgraded to Pro Business';
const UPGRADE_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute. Reload to see Pro Business features.';
const UPGRADE_CANCEL_SCHEDULED_BODY =
  'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then upgrade to Pro Business.';
const UPGRADE_FAILED_BODY =
  'We could not confirm the upgrade. Check your plan in the billing portal before you try again, or email support@worldmonitor.app.';
const UPGRADE_ACCOUNT_CHANGED_BODY =
  'You switched accounts after this quote. Start the upgrade again from the account you want to upgrade.';

// ── Pro Monthly → Pro Yearly switch (mirrors src/services/pro-business-upgrade-copy.ts) ──

interface SwitchPreview {
  chargeAmount: number;
  currency: string;
  renewalAmount: number | null;
  renewalCurrency: string | null;
  renewalDate: string | null;
  discounted: boolean;
  percentOff: number | null;
  /** The server takes listPrice and the accepted charge; absent from an older Convex. */
  acceptsQuoteGuards: boolean;
  /** The offer runs, but this quote is at list price. */
  offerNotApplied: boolean;
}

function buildSwitchPreviewBody(preview: SwitchPreview): string {
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const date = formatRenewalDate(preview.renewalDate);
  // The charge currency is the customer's, not the plan's: never borrow it for the renewal.
  const price = preview.renewalAmount === null || !preview.renewalCurrency
    ? 'the Pro Yearly price'
    : `${formatMinorAmount(preview.renewalAmount, preview.renewalCurrency)} a year plus any tax`;
  const renewal = date ? `It renews at ${price} on ${date}.` : `It renews at ${price}.`;
  const offer = preview.discounted && typeof preview.percentOff === 'number'
    ? `your first year at ${preview.percentOff}% off, `
    : '';
  return (
    'Your Pro Monthly subscription moves to Pro Yearly now. ' +
    `You pay ${charge} today: ${offer}` +
    'less the unused part of this month. Your billing period restarts today. ' +
    `${renewal} ` +
    "Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly."
  );
}

const SWITCH_TITLE = 'Switch to Pro Yearly';
const SWITCH_CONFIRM_LABEL = 'Switch now';
const SWITCH_DISMISS_LABEL = 'Not now';
const SWITCH_SUCCESS_TITLE = 'Switched to Pro Yearly';
const SWITCH_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute.';
const SWITCH_CANCEL_SCHEDULED_TITLE = 'Resume Pro Monthly first';
const SWITCH_CANCEL_SCHEDULED_BODY =
  'Your Pro Monthly subscription is set to cancel at the end of this period. Resume it in the billing portal first, then switch to Pro Yearly.';
const SWITCH_FAILED_TITLE = 'Switch not confirmed';
const SWITCH_FAILED_BODY =
  'We could not confirm the switch. Check your plan in the billing portal before you try again, or email support@worldmonitor.app.';
const SWITCH_ACCOUNT_CHANGED_BODY =
  'You switched accounts after this quote. Start the switch again from the account you want to move to Pro Yearly.';
const SWITCH_QUOTE_CHANGED_NOTICE =
  'The offer is no longer available and your plan has not changed. Here is the price without it.';
const SWITCH_OFFER_NOT_APPLIED_NOTICE =
  'The offer is not available for this switch. Here is the price without it.';
const SWITCH_CHARGE_CHANGED_NOTICE =
  'The price changed since your quote and your plan has not changed. Here is the new price.';
/** Typed refusals that mean the quote's price no longer holds and nothing changed. */
const SWITCH_REQUOTE_ERRORS: ReadonlySet<string> = new Set(['PROMO_ENDED', 'PROMO_CODE_REJECTED']);

// One shape rather than a union: this build's tsconfig does not narrow on `ok`.
interface UpgradeCallResult {
  ok: boolean;
  data: {
    kind?: unknown;
    fromPlanKey?: unknown;
    toPlanKey?: unknown;
    discounted?: unknown;
    percentOff?: unknown;
    acceptsQuoteGuards?: unknown;
    offerNotApplied?: unknown;
  } & Partial<Omit<UpgradePreview, 'kind'>>;
  error: string;
}

// Each plan change has its own route, so a deployment that predates the switch
// answers 404 for it instead of running a Pro Business upgrade. A failed
// switch call is never retried on the other route.
type PlanChangeRoute = 'pro-business-upgrade' | 'pro-annual-switch' | 'api-starter-switch';

async function callUpgrade(
  apiBase: string,
  token: string,
  confirm: boolean,
  extra: {
    discounted?: boolean;
    acceptedChargeAmount?: number;
    acceptedChargeCurrency?: string;
    listPrice?: true;
  } = {},
  route: PlanChangeRoute = 'pro-business-upgrade',
): Promise<UpgradeCallResult> {
  try {
    const resp = await fetch(`${apiBase}/${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(confirm ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      },
      body: JSON.stringify({ confirm, ...extra }),
      // Past the edge route's 25 s cap, so the route's answer arrives first.
      signal: createTimeoutSignal(30_000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, data: {}, error: typeof data?.error === 'string' ? data.error : `http_${resp.status}` };
    }
    return { ok: true, data, error: '' };
  } catch (err) {
    return { ok: false, data: {}, error: err instanceof Error ? err.name : 'network' };
  }
}

const DIALOG_ID = 'wm-pro-business-upgrade-dialog';

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showDialog(options: {
  title: string;
  body: string;
  confirmLabel: string;
  dismissLabel: string;
  onConfirm: () => void;
}): void {
  document.getElementById(DIALOG_ID)?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = DIALOG_ID;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99990',
    background: 'rgba(10, 10, 10, 0.72)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  });
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '20px 22px',
    maxWidth: '440px',
    width: '100%',
    color: '#e8e8e8',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  });
  card.innerHTML = `
    <h2 id="${DIALOG_ID}-title" style="font-size:16px;font-weight:600;margin:0 0 10px 0;color:#fff;">${escapeText(options.title)}</h2>
    <p style="font-size:13px;line-height:1.5;margin:0 0 18px 0;color:#c8c8c8;">${escapeText(options.body)}</p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button id="${DIALOG_ID}-dismiss" type="button" style="background:transparent;color:#aaa;border:1px solid #2a2a2a;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">${escapeText(options.dismissLabel)}</button>
      <button id="${DIALOG_ID}-confirm" type="button" style="background:#44ff88;color:#0a0a0a;border:none;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">${escapeText(options.confirmLabel)}</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  let resolved = false;
  const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
  const close = () => {
    document.removeEventListener('keydown', keyHandler, true);
    backdrop.remove();
  };
  const dismiss = () => {
    if (resolved) return;
    resolved = true;
    close();
  };
  document.addEventListener('keydown', keyHandler, true);
  const confirmBtn = document.getElementById(`${DIALOG_ID}-confirm`) as HTMLButtonElement | null;
  confirmBtn?.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onConfirm();
  });
  document.getElementById(`${DIALOG_ID}-dismiss`)?.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  confirmBtn?.focus();
}

/**
 * Previews the prorated charge, confirms, and applies the upgrade. Runs
 * `fallback` (the guided cancel-then-rebuy dialog) when no preview comes back.
 */
export async function runProBusinessUpgradeFlow(options: {
  apiBase: string;
  planDisplayName: string;
  getToken: () => Promise<string | null>;
  /** Signed-in Clerk user id; the confirm must come from the account that saw the quote. */
  getUserId: () => Promise<string | null>;
  openPortal: () => void;
  fallback: () => void;
}): Promise<void> {
  const previewUserId = await options.getUserId();
  const token = await options.getToken();
  if (!token || !previewUserId) {
    options.fallback();
    return;
  }
  const preview = await callUpgrade(options.apiBase, token, false);
  if (!preview.ok) {
    if (preview.error === 'PRO_CANCEL_SCHEDULED') {
      showDialog({
        title: 'Resume Pro first',
        body: UPGRADE_CANCEL_SCHEDULED_BODY,
        confirmLabel: 'Open billing portal',
        dismissLabel: 'Close',
        onConfirm: options.openPortal,
      });
      return;
    }
    Sentry.captureMessage('Pro Business upgrade preview unavailable', {
      level: 'warning',
      tags: { surface: 'pro-marketing', code: preview.error },
    });
    options.fallback();
    return;
  }
  const data = preview.data;
  if (
    data.kind !== 'preview' ||
    typeof data.chargeAmount !== 'number' ||
    typeof data.currency !== 'string'
  ) {
    options.fallback();
    return;
  }
  const previewData: UpgradePreview = {
    kind: 'preview',
    chargeAmount: data.chargeAmount,
    currency: data.currency,
    renewalAmount: typeof data.renewalAmount === 'number' ? data.renewalAmount : null,
    renewalCurrency: typeof data.renewalCurrency === 'string' ? data.renewalCurrency : null,
    renewalDate: typeof data.renewalDate === 'string' ? data.renewalDate : null,
    billingPeriod: data.billingPeriod === 'annual' ? 'annual' : 'monthly',
  };

  showDialog({
    title: 'Upgrade to Pro Business',
    body: buildUpgradePreviewBody(options.planDisplayName, previewData),
    confirmLabel: 'Upgrade now',
    dismissLabel: 'Not now',
    onConfirm: () => {
      void (async () => {
        // Clerk tokens live ~60 s; the user may have read the dialog longer.
        const freshToken = await options.getToken();
        // After the token: its retry reads the active session again, and the
        // account can change while it waits.
        if (await options.getUserId() !== previewUserId) {
          showDialog({
            title: 'Account changed',
            body: UPGRADE_ACCOUNT_CHANGED_BODY,
            confirmLabel: 'Close',
            dismissLabel: 'Dismiss',
            onConfirm: () => {},
          });
          return;
        }
        const applied = freshToken
          ? await callUpgrade(options.apiBase, freshToken, true)
          : { ok: false, data: {}, error: 'no_token' };
        if (applied.ok) {
          showDialog({
            title: UPGRADE_SUCCESS_TITLE,
            body: UPGRADE_SUCCESS_BODY,
            confirmLabel: 'Go to dashboard',
            dismissLabel: 'Close',
            onConfirm: () => { window.location.assign('https://www.worldmonitor.app/dashboard'); },
          });
          return;
        }
        Sentry.captureMessage('Pro Business upgrade failed', {
          level: 'warning',
          tags: { surface: 'pro-marketing', code: applied.error },
        });
        showDialog({
          title: 'Upgrade not confirmed',
          body: UPGRADE_FAILED_BODY,
          confirmLabel: 'Close',
          dismissLabel: 'Dismiss',
          onConfirm: () => {},
        });
      })();
    },
  });
}

/**
 * In-place Pro Monthly → Pro Yearly switch, mirroring runProAnnualSwitchFlow
 * in src/services/pro-business-upgrade-dialog.ts. The confirm echoes the
 * quote's `discounted` flag; on PROMO_ENDED / PROMO_CODE_REJECTED (the server
 * refused before any change) it fetches one fresh quote and shows it.
 */
export async function runProAnnualSwitchFlow(options: {
  apiBase: string;
  getToken: () => Promise<string | null>;
  getUserId: () => Promise<string | null>;
  openPortal: () => void;
  fallback: () => void;
}): Promise<void> {
  const previewUserId = await options.getUserId();
  if (!previewUserId) {
    options.fallback();
    return;
  }
  const closeOnly = (title: string, body: string): void => showDialog({
    title,
    body,
    confirmLabel: 'Close',
    dismissLabel: 'Dismiss',
    onConfirm: () => {},
  });

  // Resolves to a quote, or null after it handled the failure itself.
  const fetchQuote = async (onFailure: () => void, listPrice = false): Promise<SwitchPreview | null> => {
    const token = await options.getToken();
    const result = token
      ? await callUpgrade(options.apiBase, token, false, listPrice ? { listPrice: true } : {}, 'pro-annual-switch')
      : { ok: false, data: {}, error: 'no_token' };
    const data = result.data;
    // Only a quote for Pro Yearly may reach this dialog.
    if (
      result.ok &&
      data.kind === 'preview' &&
      data.toPlanKey === 'pro_annual' &&
      typeof data.chargeAmount === 'number' &&
      typeof data.currency === 'string'
    ) {
      return {
        chargeAmount: data.chargeAmount,
        currency: data.currency,
        renewalAmount: typeof data.renewalAmount === 'number' ? data.renewalAmount : null,
        renewalCurrency: typeof data.renewalCurrency === 'string' ? data.renewalCurrency : null,
        renewalDate: typeof data.renewalDate === 'string' ? data.renewalDate : null,
        discounted: data.discounted === true,
        percentOff: typeof data.percentOff === 'number' ? data.percentOff : null,
        acceptsQuoteGuards: data.acceptsQuoteGuards === true,
        offerNotApplied: data.offerNotApplied === true,
      };
    }
    if (result.error === 'PRO_CANCEL_SCHEDULED') {
      showDialog({
        title: SWITCH_CANCEL_SCHEDULED_TITLE,
        body: SWITCH_CANCEL_SCHEDULED_BODY,
        confirmLabel: 'Open billing portal',
        dismissLabel: 'Close',
        onConfirm: options.openPortal,
      });
      return null;
    }
    Sentry.captureMessage('Pro Yearly switch preview unavailable', {
      level: 'warning',
      tags: { surface: 'pro-marketing', code: result.error || 'unexpected_shape' },
    });
    onFailure();
    return null;
  };

  // `notice` is set on a re-quote; a re-quote is never re-quoted again. A
  // first quote that lost the running offer says so too.
  const showQuote = (quote: SwitchPreview, requoteNotice: string | null): void => {
    const requoted = requoteNotice !== null;
    const notice = requoteNotice ?? (quote.offerNotApplied ? SWITCH_OFFER_NOT_APPLIED_NOTICE : null);
    const body = buildSwitchPreviewBody(quote);
    showDialog({
      title: SWITCH_TITLE,
      body: notice ? `${notice} ${body}` : body,
      confirmLabel: SWITCH_CONFIRM_LABEL,
      dismissLabel: SWITCH_DISMISS_LABEL,
      onConfirm: () => {
        void (async () => {
          // Clerk tokens live ~60 s; the user may have read the dialog longer.
          const freshToken = await options.getToken();
          // After the token: its retry reads the active session again, and the
          // account can change while it waits.
          if (await options.getUserId() !== previewUserId) {
            closeOnly('Account changed', SWITCH_ACCOUNT_CHANGED_BODY);
            return;
          }
          const applied = freshToken
            ? await callUpgrade(options.apiBase, freshToken, true, {
              discounted: quote.discounted,
              // Only to a server whose quote says it checks the charge.
              ...(quote.acceptsQuoteGuards
                ? { acceptedChargeAmount: quote.chargeAmount, acceptedChargeCurrency: quote.currency }
                : {}),
            }, 'pro-annual-switch')
            : { ok: false, data: {}, error: 'no_token' };
          // Only a reply that says the plan is now Pro Yearly is a switch.
          if (applied.ok && applied.data.kind === 'upgraded' && applied.data.toPlanKey === 'pro_annual') {
            showDialog({
              title: SWITCH_SUCCESS_TITLE,
              body: SWITCH_SUCCESS_BODY,
              confirmLabel: 'Go to dashboard',
              dismissLabel: 'Close',
              onConfirm: () => { window.location.assign('https://www.worldmonitor.app/dashboard'); },
            });
            return;
          }
          if (!requoted && SWITCH_REQUOTE_ERRORS.has(applied.error)) {
            // Ask for the list price outright: re-sending a code the confirm
            // refused could quote it again, and the switch would never go through.
            const fresh = await fetchQuote(() => closeOnly(SWITCH_FAILED_TITLE, SWITCH_FAILED_BODY), quote.acceptsQuoteGuards);
            // The notice says the offer is gone; a fresh quote that still
            // carries it would contradict that, so it ends here instead.
            if (fresh && !fresh.discounted) showQuote(fresh, SWITCH_QUOTE_CHANGED_NOTICE);
            else if (fresh) closeOnly(SWITCH_FAILED_TITLE, SWITCH_FAILED_BODY);
            return;
          }
          // The charge grew past the one accepted; the server sent nothing.
          if (!requoted && applied.error === 'CHARGE_CHANGED') {
            const fresh = await fetchQuote(() => closeOnly(SWITCH_FAILED_TITLE, SWITCH_FAILED_BODY));
            const lostOffer = quote.discounted && fresh?.discounted !== true;
            if (fresh) showQuote(fresh, lostOffer ? SWITCH_QUOTE_CHANGED_NOTICE : SWITCH_CHARGE_CHANGED_NOTICE);
            return;
          }
          Sentry.captureMessage('Pro Yearly switch failed', {
            level: 'warning',
            tags: { surface: 'pro-marketing', code: applied.error || 'unexpected_shape' },
          });
          closeOnly(SWITCH_FAILED_TITLE, SWITCH_FAILED_BODY);
        })();
      },
    });
  };

  const quote = await fetchQuote(options.fallback);
  if (quote) showQuote(quote, null);
}

// ── Individual Pro → API Starter switch (mirrors src/services/api-starter-switch-copy.ts) ──

const API_STARTER_SWITCH_TARGET_PLANS: ReadonlySet<string> = new Set(['api_starter', 'api_starter_annual']);

interface ApiStarterSwitchPreview {
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

function buildApiStarterSwitchBody(preview: ApiStarterSwitchPreview): string {
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

const API_SWITCH_TITLE = 'Switch to API Starter';
const API_SWITCH_CONFIRM_LABEL = 'Switch now';
const API_SWITCH_DISMISS_LABEL = 'Not now';
const API_SWITCH_SUCCESS_TITLE = 'Switched to API Starter';
const API_SWITCH_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute. Then you can create an API key in Settings, under API keys.';
const API_SWITCH_CANCEL_SCHEDULED_TITLE = 'Resume Pro first';
const API_SWITCH_CANCEL_SCHEDULED_BODY =
  'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then switch to API Starter.';
const API_SWITCH_ACCOUNT_CHANGED_BODY =
  'You switched accounts after this quote. Start the switch again from the account you want to move to API Starter.';
const API_SWITCH_FAILED_TITLE = 'Switch not confirmed';
const API_SWITCH_FAILED_BODY =
  'We could not confirm the switch. Check your plan in the billing portal before you try again, or email support@worldmonitor.app.';
const API_SWITCH_CHARGE_CHANGED_NOTICE =
  'The price changed since your quote and your plan has not changed. Here is the new price.';
const API_SWITCH_UNAVAILABLE_BODY =
  'We could not price the switch right now. Try again in a few minutes, or email support@worldmonitor.app.';

/**
 * Refusals the server sends only after it picked the Pro subscription to
 * switch. The account holds one, so the purchase stops: a checkout would sell
 * it a second subscription.
 */
const API_SWITCH_HOLDER_ERRORS: ReadonlySet<string> = new Set(['UPGRADE_RATE_LIMITED', 'UPGRADE_IN_PROGRESS', 'DODO_PLAN_CHANGE_ERROR']);

/**
 * In-place individual Pro → API Starter switch, mirroring
 * runApiStarterSwitchFlow in src/services/api-starter-switch-dialog.ts. /pro
 * calls it before every signed-in API Starter checkout. 'not-switchable' means
 * no dialog was shown: the account has no Pro the server would switch, or the
 * route gave no answer about it (an older deploy answers 404), and the
 * checkout runs as before.
 */
export async function runApiStarterSwitchFlow(options: {
  apiBase: string;
  getToken: () => Promise<string | null>;
  getUserId: () => Promise<string | null>;
  openPortal: () => void;
}): Promise<'shown' | 'not-switchable'> {
  const previewUserId = await options.getUserId();
  if (!previewUserId) return 'not-switchable';
  const closeOnly = (title: string, body: string): void => showDialog({
    title,
    body,
    confirmLabel: 'Close',
    dismissLabel: 'Dismiss',
    onConfirm: () => {},
  });

  // A quote; 'shown' after this flow showed the next step; null when the
  // account has no Pro the server would switch.
  const fetchQuote = async (): Promise<ApiStarterSwitchPreview | 'shown' | null> => {
    const token = await options.getToken();
    // The token read can wait on a retry; it must belong to the account the quote is for.
    if (await options.getUserId() !== previewUserId) {
      closeOnly('Account changed', API_SWITCH_ACCOUNT_CHANGED_BODY);
      return 'shown';
    }
    const result = token
      ? await callUpgrade(options.apiBase, token, false, {}, 'api-starter-switch')
      : { ok: false, data: {}, error: 'no_token' };
    const data = result.data;
    // Only a quote for API Starter may reach this dialog.
    if (
      result.ok &&
      data.kind === 'preview' &&
      typeof data.toPlanKey === 'string' &&
      API_STARTER_SWITCH_TARGET_PLANS.has(data.toPlanKey) &&
      typeof data.chargeAmount === 'number' &&
      Number.isFinite(data.chargeAmount) &&
      typeof data.currency === 'string'
    ) {
      return {
        fromPlanKey: typeof data.fromPlanKey === 'string' ? data.fromPlanKey : '',
        chargeAmount: data.chargeAmount,
        currency: data.currency,
        renewalAmount: typeof data.renewalAmount === 'number' ? data.renewalAmount : null,
        renewalCurrency: typeof data.renewalCurrency === 'string' ? data.renewalCurrency : null,
        renewalDate: typeof data.renewalDate === 'string' ? data.renewalDate : null,
        billingPeriod: data.billingPeriod === 'annual' ? 'annual' : 'monthly',
      };
    }
    if (result.error === 'PRO_CANCEL_SCHEDULED') {
      showDialog({
        title: API_SWITCH_CANCEL_SCHEDULED_TITLE,
        body: API_SWITCH_CANCEL_SCHEDULED_BODY,
        confirmLabel: 'Open billing portal',
        dismissLabel: 'Close',
        onConfirm: options.openPortal,
      });
      return 'shown';
    }
    if (API_SWITCH_HOLDER_ERRORS.has(result.error)) {
      Sentry.captureMessage('API Starter switch preview unavailable', {
        level: 'warning',
        tags: { surface: 'pro-marketing', code: result.error },
      });
      closeOnly(API_SWITCH_TITLE, API_SWITCH_UNAVAILABLE_BODY);
      return 'shown';
    }
    return null;
  };

  // `notice` is set on a re-quote; a re-quote is never re-quoted again.
  const showQuote = (quote: ApiStarterSwitchPreview, notice: string | null): void => {
    const requoted = notice !== null;
    const body = buildApiStarterSwitchBody(quote);
    showDialog({
      title: API_SWITCH_TITLE,
      body: notice ? `${notice} ${body}` : body,
      confirmLabel: API_SWITCH_CONFIRM_LABEL,
      dismissLabel: API_SWITCH_DISMISS_LABEL,
      onConfirm: () => {
        void (async () => {
          // Clerk tokens live ~60 s; the user may have read the dialog longer.
          const freshToken = await options.getToken();
          // After the token: its retry reads the active session again, and the
          // account can change while it waits.
          if (await options.getUserId() !== previewUserId) {
            closeOnly('Account changed', API_SWITCH_ACCOUNT_CHANGED_BODY);
            return;
          }
          const applied = freshToken
            ? await callUpgrade(options.apiBase, freshToken, true, {
              acceptedChargeAmount: quote.chargeAmount,
              acceptedChargeCurrency: quote.currency,
            }, 'api-starter-switch')
            : { ok: false, data: {}, error: 'no_token' };
          // Only a reply that says the plan is now API Starter is a switch.
          if (
            applied.ok &&
            applied.data.kind === 'upgraded' &&
            typeof applied.data.toPlanKey === 'string' &&
            API_STARTER_SWITCH_TARGET_PLANS.has(applied.data.toPlanKey)
          ) {
            showDialog({
              title: API_SWITCH_SUCCESS_TITLE,
              body: API_SWITCH_SUCCESS_BODY,
              confirmLabel: 'Go to dashboard',
              dismissLabel: 'Close',
              onConfirm: () => { window.location.assign('https://www.worldmonitor.app/dashboard'); },
            });
            return;
          }
          // The charge grew past the one accepted; the server sent nothing.
          if (!requoted && applied.error === 'CHARGE_CHANGED') {
            const fresh = await fetchQuote();
            if (fresh === null) closeOnly(API_SWITCH_FAILED_TITLE, API_SWITCH_FAILED_BODY);
            else if (fresh !== 'shown') showQuote(fresh, API_SWITCH_CHARGE_CHANGED_NOTICE);
            return;
          }
          Sentry.captureMessage('API Starter switch failed', {
            level: 'warning',
            tags: { surface: 'pro-marketing', code: applied.error || 'unexpected_shape' },
          });
          closeOnly(API_SWITCH_FAILED_TITLE, API_SWITCH_FAILED_BODY);
        })();
      },
    });
  };

  const quote = await fetchQuote();
  if (quote === null) return 'not-switchable';
  if (quote !== 'shown') showQuote(quote, null);
  return 'shown';
}
