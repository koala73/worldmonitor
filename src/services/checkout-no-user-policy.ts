/**
 * Pure policy decision for the signed-out branch of startCheckout().
 *
 * The contract that this function encodes — and that
 * `tests/checkout-no-user-policy.test.mts` regresses against — is:
 *
 *   fallbackToPricingPage = true  → fire-and-forget redirect to /pro,
 *                                   DO NOT persist sessionStorage state.
 *                                   /pro owns its own URL-param intent
 *                                   lifecycle; saving here would create
 *                                   a stale dashboard-side intent that a
 *                                   future unrelated sign-in would auto-
 *                                   resume into a phantom checkout.
 *
 *   fallbackToPricingPage = false → inline openSignIn() in the dashboard;
 *                                   persist pending + attempt so the
 *                                   post-auth Clerk listener can resume
 *                                   the exact checkout the user clicked.
 *
 * Extracted so callers' wiring (the actual persistence calls + redirect /
 * sign-in invocations) is testable without spinning up the full
 * checkout.ts dependency tree (Clerk, Dodo SDK, Convex).
 */

export type NoUserPathOutcome =
  | { kind: 'redirect-pro'; persist: false; redirectUrl: string }
  | { kind: 'inline-signin'; persist: true };

const PRO_URL = 'https://worldmonitor.app/pro';

export function decideNoUserPathOutcome(fallbackToPricingPage: boolean): NoUserPathOutcome {
  if (fallbackToPricingPage) {
    return { kind: 'redirect-pro', persist: false, redirectUrl: PRO_URL };
  }
  return { kind: 'inline-signin', persist: true };
}
