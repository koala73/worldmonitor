/**
 * Checkout service for the /pro marketing page.
 *
 * Handles: Clerk sign-in → edge endpoint → Dodo overlay.
 * No Convex client needed — the edge endpoint handles relay.
 */

import type { Clerk } from '@clerk/clerk-js';
import type { CheckoutEvent } from 'dodopayments-checkout';

const API_BASE = 'https://api.worldmonitor.app/api';

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace";

let clerk: InstanceType<typeof Clerk> | null = null;
let pendingProductId: string | null = null;
let pendingOptions: { referralCode?: string; discountCode?: string } | null = null;
let checkoutInFlight = false;
let clerkLoadPromise: Promise<InstanceType<typeof Clerk>> | null = null;

export async function ensureClerk(): Promise<InstanceType<typeof Clerk>> {
  if (clerk) return clerk;
  if (clerkLoadPromise) return clerkLoadPromise;
  clerkLoadPromise = _loadClerk();
  return clerkLoadPromise;
}

async function _loadClerk(): Promise<InstanceType<typeof Clerk>> {
  const { Clerk: C } = await import('@clerk/clerk-js');
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set');
  clerk = new C(key);
  await clerk.load({
    appearance: {
      variables: {
        colorBackground: '#0f0f0f',
        colorInputBackground: '#141414',
        colorInputText: '#e8e8e8',
        colorText: '#e8e8e8',
        colorTextSecondary: '#aaaaaa',
        colorPrimary: '#44ff88',
        colorNeutral: '#e8e8e8',
        colorDanger: '#ff4444',
        borderRadius: '4px',
        fontFamily: MONO_FONT,
        fontFamilyButtons: MONO_FONT,
      },
      elements: {
        card: { backgroundColor: '#111111', border: '1px solid #2a2a2a', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' },
        formButtonPrimary: { color: '#000000', fontWeight: '600' },
        footerActionLink: { color: '#44ff88' },
        socialButtonsBlockButton: { borderColor: '#2a2a2a', color: '#e8e8e8', backgroundColor: '#141414' },
      },
    },
  });

  // Auto-resume checkout after sign-in
  clerk.addListener(() => {
    if (clerk?.user && pendingProductId) {
      const pid = pendingProductId;
      const opts = pendingOptions;
      pendingProductId = null;
      pendingOptions = null;
      doCheckout(pid, opts ?? {});
    }
  });

  return clerk;
}

export function initOverlay(onSuccess?: () => void): void {
  import('dodopayments-checkout').then(({ DodoPayments }) => {
    const env = import.meta.env.VITE_DODO_ENVIRONMENT;
    DodoPayments.Initialize({
      mode: env === 'live_mode' ? 'live' : 'test',
      displayType: 'overlay',
      onEvent: (event: CheckoutEvent) => {
        if (event.event_type === 'checkout.status') {
          const status = (event.data as Record<string, unknown>)?.status
            ?? ((event.data as Record<string, unknown>)?.message as Record<string, unknown>)?.status;
          if (status === 'succeeded') {
            onSuccess?.();
          }
        }
      },
    });
  }).catch((err) => {
    console.error('[checkout] Failed to load Dodo overlay SDK:', err);
  });
}

export async function startCheckout(
  productId: string,
  options?: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;

  const c = await ensureClerk();
  if (!c.user) {
    pendingProductId = productId;
    pendingOptions = options ?? null;
    c.openSignIn();
    return false;
  }

  return doCheckout(productId, options ?? {});
}

async function doCheckout(
  productId: string,
  options: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;
  checkoutInFlight = true;

  try {
    // Get Clerk token with retry
    let token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
      ?? await clerk?.session?.getToken().catch(() => null);
    if (!token) {
      await new Promise((r) => setTimeout(r, 2000));
      token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
        ?? await clerk?.session?.getToken().catch(() => null);
    }
    if (!token) {
      console.error('[checkout] No auth token after retry');
      return false;
    }

    const resp = await fetch(`${API_BASE}/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productId,
        returnUrl: 'https://worldmonitor.app',
        discountCode: options.discountCode,
        referralCode: options.referralCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[checkout] Edge error:', resp.status, err);
      return false;
    }

    const result = await resp.json();
    if (!result?.checkout_url) {
      console.error('[checkout] No checkout_url in response');
      return false;
    }

    const { DodoPayments } = await import('dodopayments-checkout');
    DodoPayments.Checkout.open({
      checkoutUrl: result.checkout_url,
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

    return true;
  } catch (err) {
    console.error('[checkout] Failed:', err);
    return false;
  } finally {
    checkoutInFlight = false;
  }
}
