/**
 * Pure policy helper: which `action` tags on reportCheckoutError skip the
 * Sentry emit?
 *
 * Lives in its own file so tests can import the policy without pulling the
 * Dodo SDK + Clerk + storage transitively from checkout.ts (mirrors
 * checkout-no-user-policy.ts). Never import from checkout.ts here.
 *
 * Contract: `no-user` is a pre-auth redirect UX (user clicked upgrade before
 * signing up and is routed to signup/pricing). Clerk conversion analytics
 * already tracks that funnel, so reporting it at info level just floods the
 * Sentry inbox. Every other action — `no-token`, `http-error`,
 * `missing-checkout-url`, `exception`, `entitlement-timeout` — MUST still
 * emit so mid-flight auth drops and real failures stay visible.
 *
 * Regression-tested in tests/checkout-report-error.test.mts.
 */
export const SENTRY_SKIP_ACTIONS: ReadonlySet<string> = new Set(['no-user']);

export function shouldSkipSentryForAction(action: string): boolean {
  return SENTRY_SKIP_ACTIONS.has(action);
}
