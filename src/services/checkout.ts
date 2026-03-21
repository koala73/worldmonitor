/**
 * Checkout overlay orchestration service.
 *
 * Manages the full checkout lifecycle in the vanilla TS dashboard:
 * - Lazy-initializes the Dodo Payments overlay SDK
 * - Creates checkout sessions via the Convex createCheckout action
 * - Opens the overlay with dark-theme styling matching the dashboard
 * - Handles overlay events (success, error, close)
 *
 * UI code calls startCheckout(productId) -- everything else is internal.
 */

import { DodoPayments } from 'dodopayments-checkout';
import type { CheckoutEvent } from 'dodopayments-checkout';
import { getConvexClient, getConvexApi } from './convex-client';

// Module-level state
let initialized = false;
let onSuccessCallback: (() => void) | null = null;

/**
 * Initialize the Dodo overlay SDK. Idempotent -- second+ calls are no-ops.
 * Optionally accepts a success callback that fires when payment succeeds.
 */
export function initCheckoutOverlay(onSuccess?: () => void): void {
  if (initialized) return;

  if (onSuccess) {
    onSuccessCallback = onSuccess;
  }

  const env = import.meta.env.VITE_DODO_ENVIRONMENT;

  DodoPayments.Initialize({
    mode: env === 'live_mode' ? 'live' : 'test',
    displayType: 'overlay',
    onEvent: (event: CheckoutEvent) => {
      switch (event.event_type) {
        case 'checkout.status':
          if (event.data?.status === 'succeeded') {
            onSuccessCallback?.();
          }
          break;
        case 'checkout.closed':
          // User dismissed the overlay -- no action needed
          break;
        case 'checkout.error':
          console.error('[checkout] Overlay error:', event.data?.message);
          break;
      }
    },
  });

  initialized = true;
}

/**
 * Open the Dodo checkout overlay for a given checkout URL.
 * Lazily initializes the SDK if not already done.
 */
export function openCheckout(checkoutUrl: string): void {
  initCheckoutOverlay();

  DodoPayments.Checkout.open({
    checkoutUrl,
    options: {
      manualRedirect: true,
      themeConfig: {
        dark: {
          bgPrimary: '#0d0d0d',
          bgSecondary: '#1a1a1a',
          borderPrimary: '#323232',
          textPrimary: '#ffffff',
          textSecondary: '#909090',
          buttonPrimary: '#22c55e',
          buttonPrimaryHover: '#16a34a',
          buttonTextPrimary: '#0d0d0d',
        },
        radius: '4px',
      },
    },
  });
}

/**
 * High-level checkout entry point for UI code.
 *
 * Creates a checkout session via the Convex action and opens the overlay.
 * Falls back to /pro page if Convex is unavailable.
 */
export async function startCheckout(
  productId: string,
  options?: { discountCode?: string; referralCode?: string },
): Promise<void> {
  try {
    const client = await getConvexClient();
    if (!client) {
      window.open('https://worldmonitor.app/pro', '_blank');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      window.open('https://worldmonitor.app/pro', '_blank');
      return;
    }

    const result = await client.action(api.payments.checkout.createCheckout, {
      productId,
      returnUrl: window.location.origin,
      discountCode: options?.discountCode,
      referralCode: options?.referralCode,
    });

    if (result && result.checkout_url) {
      openCheckout(result.checkout_url);
    }
  } catch (err) {
    console.error('[checkout] Failed to create checkout session:', err);
    window.open('https://worldmonitor.app/pro', '_blank');
  }
}

/**
 * Show a transient success banner at the top of the viewport.
 * Auto-dismisses after 5 seconds.
 */
export function showCheckoutSuccess(): void {
  const existing = document.getElementById('checkout-success-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'checkout-success-banner';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '99999',
    padding: '14px 20px',
    background: 'linear-gradient(135deg, #16a34a, #22c55e)',
    color: '#fff',
    fontWeight: '600',
    fontSize: '14px',
    textAlign: 'center',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    transition: 'opacity 0.4s ease, transform 0.4s ease',
    transform: 'translateY(-100%)',
    opacity: '0',
  });
  banner.textContent = 'Payment received! Unlocking your premium features...';

  document.body.appendChild(banner);

  // Animate in
  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  });

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    banner.style.transform = 'translateY(-100%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 400);
  }, 5000);
}
