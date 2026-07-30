/**
 * Canonical user identity for the browser.
 *
 * Provides a single getUserId() that all payment/entitlement code should use
 * instead of reading localStorage keys directly. Resolution order:
 *
 *   1. Clerk auth (via getCurrentClerkUser() — the initialized clerkInstance)
 *   2. Legacy wm-pro-key through the HttpOnly-session migration helper
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
 * `claimSubscription(anonId, claimToken)` (convex/payments/billing.ts) on
 * first authenticated session to reassign payment records from the anon ID
 * to the real Clerk user ID. The anon ID and server-issued claim token
 * should be read from localStorage before they are cleared.
 *
 * @see https://github.com/koala73/worldmonitor/issues/2078
 */

import { getCurrentClerkUser } from './clerk';
import { migrateLegacyKeysToHttpOnlySession, readLegacySessionKey } from './browser-key-session';
import { getStoredAnonId, saveAnonId } from './anonymous-identity-storage';
export {
  clearStoredAnonIdentity,
  getFreshStoredAnonClaimToken,
  getStoredAnonClaimToken,
  getStoredAnonId,
  saveAnonClaimToken,
} from './anonymous-identity-storage';

let legacyProMigrationStarted = false;

function legacyProKeyForMigration(): string {
  const proKey = readLegacySessionKey('wm-pro-key');
  if (!proKey || legacyProMigrationStarted) return proKey;
  legacyProMigrationStarted = true;
  void migrateLegacyKeysToHttpOnlySession({ proKey }).catch(() => {
    legacyProMigrationStarted = false;
  });
  return proKey;
}

/**
 * Returns (or creates) a stable anonymous ID for this browser.
 * Persisted in localStorage so it survives page reloads.
 * This guarantees createCheckout always has a wm_user_id for the
 * webhook identity bridge, even before the user has authenticated.
 */
export function getOrCreateAnonId(): string {
  try {
    let id = getStoredAnonId();
    if (!id) {
      id = crypto.randomUUID();
      saveAnonId(id);
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

  // 2. Legacy wm-pro-key: preserve existing identity behavior while moving the
  // key into a server-issued HttpOnly cookie and clearing JS-readable storage.
  const proKey = legacyProKeyForMigration();
  if (proKey) return proKey;

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
  return !!legacyProKeyForMigration();
}
