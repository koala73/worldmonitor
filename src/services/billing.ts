/**
 * Frontend billing service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time subscription
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 *
 * Follows the same lazy reactive pattern as entitlements.ts.
 */

import { getConvexClient, getConvexApi } from './convex-client';
import { getProWidgetKey } from './widget-store';

export interface SubscriptionInfo {
  planKey: string;
  displayName: string;
  status: 'active' | 'on_hold' | 'cancelled' | 'expired';
  currentPeriodEnd: number; // epoch ms, renewal date
  dodoSubscriptionId: string;
  dodoProductId: string;
}

// Module-level state
let currentSubscription: SubscriptionInfo | null = null;
let subscriptionLoaded = false;
const listeners = new Set<(sub: SubscriptionInfo | null) => void>();
let initialized = false;
let unsubscribeConvex: (() => void) | null = null;

/**
 * Initialize the subscription watch for a given user.
 * Idempotent -- calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initSubscriptionWatch(userId: string): Promise<void> {
  if (initialized) return;

  try {
    const client = await getConvexClient();
    if (!client) {
      console.warn('[billing] No VITE_CONVEX_URL -- skipping subscription watch');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      console.warn('[billing] Could not load Convex API -- skipping subscription watch');
      return;
    }

    unsubscribeConvex = client.onUpdate(
      api.payments.billing.getSubscriptionForUser,
      { userId },
      (result: SubscriptionInfo | null) => {
        currentSubscription = result;
        subscriptionLoaded = true;
        for (const cb of listeners) cb(result);
      },
    );

    initialized = true;
  } catch (err) {
    console.error('[billing] Failed to initialize subscription watch:', err);
    // Do not rethrow -- billing service failure must not break the dashboard
  }
}

/**
 * Register a callback for subscription changes.
 * If subscription state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onSubscriptionChange(
  cb: (sub: SubscriptionInfo | null) => void,
): () => void {
  listeners.add(cb);

  // Late subscribers get the current value immediately (including null if loaded)
  if (subscriptionLoaded) {
    cb(currentSubscription);
  }

  return () => {
    listeners.delete(cb);
  };
}

/**
 * Tear down the subscription watch. Call from PanelLayout.destroy() for cleanup.
 */
export function destroySubscriptionWatch(): void {
  if (unsubscribeConvex) {
    unsubscribeConvex();
    unsubscribeConvex = null;
  }
  initialized = false;
  subscriptionLoaded = false;
  currentSubscription = null;
  listeners.clear();
}

/**
 * Returns the current subscription info, or null if not yet loaded.
 */
export function getSubscription(): SubscriptionInfo | null {
  return currentSubscription;
}

/**
 * Open the Dodo Customer Portal in a new tab.
 * Falls back to the generic Dodo customer portal if the action fails.
 */
export async function openBillingPortal(): Promise<void> {
  try {
    const client = await getConvexClient();
    const api = await getConvexApi();

    if (!client || !api) {
      console.warn('[billing] ConvexClient unavailable -- opening fallback portal');
      window.open('https://customer.dodopayments.com', '_blank');
      return;
    }

    const userId = getProWidgetKey();
    if (!userId) {
      console.warn('[billing] No user ID found -- opening fallback portal');
      window.open('https://customer.dodopayments.com', '_blank');
      return;
    }

    const result = await client.action(api.payments.billing.getCustomerPortalUrl, { userId });

    if (result && result.portal_url && result.portal_url.startsWith('https://')) {
      window.open(result.portal_url, '_blank');
    } else {
      window.open('https://customer.dodopayments.com', '_blank');
    }
  } catch (err) {
    console.warn('[billing] Failed to get portal URL, opening fallback:', err);
    window.open('https://customer.dodopayments.com', '_blank');
  }
}

/**
 * Change the user's subscription plan.
 * Returns { success: true } on success, { success: false } on error.
 */
export async function changePlan(newProductId: string): Promise<{ success: boolean }> {
  try {
    const client = await getConvexClient();
    const api = await getConvexApi();

    if (!client || !api) {
      console.error('[billing] ConvexClient unavailable -- cannot change plan');
      return { success: false };
    }

    const userId = getProWidgetKey();
    if (!userId) {
      console.error('[billing] No user ID found -- cannot change plan');
      return { success: false };
    }

    const result = await client.action(api.payments.billing.changePlan, {
      userId,
      newProductId,
      prorationMode: 'prorated_immediately',
    });

    return result ?? { success: false };
  } catch (err) {
    console.error('[billing] Failed to change plan:', err);
    return { success: false };
  }
}
