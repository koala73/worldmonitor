/**
 * Who may HOLD a desktop key, and whether a desktop-key principal is admitted.
 *
 * A desktop key is a `wm_` key that gives the official desktop app or a
 * self-built desktop copy what a signed-in Pro session gets, minus the API-only
 * surfaces (plan 2026-10-25-001). This file is the one place that rule is
 * written. Convex (key creation), edge TypeScript, and the self-contained
 * `api/*.js` entries all import it, which is why it is plain JavaScript with a
 * `.d.ts` beside it rather than a `.ts` module — the same pairing as
 * `shared/bootstrap-tier-keys.js`. Semantics follow `shared/embed-access.ts`.
 *
 * Both predicates read the MERGED features (`mergeEntitlementFeatures`, or the
 * Convex read path that applies it). Rows written before `desktopKeyAccess`
 * existed omit the flag, and `undefined` here is fail-closed, so a caller that
 * reads a stored row raw would deny every existing Pro subscriber.
 */

/**
 * True when `entitlement` may hold (create or keep using) desktop keys at `now`.
 *
 * `tier >= 1` is checked alongside the flag: the flag is what a pricing change
 * edits and what the paywall ledger can see; the tier is the floor no catalog
 * typo can lower.
 *
 * @param {import('./desktop-key-access').DesktopKeyEntitlement | null | undefined} entitlement
 * @param {number} now
 * @returns {boolean}
 */
export function hasDesktopKeyAccess(entitlement, now) {
  if (!entitlement) return false;
  return (
    entitlement.features.tier >= 1 &&
    entitlement.features.desktopKeyAccess === true &&
    entitlement.validUntil >= now
  );
}

/**
 * True when a request made WITH a desktop key may proceed for this owner.
 *
 * A key's kind is fixed at creation and decides its scope before the owner's
 * plan does (R8): an owner who upgraded from Pro to an API plan keeps a working
 * desktop key, still at desktop scope. So the owner is admitted when covered
 * and either `desktopKeyAccess` or `apiAccess` is true. This answers admission
 * only; it never widens a desktop key to API-plan scope.
 *
 * @param {import('./desktop-key-access').DesktopKeyEntitlement | null | undefined} entitlement
 * @param {number} now
 * @returns {boolean}
 */
export function admitsDesktopKeyPrincipal(entitlement, now) {
  if (!entitlement) return false;
  const { features } = entitlement;
  return (
    features.tier >= 1 &&
    entitlement.validUntil >= now &&
    (features.desktopKeyAccess === true || features.apiAccess === true)
  );
}

/**
 * Denial copy shared by every surface that turns a desktop-key verdict into a
 * response (gateway, premium-check, bootstrap). Defined once here because the
 * self-contained `api/*.js` entries cannot import `server/`, and two copies of
 * one sentence drift.
 */
/** 403 body for a key beyond the owner's `maxDesktopKeys` (R5 / AE6). */
export const DESKTOP_KEY_LIMIT_ERROR = 'Desktop key limit reached for this account';
/** 403 body for a desktop principal on an API-only path (KTD7). */
export const DESKTOP_KEY_API_ONLY_ERROR = 'This endpoint requires an API plan';
