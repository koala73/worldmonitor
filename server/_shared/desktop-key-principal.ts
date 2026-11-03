/**
 * What a validated `wm_` principal may reach, given its kind and its owner's
 * entitlement (plan 2026-10-25-001, KTD4 / KTD5 / R5 / R8). Shared by the
 * gateway's #4611 gate and `resolvePremiumCallerIdentity` so the two agree.
 *
 * Kind routes before plan:
 *   - `api` key, owner has current apiAccess        → `api` (today's path, untouched)
 *   - `desktop` key, owner has current apiAccess    → `desktop`, no cap: API
 *     plans sell 0 desktop slots, so the R8/AE7 upgrade case cannot be ranked
 *     against one (the key keeps Pro-session treatment, still never API scope)
 *   - either kind, owner lacks apiAccess but is admitted by the predicate (a
 *     Pro / Pro Business owner, or a downgraded API customer) → `desktop` for
 *     the owner's OLDEST active keys up to `maxDesktopKeys`, by the rank
 *     Convex reports; the rest are denied, not revoked (R5: a Pro Business
 *     owner with three desktop keys who drops to Pro keeps two). An absent
 *     rank is denied — fail closed; desktop rows cannot predate the rank, and
 *     for a generic key that is also today's answer.
 *   - anything else → denied; the caller renders the billing contract.
 */

import {
  DESKTOP_KEY_API_ONLY_ERROR,
  DESKTOP_KEY_LIMIT_ERROR,
  admitsDesktopKeyPrincipal,
} from '../../shared/desktop-key-access.js';
import { hasCurrentEntitlementCoverage } from './entitlement-coverage.js';
import { getEntitlements, type CachedEntitlements } from './entitlement-check.js';
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
  // R8 / AE7: a desktop key whose owner moved up to an API plan. That plan has
  // no desktop slots to rank against, so the key is admitted as is.
  if (apiAccessCovered) return { scope: 'desktop' };

  const cap = entitlement.features.maxDesktopKeys;
  const rank = principal.activeKeyRank;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0) {
    return { scope: 'denied', reason: 'rank_unknown' };
  }
  if (typeof cap === 'number' && Number.isInteger(cap) && rank < cap) return { scope: 'desktop' };
  return { scope: 'denied', reason: 'over_cap' };
}

/**
 * True when the desktop decision for `principal` cannot be made from `ent`
 * because the entry predates the `desktopKeyAccess` field: a current tier>=1
 * row with the field absent (undefined, not false). The api-access decision
 * never needs the field, so an `api` key whose owner has current apiAccess is
 * settled without it; for anyone else the shared predicate would read the
 * absence as false and deny a paying Pro owner until the entry expired.
 */
export function needsDesktopKeyShape(
  principal: UserKeyScopeInput,
  ent: CachedEntitlements | null | undefined,
  now = Date.now(),
): boolean {
  if (!ent || !hasCurrentEntitlementCoverage(ent, now)) return false;
  if (ent.features.tier < 1) return false;
  if (principal.keyKind === 'api' && ent.features.apiAccess === true) return false;
  return ent.features.desktopKeyAccess === undefined;
}

/**
 * The owner's entitlement for a `wm_`-key decision. One ordinary cached read;
 * when that read is a pre-deploy entry the desktop decision cannot use (see
 * `needsDesktopKeyShape`), a second read that treats such an entry as a miss
 * goes through Convex, which rewrites the cache in the merged shape. Scoped to
 * the key path so an API customer's legacy entry is never refetched for a
 * decision that does not need it.
 */
export async function resolveUserKeyEntitlement(
  userId: string,
  principal: UserKeyScopeInput,
): Promise<CachedEntitlements | null> {
  const ent = await getEntitlements(userId);
  if (!needsDesktopKeyShape(principal, ent)) return ent;
  return getEntitlements(userId, { requireDesktopKeyShape: true });
}

/** Re-exported so the gateway and premium-check keep one import for the scope verdicts and their copy. */
export { DESKTOP_KEY_API_ONLY_ERROR, DESKTOP_KEY_LIMIT_ERROR };
