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

/**
 * The side effects the signed-out branch performs, injected by the caller.
 *
 * `startCheckout` supplies the real implementations (sessionStorage writes,
 * `window.location.assign`, Clerk's `openSignIn`); tests supply a recorder.
 */
export interface NoUserPathHandlers {
  navigate: (url: string) => void;
  persistIntent: () => void;
  persistAttempt: () => void;
  openSignIn: () => void;
}

/**
 * Executes the signed-out branch: WHICH effects run, and in WHAT ORDER.
 *
 * The decision above is pure, but for #5380-High-3 that was not enough — the
 * ordering and the "redirect must not persist" contract lived only in
 * `checkout.ts`'s inline if/else, where no test could reach them. Two
 * mutations proved it: persisting inside the redirect branch, and moving
 * `openSignIn()` above the persist calls, each restored a real bug with the
 * suite green.
 *
 * Keeping the sequencing here (rather than a source-grep guard over
 * `checkout.ts`) makes both mutations executable failures: the caller is
 * reduced to a handler literal that binds each effect to its implementation.
 * Persisting BEFORE `openSignIn()` is load-bearing — Clerk's post-auth
 * listener fires as soon as sign-in resolves and reads the pending intent.
 */
export function runNoUserPath(
  fallbackToPricingPage: boolean,
  handlers: NoUserPathHandlers,
): void {
  const outcome = decideNoUserPathOutcome(fallbackToPricingPage);
  if (outcome.kind === 'redirect-pro') {
    handlers.navigate(outcome.redirectUrl);
    return;
  }
  handlers.persistIntent();
  handlers.persistAttempt();
  handlers.openSignIn();
}
