/**
 * Persistent billing-state banner (né payment-failure banner).
 *
 * Pre-#4771 this only handled `subscription.status === "on_hold"`. It now
 * renders one banner per derived billing UX state (billing-state.ts):
 *   - on_hold: the original red "Payment failed" banner, byte-identical
 *     copy/action/dismiss key (issue #4771 requires it stay intact).
 *   - renewal_verification_pending: amber "verifying your renewal" notice,
 *     so a paying user whose local renewal evidence went stale is not
 *     silently downgraded to generic free-tier UX.
 *   - renewal_verification_failed: red "couldn't verify" with Manage Billing.
 *   - a hard-bounced billing email: amber notice naming the address with an
 *     inline "Fix billing email" form, or that form's button added to the
 *     banner the state already shows.
 * free/active/lapsed render no banner (lapsed copy lives in the panel CTA).
 *
 * Auto-updates via the reactive Convex subscription + entitlement watches.
 * Each state has its own sessionStorage dismissal key so dismissing the
 * pending notice never suppresses a later payment-failure alert.
 *
 * Attaches event listeners directly to DOM elements (not via setContent)
 * to avoid debounce issues with Panel.setContent().
 */

import { getAuthState } from '@/services/auth-state';
import { extractBillingErrorKind } from '@/services/_billing-error';
import {
  getSubscription,
  onSubscriptionChange,
  openBillingPortal,
  prereserveBillingPortalTab,
  updateBillingEmail,
} from '@/services/billing';
import {
  BILLING_BANNER_DISMISS_KEYS,
  deriveBillingUxState,
  getBillingBannerVariant,
  getBillingEmailErrorKey,
  suggestBillingEmail,
  type BillingBannerAction,
} from '@/services/billing-state';
import { getEntitlementState, onEntitlementChange } from '@/services/entitlements';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


const BANNER_ID = 'payment-failure-banner';

const ACTION_BUTTON_IDS: Record<BillingBannerAction['kind'], string> = {
  'billing-portal': 'pf-update-btn',
  'fix-billing-email': 'pf-fix-email-btn',
};

function buttonStyle(accent: string): string {
  return `background:#fff;color:${accent};border:none;border-radius:4px;padding:4px 12px;font-weight:600;font-size:calc(12px * var(--wm-panel-effective-scale, 1));cursor:pointer;white-space:nowrap;`;
}

function openPortal(): void {
  // Pre-reserve portal tab synchronously to survive popup blocker.
  const reservedWin = prereserveBillingPortalTab();
  // openBillingPortal is specified never to reject for recoverable nav
  // failures; this catch is belt-and-suspenders so a future throw cannot
  // become an unhandledrejection on the billing CTA (WORLDMONITOR-11C).
  void openBillingPortal(reservedWin).catch(() => {});
}

/**
 * Swap the banner's content for the repair form. The address is user data:
 * every element here is built with createElement/textContent, never the
 * trusted template. On success the confirmation stays until the reactive
 * subscription update drops the bounce flag and removes the banner.
 */
function showBillingEmailForm(banner: HTMLElement, accent: string, bouncedEmail: string, onCancel: () => void): void {
  const form = document.createElement('form');
  form.id = 'pf-email-form';
  Object.assign(form.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' });

  const label = document.createElement('label');
  label.htmlFor = 'pf-email-input';
  label.textContent = t('components.billingState.billingEmailLabel');

  const input = document.createElement('input');
  input.id = 'pf-email-input';
  input.type = 'email';
  input.required = true;
  input.autocomplete = 'email';
  input.value = suggestBillingEmail(bouncedEmail, getAuthState().user?.email ?? '');
  input.style.cssText = 'padding:4px 8px;border-radius:4px;border:none;font-size:13px;min-width:220px;';

  const save = document.createElement('button');
  save.type = 'submit';
  save.id = 'pf-email-save-btn';
  save.style.cssText = buttonStyle(accent);
  save.textContent = t('components.billingState.save');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.id = 'pf-email-cancel-btn';
  cancel.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.6);border-radius:4px;padding:4px 12px;cursor:pointer;';
  cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', onCancel);

  const error = document.createElement('span');
  error.id = 'pf-email-error';
  error.setAttribute('role', 'alert');
  error.style.cssText = 'flex-basis:100%;font-weight:600;';

  const setBusy = (busy: boolean): void => {
    input.disabled = busy;
    save.disabled = busy;
    cancel.disabled = busy;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.textContent = '';
    setBusy(true);
    void updateBillingEmail(input.value.trim()).then(
      (result) => {
        const done = document.createElement('span');
        done.id = 'pf-email-updated';
        done.textContent = t('components.billingState.billingEmailUpdated', { email: result.email });
        banner.replaceChildren(done);
      },
      (err: unknown) => {
        error.textContent = t(getBillingEmailErrorKey(extractBillingErrorKind(err)));
        setBusy(false);
        input.focus();
      },
    );
  });

  form.append(label, input, save, cancel, error);
  banner.replaceChildren(form);
  input.focus();
}

/**
 * Initialize the billing-state banner.
 * Listens to subscription AND entitlement changes and shows/hides the banner
 * reactively. Returns an unsubscribe function to clean up when the layout is
 * destroyed.
 */
export function initPaymentFailureBanner(): () => void {
  const render = (): void => {
    const sub = getSubscription();
    const state = deriveBillingUxState(sub, getEntitlementState(), Date.now());
    const variant = getBillingBannerVariant(state, sub?.billingEmailBounced === true);
    const billingEmail = sub?.billingEmail ?? '';
    const existing = document.getElementById(BANNER_ID);
    // Which variant the current DOM banner renders, tagged on the element
    // itself (dismiss keys are unique per state) — no parallel state to sync.
    const existingVariant = existing?.dataset.variant ?? null;

    // No banner for this state — remove and clear dismissal flags so the
    // next episode (e.g. a new payment failure months later) shows again.
    if (!variant) {
      if (existing) existing.remove();
      try {
        for (const key of BILLING_BANNER_DISMISS_KEYS) sessionStorage.removeItem(key);
      } catch { /* noop */ }
      return;
    }

    // Don't show if this state's banner was dismissed this session. A
    // banner left over from a DIFFERENT state is stale — remove it.
    try {
      if (sessionStorage.getItem(variant.dismissKey) === '1') {
        if (existing) existing.remove();
        return;
      }
    } catch { /* noop */ }

    // Don't duplicate; rebuild only when the state or the named address
    // changed. An open repair form survives either, so a webhook landing
    // mid-typing cannot wipe the input.
    if (existing) {
      if (existingVariant === variant.dismissKey
        && (existing.dataset.email === billingEmail || existing.querySelector('#pf-email-form'))) return;
      existing.remove();
    }

    const accent = variant.tone === 'warning' ? '#b45309' : '#dc2626';

    // Create banner
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.dataset.variant = variant.dismissKey;
    banner.dataset.email = billingEmail;
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '99998',
      padding: '10px 20px',
      background: accent,
      color: '#fff',
      fontSize: '13px',
      textAlign: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexWrap: 'wrap',
      gap: '12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });

    // Labels resolve through i18n (same components.billingState.* keys as
    // the panel CTA, so the two surfaces cannot drift). Our own locale
    // strings, never user input — safe for the trusted template. The message
    // is filled in below as text because it can carry the bounced address.
    const actionButtons = variant.actions
      .map((action) => `<button id="${ACTION_BUTTON_IDS[action.kind]}" data-action="${action.kind}" style="${buttonStyle(accent)}">${t(action.labelKey)}</button>`)
      .join('');
    setTrustedHtml(banner, trustedHtml(`
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span id="pf-message"></span>
      ${actionButtons}
      <button id="pf-dismiss-btn" aria-label="${t('common.dismiss')}" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:calc(18px * var(--wm-panel-effective-scale, 1));padding:0 4px;line-height:1;">&times;</button>
    `, "legacy direct innerHTML migration"));
    const message = banner.querySelector<HTMLSpanElement>('#pf-message');
    if (message) message.textContent = t(variant.messageKey, { email: billingEmail });

    document.body.appendChild(banner);

    // Attach event listeners directly (avoid debounced setContent per project memory)
    const handlers: Record<BillingBannerAction['kind'], () => void> = {
      'billing-portal': openPortal,
      'fix-billing-email': () => showBillingEmailForm(banner, accent, banner.dataset.email ?? '', () => {
        banner.remove();
        render();
      }),
    };
    for (const action of variant.actions) {
      banner.querySelector(`#${ACTION_BUTTON_IDS[action.kind]}`)
        ?.addEventListener('click', handlers[action.kind]);
    }

    const dismissBtn = document.getElementById('pf-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        banner.remove();
        try { sessionStorage.setItem(variant.dismissKey, '1'); } catch { /* noop */ }
      });
    }
  };

  const unsubscribeSubscription = onSubscriptionChange(() => render());
  const unsubscribeEntitlement = onEntitlementChange(() => render());
  return () => {
    unsubscribeSubscription();
    unsubscribeEntitlement();
  };
}
