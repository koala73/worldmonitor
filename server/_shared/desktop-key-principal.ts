/**
 * What a validated `wm_` principal may reach, given its kind and its owner's
 * entitlement (plan 2026-10-25-001, KTD4 / KTD5 / R8). Shared by the gateway's
 * #4611 gate and `resolvePremiumCallerIdentity` so the two agree.
 *
 * Kind routes before plan:
 *   - `api` key, owner has current apiAccess        → `api` (today's path, untouched)
 *   - `desktop` key, owner admitted by the predicate → `desktop` (Pro-session treatment)
 *   - `api` key, owner lacks apiAccess but is admitted (a downgraded API
 *     customer) → `desktop` for the owner's OLDEST active keys up to
 *     `maxDesktopKeys`, by the rank Convex reports; the rest are denied, not
 *     revoked. An absent rank (an entry written before Convex carried it)
 *     is denied — fail closed, which is also today's answer for that key.
 *   - anything else → denied; the caller renders the billing contract.
 */

import { admitsDesktopKeyPrincipal } from '../../shared/desktop-key-access.js';
import { hasCurrentEntitlementCoverage } from './entitlement-coverage.js';
import type { CachedEntitlements } from './entitlement-check.js';
import type { UserApiKeyKind } from './user-api-key.js';

export type UserKeyScope =
  | { scope: 'api' }
  | { scope: 'desktop' }
  | { scope: 'denied'; reason: 'not_covered' | 'over_cap' | 'rank_unknown' };

export interface UserKeyScopeInput {
  keyKind: UserApiKeyKind;
  activeKeyRank?: number;
}

export function resolveUserKeyScope(
  principal: UserKeyScopeInput,
  entitlement: CachedEntitlements | null | undefined,
  now = Date.now(),
): UserKeyScope {
  if (!entitlement) return { scope: 'denied', reason: 'not_covered' };
  const covered = hasCurrentEntitlementCoverage(entitlement, now);
  const apiAccessCovered = covered && entitlement.features.apiAccess === true;
  if (principal.keyKind === 'api' && apiAccessCovered) return { scope: 'api' };

  // `hasCurrentEntitlementCoverage` adds what the shared predicate does not
  // know about: a provider-confirmed lapse and the verification marker.
  const desktopAdmitted = covered && admitsDesktopKeyPrincipal(entitlement, now);
  if (!desktopAdmitted) return { scope: 'denied', reason: 'not_covered' };
  if (principal.keyKind === 'desktop') return { scope: 'desktop' };

  const cap = entitlement.features.maxDesktopKeys;
  const rank = principal.activeKeyRank;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0) {
    return { scope: 'denied', reason: 'rank_unknown' };
  }
  if (typeof cap === 'number' && Number.isInteger(cap) && rank < cap) return { scope: 'desktop' };
  return { scope: 'denied', reason: 'over_cap' };
}

/** Copy for the over-cap denial; one string so the gateway and bootstrap agree. */
export const DESKTOP_KEY_LIMIT_ERROR = 'Desktop key limit reached for this account';
/** Copy for a desktop principal on an API-only path (KTD7). */
export const DESKTOP_KEY_API_ONLY_ERROR = 'This endpoint requires an API plan';
