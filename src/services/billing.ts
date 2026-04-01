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
import { getUserId } from './user-identity';

export interface SubscriptionInfo {
  planKey: string;
  displayName: string;
  status: 'active' | 'on_hold' | 'cancelled' | 'expired';
  currentPeriodEnd: number; // epoch ms, renewal date
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
export async function initSubscriptionWatch(userId?: string): Promise<void> {
  if (initialized) return;

  const resolvedUserId = userId ?? getUserId();
  if (!resolvedUserId) {
    console.warn('[billing] No user identity -- skipping subscription watch');
    return;
  }

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
      { userId: resolvedUserId },
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
  // Keep listeners intact — PanelLayout registers them once and expects them
  // to survive auth transitions. Only the Convex transport is torn down.
}

/**
 * Returns the current subscription info, or null if not yet loaded.
 */
export function getSubscription(): SubscriptionInfo | null {
  return currentSubscription;
}

/**
 * Open the Dodo Customer Portal in a new tab.
 *
 * Calls the Convex getCustomerPortalUrl action to get a personalized portal
 * session URL. Falls back to the generic Dodo customer portal on error.
 */
export async function openBillingPortal(): Promise<void> {
  try {
    const client = await getConvexClient();
    if (!client) {
      window.open('https://customer.dodopayments.com', '_blank');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      window.open('https://customer.dodopayments.com', '_blank');
      return;
    }

    const result = await client.action(api.payments.billing.getCustomerPortalUrl, {});

    if (result && result.portal_url) {
      window.open(result.portal_url, '_blank');
    } else {
      window.open('https://customer.dodopayments.com', '_blank');
    }
  } catch (err) {
    console.warn('[billing] Failed to get customer portal URL, falling back:', err);
    window.open('https://customer.dodopayments.com', '_blank');
  }
}
