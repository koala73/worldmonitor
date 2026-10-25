/**
 * The intersection of what a Convex `entitlements` row and the edge's
 * `CachedEntitlements` both carry. Structural so neither side has to convert.
 * `features` must be the merged value; see `shared/desktop-key-access.js`.
 */
export interface DesktopKeyEntitlement {
  features: { tier: number; desktopKeyAccess?: boolean; apiAccess?: boolean };
  validUntil: number;
}

/** True when `entitlement` may hold desktop keys at `now`. */
export function hasDesktopKeyAccess(
  entitlement: DesktopKeyEntitlement | null | undefined,
  now: number,
): boolean;

/**
 * True when a desktop-key principal is admitted for this owner at `now`:
 * covered, and `desktopKeyAccess` or `apiAccess` (R8 upgrade case).
 */
export function admitsDesktopKeyPrincipal(
  entitlement: DesktopKeyEntitlement | null | undefined,
  now: number,
): boolean;
