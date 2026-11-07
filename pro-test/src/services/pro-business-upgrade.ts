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
  billingPeriod: 'monthly' | 'annual';
}

function formatMinorAmount(amount: number, currency: string): string {
  const major = amount / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

function buildUpgradePreviewBody(planDisplayName: string, preview: UpgradePreview): string {
  const charge = formatMinorAmount(preview.chargeAmount, preview.currency);
  const period = preview.billingPeriod === 'annual' ? 'year' : 'month';
  const renewal = preview.renewalAmount === null
    ? 'then the Pro Business price from your next renewal'
    : `then ${formatMinorAmount(preview.renewalAmount, preview.currency)} a ${period} plus any tax from your next renewal`;
  return (
    `Your ${planDisplayName} subscription moves to Pro Business now. ` +
    `You pay ${charge} today for the rest of this billing period, ${renewal}. ` +
    'If the payment fails, you stay on Pro.'
  );
}

const UPGRADE_SUCCESS_TITLE = 'Upgraded to Pro Business';
const UPGRADE_SUCCESS_BODY =
  'Your plan changes as soon as the payment confirms, usually within a minute. Reload to see Pro Business features.';
const UPGRADE_CANCEL_SCHEDULED_BODY =
  'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then upgrade to Pro Business.';
const UPGRADE_FAILED_BODY =
  'The upgrade did not go through and you have not been charged for it. Try again in a minute, or email support@worldmonitor.app.';

type UpgradeCallResult =
  | { ok: true; data: { kind?: unknown } & Partial<UpgradePreview> }
  | { ok: false; error: string };

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
      return { ok: false, error: typeof data?.error === 'string' ? data.error : `http_${resp.status}` };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : 'network' };
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
  openPortal: () => void;
  fallback: () => void;
}): Promise<void> {
  const token = await options.getToken();
  if (!token) {
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
        const applied = freshToken
          ? await callUpgrade(options.apiBase, freshToken, true)
          : { ok: false as const, error: 'no_token' };
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
          title: 'Upgrade not completed',
          body: UPGRADE_FAILED_BODY,
          confirmLabel: 'Close',
          dismissLabel: 'Dismiss',
          onConfirm: () => {},
        });
      })();
    },
  });
}
