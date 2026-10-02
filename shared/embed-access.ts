/**
 * Who may MINT a partner-embed key.
 *
 * One predicate, two callers: `convex/embedKeys.ts` gates issuance on it and
 * `server/_shared/embed-key.ts` re-exports it for the edge. Named rather than
 * inlined so the rule cannot be re-implemented slightly differently at a second
 * call site — the drift `src/services/entitlements.ts` documents at #5632.
 *
 * It lives in `shared/` and not in `server/_shared/embed-key.ts` because Convex
 * bundles the import graph: that module imports `./redis`, whose top-level
 * `parseTimeoutEnv(process.env…)` call esbuild will not shake out, and which
 * pulls in `usage.ts` and `client-ip.ts` behind it. One bad module fails the
 * whole `convex deploy` push and strands every other pending convex/ change —
 * the failure class `tests/convex-entrypoint-hygiene.test.mjs` exists for.
 * `shared/` is already the cross-boundary home `convex/apiKeys.ts` imports from.
 *
 * This gates ISSUING a key, not embedding itself — a keyless, throttled,
 * attributed embed for the free tier is a separate surface.
 */

/**
 * The intersection of what a Convex `entitlements` row and the edge's
 * `CachedEntitlements` both carry. Structural on purpose: neither side has to
 * convert, and adding a field to either cannot silently change this gate.
 */
export interface EmbedAccessEntitlement {
  features: { tier: number; embedAccess?: boolean };
  validUntil: number;
}

/**
 * True when `entitlement` may mint an embed key at `now`.
 *
 * `embedAccess` must be the MERGED value. It is optional on the type because
 * entitlement rows written before the catalog field existed omit it, and
 * `undefined` here is fail-closed — so a caller reading a stored row raw
 * (rather than through `mergeEntitlementFeatures` / the Convex read path) would
 * deny every existing paid subscriber. `convex/embedKeys.ts` merges first for
 * exactly this reason.
 *
 * `tier >= 1` is checked alongside the flag rather than trusting it alone: the
 * flag is what a pricing change edits and what the paywall ledger can see, the
 * tier is the floor that no catalog typo can lower.
 */
export function hasEmbedAccess(
  entitlement: EmbedAccessEntitlement | null | undefined,
  now: number,
): boolean {
  if (!entitlement) return false;
  return (
    entitlement.features.tier >= 1 &&
    entitlement.features.embedAccess === true &&
    entitlement.validUntil >= now
  );
}

export function hasAccountEmbedAccess(
  role: 'free' | 'pro' | undefined,
  entitlement: EmbedAccessEntitlement | null | undefined,
  now: number,
): boolean {
  return role === 'pro' || hasEmbedAccess(entitlement, now);
}
