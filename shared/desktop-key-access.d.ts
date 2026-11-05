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

/** 403 body for a key beyond the owner's `maxDesktopKeys` (R5 / AE6). */
export const DESKTOP_KEY_LIMIT_ERROR: 'Desktop key limit reached for this account';
/** 403 body for a desktop principal on an API-only path (KTD7). */
export const DESKTOP_KEY_API_ONLY_ERROR: 'This endpoint requires an API plan';
/** 403 body for a desktop key sent by something other than the desktop app or a self-hosted relay. */
export const DESKTOP_KEY_CLIENT_ERROR: string;

/**
 * True when a desktop-key request may proceed given the caller's User-Agent.
 * Always true unless `mode` is `'enforce'` (env `DESKTOP_KEY_CLIENT_CHECK`).
 */
export function admitsDesktopKeyClient(
  userAgent: string | null | undefined,
  mode: string | null | undefined,
): boolean;
