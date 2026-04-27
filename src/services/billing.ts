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

import * as Sentry from '@sentry/browser';
import { getConvexClient, getConvexApi } from './convex-client';

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

// Convex/Clerk bootstrap rarely rejects with a non-Error value (undefined, null, string).
// Sentry serializes those as synthetic `Error: undefined` with zero frames — uninvestigable.
// Normalize to a real Error carrying the offending value both in the message (for log/search)
// and as `cause` (for Sentry's structured display) so events remain debuggable (WORLDMONITOR-ND).
function normalizeCaughtError(action: string, err: unknown): Error {
  if (err instanceof Error) return err;
  const rendered = err === undefined ? 'undefined' : String(err);
  const wrapped = new Error(`[billing] ${action} threw non-Error: ${rendered}`);
  // Attach the original thrown value as `cause` so Sentry shows it as structured data.
  // Assigned post-construction because tsconfig target=ES2020 lacks ErrorOptions typing;
  // Sentry and modern browsers read the property either way.
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

/**
 * Initialize the subscription watch for the authenticated user.
 * Idempotent -- calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initSubscriptionWatch(_userId?: string): Promise<void> {
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
      {},
      (result: SubscriptionInfo | null) => {
        currentSubscription = result;
        subscriptionLoaded = true;
        for (const cb of listeners) cb(result);
      },
      (err: Error) => {
        console.warn('[billing] Subscription query error:', err.message);
        // Clear stale cached value so getSubscription() returns null (not old plan).
        currentSubscription = null;
        subscriptionLoaded = true;
        for (const cb of listeners) cb(null);
      },
    );

    initialized = true;
  } catch (err) {
    console.error('[billing] Failed to initialize subscription watch:', err);
    // Do not rethrow -- billing service failure must not break the dashboard
    Sentry.captureException(
      normalizeCaughtError('initSubscriptionWatch', err),
      { tags: { component: 'dodo-billing', action: 'initSubscriptionWatch' } },
    );
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

const DODO_PORTAL_FALLBACK_URL = 'https://customer.dodopayments.com';

/**
 * Open the Dodo Customer Portal in a new tab.
 *
 * Calls the Convex getCustomerPortalUrl action to get a personalized portal
 * session URL. Falls back to the generic Dodo customer portal on error.
 * Returns the URL that was opened (useful for agent/programmatic callers).
 */
/**
 * Pre-reserve a blank popup tab SYNCHRONOUSLY inside a click handler so
 * the async openBillingPortal() below can navigate into it without
 * tripping the popup blocker. Browsers only trust window.open() calls
 * that happen inside a user-gesture stack; after any await, the gesture
 * is spent and window.open() returns null (blocked). Callers MUST call
 * this synchronously BEFORE awaiting anything, then pass the returned
 * handle into openBillingPortal.
 */
export function prereserveBillingPortalTab(): Window | null {
  return window.open('', '_blank', 'noopener,noreferrer');
}

export async function openBillingPortal(preopened?: Window | null): Promise<string | null> {
  const reservedWin = preopened ?? null;
  const navigate = (url: string): string => {
    if (reservedWin && !reservedWin.closed) {
      reservedWin.location.href = url;
    } else {
      const fresh = window.open(url, '_blank', 'noopener,noreferrer');
      if (!fresh) window.location.assign(url);
    }
    return url;
  };

  try {
    const client = await getConvexClient();
    if (!client) {
      return navigate(DODO_PORTAL_FALLBACK_URL);
    }

    const api = await getConvexApi();
    if (!api) {
      return navigate(DODO_PORTAL_FALLBACK_URL);
    }

    const result = await client.action(api.payments.billing.getCustomerPortalUrl, {});
    const url = (result?.portal_url as string | undefined) ?? DODO_PORTAL_FALLBACK_URL;
    return navigate(url);
  } catch (err) {
    console.warn('[billing] Failed to get customer portal URL, falling back:', err);
    Sentry.captureException(
      normalizeCaughtError('openBillingPortal', err),
      { tags: { component: 'dodo-billing', action: 'openBillingPortal' } },
    );
    return navigate(DODO_PORTAL_FALLBACK_URL);
  }
}
