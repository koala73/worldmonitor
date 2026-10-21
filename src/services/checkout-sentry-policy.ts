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

/**
 * Marks an event as a failure first-party code caught and chose to report.
 *
 * Load-bearing, not decorative. The checkout transport's 15s budget rejects
 * with a browser-minted DOMException whose stack is the header line alone, so
 * the zero-frame gate in `src/bootstrap/sentry-init.ts` drops it — along with
 * the same transport's `Failed to fetch` and WebKit's `Fetch is aborted` — as
 * extension noise unless a `kind` tag is present. Without it every checkout
 * timeout, a terminal and revenue-losing failure, is invisible
 * (WORLDMONITOR-Q4).
 */
export const CHECKOUT_REPORT_KIND = 'checkout_request_failed';

export interface CheckoutReportTagInput {
  action: string;
  code: string;
  /** Cloudflare ray id, when the failed response carried one. */
  cfRay?: string;
  /** `server` response header — names the emitting edge. */
  upstreamServer?: string;
}

/**
 * Build the Sentry tag block for a checkout error report.
 *
 * Extracted from `reportCheckoutError` so a test can assert the real object
 * rather than grep the file: a source-text regex for the kind literal matches
 * it just as happily inside `extra`, and `beforeSend` reads only `tags.kind`,
 * so moving the key one field over would leave every test green and production
 * dark. Lives here rather than in checkout.ts so the assertion costs no Clerk
 * or Dodo import.
 */
export function buildCheckoutReportTags(input: CheckoutReportTagInput): Record<string, string> {
  return {
    component: 'dodo-checkout',
    action: input.action,
    code: input.code,
    kind: CHECKOUT_REPORT_KIND,
    // Promote cf-ray and server so they are filterable in the Sentry UI
    // without opening the event. cf-ray presence alone is definitive for
    // Cloudflare emission. WORLDMONITOR-RN.
    ...(input.cfRay ? { cfRay: input.cfRay } : {}),
    ...(input.upstreamServer ? { upstreamServer: input.upstreamServer } : {}),
  };
}
