/**
 * Who may focus a dashboard (#10453): scope a tab to chosen countries and a
 * date window, and share a focused team dashboard.
 *
 * One predicate for both callers — `convex/teamDashboards.ts` (publish) and
 * `src/services/entitlements.ts` (personal tabs) — so the rule cannot drift
 * between them. It lives in `shared/` for the reason `shared/embed-access.ts`
 * documents: Convex bundles the import graph, so it must stay free of server
 * modules.
 */

/** Structural: what a Convex `entitlements` row and the browser snapshot both carry. */
export interface TabFocusEntitlement {
  features: { tier: number; tabFocus?: boolean };
  validUntil: number;
}

/**
 * True when `entitlement` may focus a dashboard at `now`.
 *
 * `tabFocus` must be the MERGED value (`mergeEntitlementFeatures` or the
 * Convex read path): rows written before the catalog field existed omit it,
 * and `undefined` is fail-closed. `tier >= 1` is the floor no catalog typo
 * can lower, as in `hasEmbedAccess`.
 */
export function hasTabFocus(
  entitlement: TabFocusEntitlement | null | undefined,
  now: number,
): boolean {
  if (!entitlement) return false;
  return (
    entitlement.features.tier >= 1 &&
    entitlement.features.tabFocus === true &&
    entitlement.validUntil >= now
  );
}
