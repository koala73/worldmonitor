/**
 * Structured-error introspection for `payments/billing:getCustomerPortalUrl`.
 *
 * Mirrors the edge-runtime `extractConvexErrorKind` helper in
 * `api/_convex-error.js`, scoped to the data shapes this Convex action
 * produces: `{ kind: 'NO_CUSTOMER' | 'DODO_API_KEY_MISSING' |
 * 'USER_ID_REQUIRED' }`.
 *
 * Zero deps so it can be unit-tested from `node --test` without pulling
 * the rest of `src/services/billing.ts`' browser-only import graph
 * (Sentry SDK, Convex client) into the test runner.
 */

/**
 * Extract the structured `kind` field from a thrown Convex object-data
 * ConvexError, falling back to a legacy substring match on the message
 * during the deploy-ordering window where the browser bundle and the
 * Convex action may briefly disagree on the throw shape.
 *
 * Returns null when neither path matches — letting the caller default
 * unknown shapes to error-level Sentry capture.
 */
export function extractBillingErrorKind(err: unknown): string | null {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === 'object' && 'kind' in data) {
    const kind = (data as Record<string, unknown>).kind;
    if (typeof kind === 'string') return kind;
  }
  // Legacy substring fallback for the deploy-ordering window where the
  // browser bundle ships ahead of the Convex action update (or vice-versa).
  // Pre-fix, the action threw `new Error('No Dodo customer found for this
  // user')`; if a stale Convex deployment is still serving that text we
  // can still classify the event correctly. Removable once both layers
  // have soaked on the structured-throw rollout.
  const msg = err instanceof Error ? err.message : '';
  if (/No Dodo customer found for this user/.test(msg)) return 'NO_CUSTOMER';
  return null;
}
