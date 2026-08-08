/**
 * Frontend entitlement service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time entitlement
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 */

import {
  getConvexClient,
  getConvexApi,
  waitForConvexAuth,
  waitForConvexAuthForUser,
} from './convex-client';
import { getCurrentClerkUser } from './clerk';

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    planLimits?: {
      apiRequestsPerDay: number | null;
      apiBurstRequestsPerMinute: number | null;
      mcpCallsPerDay: number | null;
      mcpBurstRequestsPerMinute: number | null;
      dashboardAiCallsPerDay?: number | null;
    };
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    /**
     * Pro MCP access (plan 2026-05-10-001). Undefined on legacy entitlement
     * snapshots that pre-date the catalog field. `hasFeature('mcpAccess')`
     * coerces undefined → false via Boolean(), so the settings tab
     * fails-closed for unrefreshed Pro users (they'll see it appear once
     * Dodo's next webhook repopulates the field).
     */
    mcpAccess?: boolean;
    /**
     * Data-export entitlement (plan 2026-07-25-001). This controls the locked
     * state while `exportFormats` controls which CSV/JSON/PDF actions the
     * unlocked menu exposes; `tier` cannot discriminate because Pro Business
     * shares tier 1 with Pro.
     * Undefined on legacy snapshots: the export gate treats undefined on a
     * `tier >= 2` snapshot as entitled (permanent fail-open) so a stale row
     * never locks a paying customer out of their own data.
     */
    dataExport?: boolean;
  };
  validUntil: number;
}

// Module-level state
let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let initialized = false;
let unsubscribeFn: (() => void) | null = null;

/**
 * Fan a new snapshot out to every subscriber, isolating failures.
 *
 * One listener must not block the rest: subscribers are independent UI
 * surfaces, and an unguarded loop silently stops updating every listener
 * registered after the one that threw — a failure with no error path, since
 * the survivors just quietly hold their last verdict. Both emission sites
 * (the Convex watch below and `resetEntitlementState`) route through here so
 * they cannot drift apart on that guarantee.
 */
function notifyListeners(state: EntitlementState | null): void {
  for (const cb of listeners) {
    try {
      cb(state);
    } catch (err) {
      console.warn('[entitlements] listener threw; continuing fan-out:', err);
    }
  }
}

/**
 * Initialize the entitlement subscription for the authenticated user.
 * Idempotent — calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initEntitlementSubscription(
  _userId?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const isExpectedAccount = (): boolean => (
    isCurrent() && (_userId === undefined || getCurrentClerkUser()?.id === _userId)
  );
  if (initialized || !isExpectedAccount()) return;

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

    // Wait for Convex to confirm auth before subscribing. Otherwise the first
    // getEntitlementsForUser snapshot runs unauthenticated and returns
    // FREE_TIER_DEFAULTS, which can race with the post-payment panel gating
    // decision (the UI renders as free before the auth-ready pro snapshot
    // arrives). Unauthenticated visitors time out after 10s and we skip the
    // subscription entirely — they don't need entitlement updates.
    const authed = _userId
      ? await waitForConvexAuthForUser(_userId, 10_000)
      : await waitForConvexAuth(10_000);
    if (!authed) {
      console.log('[entitlements] Convex auth not established — skipping subscription');
      return;
    }
    if (!isExpectedAccount()) return;

    const watch = client.onUpdate(
      api.entitlements.getEntitlementsForUser,
      {},
      (result: EntitlementState | null) => {
        if (!isExpectedAccount()) return;
        currentState = result;
        notifyListeners(result);
      },
      (err: Error) => {
        if (!isExpectedAccount()) return;
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
 *
 * Notifies listeners with `null` so UI that subscribed via onEntitlementChange
 * (e.g. Pro banner #5728) re-evaluates immediately. Without this, a sign-out
 * that only cleared state left free-tier surfaces stuck on the previous
 * account's premium snapshot until the next real Convex update.
 */
export function resetEntitlementState(): void {
  currentState = null;
  notifyListeners(null);
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
 * The "is this a paying user" predicate, over an injected snapshot and clock.
 *
 * Split out of `isEntitled()` so tests can evaluate the REAL rule against a
 * snapshot they control — `currentState` is module-private and has no setter,
 * so the alternative is re-implementing these three conditions in a mock,
 * where they silently drift the moment this rule changes (#5632).
 */
export function isEntitlementActive(
  state: EntitlementState | null,
  now: number,
): boolean {
  return state !== null && state.planKey !== 'free' && state.validUntil >= now;
}

/**
 * Simple "is this a paying user" check.
 * Returns true if entitlement data exists, plan is not free, and hasn't expired.
 */
export function isEntitled(): boolean {
  return isEntitlementActive(currentState, Date.now());
}

/**
 * Decides whether to reload the page when an entitlement snapshot arrives.
 *
 * Rules:
 *   - First snapshot ever (last === null): never reload. A legacy-pro user
 *     whose first snapshot is already `true` must not trigger a reload loop
 *     on every page load.
 *   - Free → pro transition (last === false, next === true): reload. This is
 *     the post-payment activation case — panels rendered against free-tier
 *     gating need to re-render to pick up the new entitlement.
 *   - Everything else (free→free, pro→pro, pro→free): no reload.
 */
export function shouldReloadOnEntitlementChange(
  last: boolean | null,
  next: boolean,
): boolean {
  return last === false && next === true;
}
