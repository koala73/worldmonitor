/**
 * Canonical user identity for the browser.
 *
 * Provides a single getUserId() that all payment/entitlement code should use
 * instead of reading localStorage keys directly. Resolution order:
 *
 *   1. Clerk auth (when VITE_CLERK_PUBLISHABLE_KEY is configured)
 *   2. Legacy wm-pro-key from localStorage
 *   3. Stable anonymous ID (auto-generated, persisted in localStorage)
 *
 * This module is the "identity bridge" between checkout, billing,
 * entitlement subscriptions, and the auth provider.
 */

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
  // 1. Clerk auth — when the Clerk branch merges, this becomes:
  //    const clerk = window.Clerk;
  //    if (clerk?.user?.id) return clerk.user.id;

  // 2. Legacy wm-pro-key
  try {
    const proKey = localStorage.getItem(LEGACY_PRO_KEY);
    if (proKey) return proKey;
  } catch { /* SSR or restricted context */ }

  // 3. Stable anonymous ID — always available
  return getOrCreateAnonId();
}

/**
 * Returns true if any user identity is available.
 */
export function hasUserIdentity(): boolean {
  return getUserId() !== null;
}
