/**
 * Transient red banner shown when a Dodo checkout return carries
 * ?status=failed|declined|cancelled. Offers a single-click retry that
 * reopens the overlay with the exact product the user just tried to
 * buy (read from LAST_CHECKOUT_ATTEMPT_KEY).
 *
 * Styling mirrors payment-failure-banner.ts so the two red banners
 * feel like one visual family. They never co-fire — payment-failure
 * watches on_hold subscriptions, this one fires on return-URL status.
 */

import * as Sentry from '@sentry/browser';
import {
  clearCheckoutAttempt,
  loadCheckoutAttempt,
  startCheckout,
} from '@/services/checkout';

const BANNER_ID = 'checkout-failure-banner';

/**
 * Show the checkout-failure banner. Idempotent: a second call while
 * a banner is already mounted is a no-op.
 *
 * Caller provides the raw Dodo status string so the Sentry event
 * carries diagnostic context. We never render the raw status to the
 * user — PR-3 will introduce a typed taxonomy for that.
 */
export function showCheckoutFailureBanner(rawStatus: string): void {
  if (document.getElementById(BANNER_ID)) return;

  Sentry.captureMessage('Dodo checkout declined', {
    level: 'warning',
    tags: { component: 'dodo-checkout', status: rawStatus },
  });

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

  const attempt = loadCheckoutAttempt();
  const hasRetryTarget = !!attempt?.productId;
  // Retry button is omitted when we have no product context (stale
  // attempt cleared, private-browsing storage, cross-device flow).
  // User can still dismiss and use the /pro pricing page normally.
  const retryButton = hasRetryTarget
    ? `<button id="cf-retry-btn" style="background:#fff;color:#dc2626;border:none;border-radius:4px;padding:4px 12px;font-weight:600;font-size:12px;cursor:pointer;white-space:nowrap;">Try again</button>`
    : '';

  banner.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span>Payment couldn't be completed. No charge was made.</span>
    ${retryButton}
    <button id="cf-dismiss-btn" aria-label="Dismiss" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:18px;padding:0 4px;line-height:1;">&times;</button>
  `;

  document.body.appendChild(banner);

  if (hasRetryTarget && attempt) {
    const retryBtn = document.getElementById('cf-retry-btn') as HTMLButtonElement | null;
    retryBtn?.addEventListener('click', async () => {
      // Do NOT remove the banner yet — keep it mounted so the user has
      // somewhere to land if retry fails (bad network, Clerk unavailable,
      // edge endpoint 5xx). Swap retry into a "retrying…" state so the
      // user sees progress, then only remove on confirmed success. On
      // failure, re-enable so they can try again or dismiss.
      if (retryBtn) {
        retryBtn.disabled = true;
        retryBtn.setAttribute('aria-busy', 'true');
        retryBtn.textContent = 'Retrying…';
      }
      let succeeded = false;
      try {
        succeeded = await startCheckout(
          attempt.productId,
          {
            referralCode: attempt.referralCode,
            discountCode: attempt.discountCode,
          },
          { fallbackToPricingPage: false },
        );
      } catch {
        succeeded = false;
      }
      if (succeeded) {
        banner.remove();
      } else if (retryBtn) {
        retryBtn.disabled = false;
        retryBtn.removeAttribute('aria-busy');
        retryBtn.textContent = 'Retry';
      }
    });
  }

  const dismissBtn = document.getElementById('cf-dismiss-btn');
  dismissBtn?.addEventListener('click', () => {
    clearCheckoutAttempt('dismissed');
    banner.remove();
  });
}
