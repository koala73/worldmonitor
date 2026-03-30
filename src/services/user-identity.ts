/**
 * Canonical user identity for the browser.
 *
 * Provides a single getUserId() that all payment/entitlement code should use
 * instead of reading localStorage keys directly. Resolution order:
 *
 *   1. Clerk auth (via getCurrentClerkUser() — the initialized clerkInstance)
 *   2. Legacy wm-pro-key from localStorage
 *   3. Stable anonymous ID (auto-generated, persisted in localStorage)
 *
 * This module is the "identity bridge" between checkout, billing,
 * entitlement subscriptions, and the auth provider.
 *
 * KNOWN LIMITATION — Anonymous ID persistence:
 * Before Clerk auth is wired, purchases are keyed to a random UUID stored
 * in localStorage (`wm-anon-id`). This ID is lost if the user clears
 * storage, switches browsers/devices, or uses private browsing. Once lost,
 * there is no automatic way to reconnect the purchase to the user.
 *
 * Migration path: After Clerk auth lands, the client should call
 * `claimSubscription(anonId)` (convex/payments/billing.ts) on first
 * authenticated session to reassign payment records from the anon ID to
 * the real Clerk user ID. The anon ID should be read from localStorage
 * before it is replaced by the real identity.
 *
 * @see https://github.com/koala73/worldmonitor/issues/2078
 */

import { getCurrentClerkUser } from './clerk';

const LEGACY_PRO_KEY = 'wm-pro-key';
const ANON_KEY = 'wm-anon-id';

/**
 * Returns (or creates) a stable anonymous ID for this browser.
 * Persisted in localStorage so it survives page reloads.
 * This guarantees createCheckout always has a wm_user_id for the
 * webhook identity bridge, even before the user has authenticated.
 */
export function getOrCreateAnonId(): string {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // SSR or restricted context — return a one-off UUID
    return crypto.randomUUID();
  }
}

/**
 * Returns the current user's ID, or null if no identity is available.
 *
 * All payment/entitlement code should use this instead of directly
 * reading localStorage keys.
 */
export function getUserId(): string | null {
  // 1. Clerk auth — returns real Clerk user ID when signed in
  const clerkUser = getCurrentClerkUser();
  if (clerkUser?.id) return clerkUser.id;

  // 2. Legacy wm-pro-key
  try {
    const proKey = localStorage.getItem(LEGACY_PRO_KEY);
    if (proKey) return proKey;
  } catch { /* SSR or restricted context */ }

  // 3. Stable anonymous ID — always available
  return getOrCreateAnonId();
}

/**
 * Returns true if the user has a REAL identity (not just an anonymous ID).
 * Checks for Clerk auth or legacy pro key — not the auto-generated anon ID.
 */
export function hasUserIdentity(): boolean {
  // 1. Clerk auth
  const clerkUser = getCurrentClerkUser();
  if (clerkUser?.id) return true;

  // 2. Legacy pro key
  try {
    return !!localStorage.getItem(LEGACY_PRO_KEY);
  } catch {
    return false;
  }
}
