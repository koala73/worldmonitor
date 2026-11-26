/**
 * In-place Pro → Pro Business upgrade for the /pro page.
 *
 * Mirrors src/services/pro-business-upgrade-dialog.ts for this sealed build
 * (no src/ imports, no Convex client): it calls the edge route
 * /api/pro-business-upgrade, which relays to the same Convex action. The copy
 * functions below hand-mirror src/services/pro-business-upgrade-copy.ts and
 * are pinned by tests/pro-business-upgrade-copy.test.mts.
 */

import * as Sentry from '@sentry/react';
import { createTimeoutSignal } from './timeout-signal';

export const IN_PLACE_UPGRADE_SOURCE_PLANS: ReadonlySet<string> = new Set(['pro_monthly', 'pro_annual']);

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

// One shape rather than a union: this build's tsconfig does not narrow on `ok`.
interface UpgradeCallResult {
  ok: boolean;
  data: { kind?: unknown } & Partial<UpgradePreview>;
  error: string;
}

async function callUpgrade(apiBase: string, token: string, confirm: boolean): Promise<UpgradeCallResult> {
  try {
    const resp = await fetch(`${apiBase}/pro-business-upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(confirm ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      },
      body: JSON.stringify({ confirm }),
      signal: createTimeoutSignal(25_000),
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
        // Clerk tokens live ~60 s; the user may have read the dialog longer.
        const freshToken = await options.getToken();
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
