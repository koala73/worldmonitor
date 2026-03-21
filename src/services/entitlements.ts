/**
 * Frontend entitlement service with reactive ConvexClient subscription.
 *
 * Lazy-loads ConvexClient to avoid impacting initial bundle size.
 * Subscribes to real-time entitlement updates via Convex WebSocket.
 * Falls back gracefully when VITE_CONVEX_URL is not configured or
 * ConvexClient is unavailable.
 */

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

// Module-level state (typed as any to avoid importing ConvexClient at module level)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;
let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let initialized = false;

/**
 * Initialize the entitlement subscription for a given user.
 * Idempotent — calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initEntitlementSubscription(userId: string): Promise<void> {
  if (initialized) return;

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  if (!convexUrl) {
    console.log('[entitlements] No VITE_CONVEX_URL — skipping Convex subscription');
    return;
  }

  try {
    // Lazy-load ConvexClient and generated api to keep initial bundle small
    const { ConvexClient } = await import('convex/browser');
    const { api } = await import('../../convex/_generated/api');

    client = new ConvexClient(convexUrl);

    client.onUpdate(
      api.entitlements.getEntitlementsForUser,
      { userId },
      (result: EntitlementState | null) => {
        currentState = result;
        for (const cb of listeners) cb(result);
      },
    );

    initialized = true;
  } catch (err) {
    console.error('[entitlements] Failed to initialize Convex subscription:', err);
    // Do not rethrow — entitlement service failure must not break the dashboard
  }
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
