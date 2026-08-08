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
 * free/active/lapsed render no banner (lapsed copy lives in the panel CTA).
 *
 * Auto-updates via the reactive Convex subscription + entitlement watches.
 * Each state has its own sessionStorage dismissal key so dismissing the
 * pending notice never suppresses a later payment-failure alert.
 *
 * Attaches event listeners directly to DOM elements (not via setContent)
 * to avoid debounce issues with Panel.setContent().
 */

import { getSubscription, onSubscriptionChange, openBillingPortal, prereserveBillingPortalTab } from '@/services/billing';
import {
  BILLING_BANNER_DISMISS_KEYS,
  deriveBillingUxState,
  getBillingBannerVariant,
} from '@/services/billing-state';
import { getEntitlementState, onEntitlementChange } from '@/services/entitlements';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


const BANNER_ID = 'payment-failure-banner';

/**
 * Initialize the billing-state banner.
 * Listens to subscription AND entitlement changes and shows/hides the banner
 * reactively. Returns an unsubscribe function to clean up when the layout is
 * destroyed.
 */
export function initPaymentFailureBanner(): () => void {
  const render = (): void => {
    const state = deriveBillingUxState(getSubscription(), getEntitlementState(), Date.now());
    const variant = getBillingBannerVariant(state);
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

    // Don't duplicate; rebuild only when the state changed.
    if (existing) {
      if (existingVariant === variant.dismissKey) return;
      existing.remove();
    }

    const accent = variant.tone === 'warning' ? '#b45309' : '#dc2626';

    // Create banner
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.dataset.variant = variant.dismissKey;
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
      gap: '12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });

    // Message/label resolve through i18n (same components.billingState.*
    // keys as the panel CTA, so the two surfaces cannot drift). Our own
    // locale strings, never user input — safe for the trusted template.
    const actionBtn = variant.actionLabelKey
      ? `<button id="pf-update-btn" style="background:#fff;color:${accent};border:none;border-radius:4px;padding:4px 12px;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;">${t(variant.actionLabelKey)}</button>`
      : '';
    setTrustedHtml(banner, trustedHtml(`
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>${t(variant.messageKey)}</span>
      ${actionBtn}
      <button id="pf-dismiss-btn" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:18px;padding:0 4px;line-height:1;">&times;</button>
    `, "legacy direct innerHTML migration"));

    document.body.appendChild(banner);

    // Attach event listeners directly (avoid debounced setContent per project memory)
    const updateBtn = document.getElementById('pf-update-btn');
    if (updateBtn && variant.action === 'billing-portal') {
      updateBtn.addEventListener('click', () => {
        // Pre-reserve portal tab synchronously to survive popup blocker.
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin);
      });
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
