/**
 * Persistent payment failure banner.
 *
 * Displayed when the user's subscription status is "on_hold" (payment failed).
 * Auto-removes when subscription returns to active via reactive Convex subscription.
 * Can be manually dismissed (stored in sessionStorage for current session).
 *
 * Attaches event listeners directly to DOM elements (not via setContent)
 * to avoid debounce issues with Panel.setContent().
 */

import { onSubscriptionChange, openBillingPortal } from '@/services/billing';
import type { SubscriptionInfo } from '@/services/billing';

const BANNER_ID = 'payment-failure-banner';
const DISMISS_KEY = 'pf-banner-dismissed';

/**
 * Initialize the payment failure banner.
 * Listens to subscription changes and shows/hides the banner reactively.
 * Returns an unsubscribe function to clean up when the layout is destroyed.
 */
export function initPaymentFailureBanner(): () => void {
  return onSubscriptionChange((sub: SubscriptionInfo | null) => {
    const existing = document.getElementById(BANNER_ID);

    // Remove banner if subscription is not on_hold
    if (!sub || sub.status !== 'on_hold') {
      if (existing) existing.remove();
      // Clear dismissal flag when subscription recovers
      try { sessionStorage.removeItem(DISMISS_KEY); } catch { /* noop */ }
      return;
    }

    // Don't show if already dismissed in this session
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
    } catch { /* noop */ }

    // Don't duplicate
    if (existing) return;

    // Create banner
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '99998',
      padding: '10px 20px',
      background: '#dc2626',
      color: '#fff',
      fontSize: '13px',
      textAlign: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });

    banner.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>Payment failed. Update your payment method to keep your subscription active.</span>
      <button id="pf-update-btn" style="background:#fff;color:#dc2626;border:none;border-radius:4px;padding:4px 12px;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;">Update Payment</button>
      <button id="pf-dismiss-btn" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:18px;padding:0 4px;line-height:1;">&times;</button>
    `;

    document.body.appendChild(banner);

    // Attach event listeners directly (avoid debounced setContent per project memory)
    const updateBtn = document.getElementById('pf-update-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        openBillingPortal();
      });
    }

    const dismissBtn = document.getElementById('pf-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        banner.remove();
        try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
      });
    }
  });
}
