/**
 * Frontend entitlement service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time entitlement
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 */

import { getConvexClient, getConvexApi } from './convex-client';

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
  };
  validUntil: number;
}

// Module-level state
let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let initialized = false;
let unsubscribeFn: (() => void) | null = null;

/**
 * Initialize the entitlement subscription for the authenticated user.
 * Idempotent — calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initEntitlementSubscription(_userId?: string): Promise<void> {
  if (initialized) return;

  try {
    const client = await getConvexClient();
    if (!client) {
      console.log('[entitlements] No VITE_CONVEX_URL — skipping Convex subscription');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      console.log('[entitlements] Could not load Convex API — skipping subscription');
      return;
    }

    const watch = client.onUpdate(
      api.entitlements.getEntitlementsForUser,
      {},
      (result: EntitlementState | null) => {
        currentState = result;
        for (const cb of listeners) cb(result);
      },
      (err: Error) => {
        console.warn('[entitlements] Subscription query error:', err.message);
      },
    );

    unsubscribeFn = watch.unsubscribe;
    initialized = true;
  } catch (err) {
    console.error('[entitlements] Failed to initialize Convex subscription:', err);
    // Do not rethrow — entitlement service failure must not break the dashboard
  }
}

/**
 * Tears down the entitlement subscription and clears all listeners.
 * Resets initialized flag so a new subscription can be started.
 * Does NOT null currentState — preserves the last known state across
 * destroy/reinit cycles (e.g. WebSocket reconnects) so paying users don't
 * see locked panels during backoff. Call resetEntitlementState() on sign-out.
 */
export function destroyEntitlementSubscription(): void {
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }
  // Keep listeners intact — PanelLayout registers them once and expects them
  // to survive auth transitions. Only the Convex transport is torn down.
  initialized = false;
}

/**
 * Explicitly nulls currentState. Call on sign-out to prevent the previous
 * user's entitlements from leaking into a subsequent session.
 * Distinct from destroyEntitlementSubscription() which preserves state for reconnects.
 */
export function resetEntitlementState(): void {
  currentState = null;
}

/**
 * Register a callback for entitlement changes.
 * If entitlement state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onEntitlementChange(
  cb: (state: EntitlementState | null) => void,
): () => void {
  listeners.add(cb);

  // Late subscribers get the current value immediately
  if (currentState !== null) {
    cb(currentState);
  }

  return () => {
    listeners.delete(cb);
  };
}

/**
 * Returns the current entitlement state, or null if not yet loaded.
 */
export function getEntitlementState(): EntitlementState | null {
  return currentState;
}

/**
 * Check whether a specific feature flag is truthy in the current entitlement state.
 */
export function hasFeature(flag: keyof EntitlementState['features']): boolean {
  if (currentState === null) return false;
  return Boolean(currentState.features[flag]);
}

/**
 * Check whether the user's tier meets or exceeds the given minimum.
 */
export function hasTier(minTier: number): boolean {
  if (currentState === null) return false;
  return currentState.features.tier >= minTier;
}

/**
 * Simple "is this a paying user" check.
 * Returns true if entitlement data exists, plan is not free, and hasn't expired.
 */
export function isEntitled(): boolean {
  return (
    currentState !== null &&
    currentState.planKey !== 'free' &&
    currentState.validUntil >= Date.now()
  );
}
