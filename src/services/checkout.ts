/**
 * Checkout overlay orchestration service.
 *
 * Manages the full checkout lifecycle in the vanilla TS dashboard:
 * - Lazy-initializes the Dodo Payments overlay SDK
 * - Creates checkout sessions via the Convex createCheckout action
 * - Opens the overlay with dark-theme styling matching the dashboard
 * - Stores pending checkout intents for /pro handoff flows
 * - Handles overlay events (success, error, close)
 *
 * UI code calls startCheckout(productId) -- everything else is internal.
 */

import * as Sentry from '@sentry/browser';
import { DodoPayments } from 'dodopayments-checkout';
import type { CheckoutEvent } from 'dodopayments-checkout';
import { getConvexClient, getConvexApi, waitForConvexAuth } from './convex-client';
import { getCurrentClerkUser } from './clerk';

const CHECKOUT_PRODUCT_PARAM = 'checkoutProduct';
const CHECKOUT_REFERRAL_PARAM = 'checkoutReferral';
const CHECKOUT_DISCOUNT_PARAM = 'checkoutDiscount';
const PENDING_CHECKOUT_KEY = 'wm-pending-checkout';
const APP_CHECKOUT_BASE_URL = 'https://worldmonitor.app/';

interface PendingCheckoutIntent {
  productId: string;
  referralCode?: string;
  discountCode?: string;
}

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
          break;
        case 'checkout.error':
          console.error('[checkout] Overlay error:', event.data?.message);
          Sentry.captureMessage(`Dodo checkout overlay error: ${event.data?.message || 'unknown'}`, { level: 'error', tags: { component: 'dodo-checkout' } });
          break;
      }
    },
  });

  initialized = true;
}

/**
 * Destroy the checkout overlay — resets initialized flag and clears the
 * stored success callback so a new layout can register its own callback.
 */
export function destroyCheckoutOverlay(): void {
  initialized = false;
  onSuccessCallback = null;
}

function loadPendingCheckoutIntent(): PendingCheckoutIntent | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
    return raw ? (JSON.parse(raw) as PendingCheckoutIntent) : null;
  } catch {
    return null;
  }
}

function savePendingCheckoutIntent(intent: PendingCheckoutIntent): void {
  try {
    sessionStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(intent));
  } catch {
    // Ignore storage failures; the current page load still has the URL params.
  }
}

function clearPendingCheckoutIntent(): void {
  try {
    sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function buildCheckoutLaunchUrl(
  productId: string,
  options?: { referralCode?: string; discountCode?: string },
): string {
  const url = new URL(APP_CHECKOUT_BASE_URL);
  url.searchParams.set(CHECKOUT_PRODUCT_PARAM, productId);
  if (options?.referralCode) {
    url.searchParams.set(CHECKOUT_REFERRAL_PARAM, options.referralCode);
  }
  if (options?.discountCode) {
    url.searchParams.set(CHECKOUT_DISCOUNT_PARAM, options.discountCode);
  }
  return url.toString();
}

export function capturePendingCheckoutIntentFromUrl(): PendingCheckoutIntent | null {
  const url = new URL(window.location.href);
  const productId = url.searchParams.get(CHECKOUT_PRODUCT_PARAM);
  if (!productId) return null;

  const intent: PendingCheckoutIntent = {
    productId,
    referralCode: url.searchParams.get(CHECKOUT_REFERRAL_PARAM) ?? undefined,
    discountCode: url.searchParams.get(CHECKOUT_DISCOUNT_PARAM) ?? undefined,
  };
  savePendingCheckoutIntent(intent);

  url.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
  url.searchParams.delete(CHECKOUT_REFERRAL_PARAM);
  url.searchParams.delete(CHECKOUT_DISCOUNT_PARAM);
  const cleanUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
  window.history.replaceState({}, '', cleanUrl);

  return intent;
}

export async function resumePendingCheckout(options?: {
  openAuth?: () => void;
}): Promise<boolean> {
  const intent = loadPendingCheckoutIntent();
  if (!intent) return false;

  if (!getCurrentClerkUser()?.id) {
    options?.openAuth?.();
    return false;
  }

  clearPendingCheckoutIntent();
  await startCheckout(
    intent.productId,
    {
      referralCode: intent.referralCode,
      discountCode: intent.discountCode,
    },
    { fallbackToPricingPage: false },
  );
  return true;
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
        light: {
          bgPrimary: '#ffffff',
          bgSecondary: '#f8f9fa',
          borderPrimary: '#d4d4d4',
          textPrimary: '#1a1a1a',
          textSecondary: '#555555',
          buttonPrimary: '#16a34a',
          buttonPrimaryHover: '#15803d',
          buttonTextPrimary: '#ffffff',
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
 * Falls back to /pro page when Convex is unavailable.
 */
export async function startCheckout(
  productId: string,
  options?: { discountCode?: string; referralCode?: string },
  behavior?: { fallbackToPricingPage?: boolean },
): Promise<void> {
  const fallbackToPricingPage = behavior?.fallbackToPricingPage ?? true;

  try {
    const client = await getConvexClient();
    if (!client) {
      if (fallbackToPricingPage) {
        window.open('https://worldmonitor.app/pro', '_blank');
      }
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      if (fallbackToPricingPage) {
        window.open('https://worldmonitor.app/pro', '_blank');
      }
      return;
    }

    if (getCurrentClerkUser()) {
      const authReady = await waitForConvexAuth(10_000);
      if (!authReady) {
        console.warn('[checkout] Convex auth not ready after 10s, falling back');
        if (fallbackToPricingPage) {
          window.open('https://worldmonitor.app/pro', '_blank');
        }
        return;
      }
    }

    const result = await client.action(api.payments.checkout.createCheckout, {
      productId,
      returnUrl: window.location.origin,
      discountCode: options?.discountCode,
      referralCode: options?.referralCode,
    });

    if (result?.checkout_url) {
      openCheckout(result.checkout_url);
    }
  } catch (err) {
    console.error('[checkout] Failed to create checkout session:', err);
    Sentry.captureException(err, { tags: { component: 'dodo-checkout', action: 'createCheckout' }, extra: { productId } });
    if (fallbackToPricingPage) {
      window.open('https://worldmonitor.app/pro', '_blank');
    }
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

  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  });

  setTimeout(() => {
    banner.style.transform = 'translateY(-100%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 400);
  }, 5000);
}
