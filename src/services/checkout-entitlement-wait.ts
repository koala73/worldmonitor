/**
 * Post-checkout entitlement wait for the checkout-success banner.
 *
 * The buyer lands here straight back from Dodo's HOSTED checkout, so the page
 * is a cold load: Clerk must hydrate, then Convex must authenticate, then the
 * entitlement subscription must deliver. That whole chain is what this state
 * machine is waiting on.
 *
 * WORLDMONITOR-PZ / #6760 is what it is shaped around. The first version
 * subscribed to `onEntitlementChange` and nothing else, then tore the
 * subscription down at the deadline. Production showed that losing all three
 * bets at once is routine: of the timeout events carrying a Clerk id, three
 * users held an ACTIVE `pro_monthly` whose subscription period had already
 * started BEFORE Sentry recorded the timeout — one of them 2 m 19 s before. The
 * money and the entitlement were right; only the banner was wrong.
 *
 * So the wait now settles on three independent signals rather than one:
 *
 *  1. A change event (the fast path, unchanged).
 *  2. A POLL of `isEntitled()`. A change event only fires on a TRANSITION the
 *     page observed. An entitlement that was already true when the
 *     subscription finally authenticated produces no transition at all, and the
 *     event-only wait waits forever. This is the same late-hydration bet the
 *     email watcher in `checkout.ts` already hedges by polling Clerk.
 *  3. A RE-CHECK at the deadline, before any failure is announced. Cheap, and
 *     it is the single case the production data showed most often.
 *
 * And a deadline is no longer terminal: the wait keeps watching for
 * `lateGraceMs` afterwards, so a genuinely slow activation still flips the
 * banner back to `active` instead of stranding the buyer on a failure message
 * until they reload.
 *
 * Shape: pure DI module. Entitlement access and every timer are injected so the
 * state machine is testable without a DOM, a network, or `checkout.ts`'s
 * dependency graph (which pulls `dodopayments-checkout`). Same shape and same
 * reason as `entitlement-watchdog.ts`.
 *
 * See tests/checkout-entitlement-wait.test.mts.
 */

export type EntitlementWaitState = 'active' | 'timeout';

export interface EntitlementWaitDeps {
  /** Current entitlement verdict. `isEntitled` from `entitlements.ts`. */
  isEntitled: () => boolean;
  /** Subscribe to entitlement transitions. Returns an unsubscribe. */
  onEntitlementChange: (listener: () => void) => () => void;
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  /**
   * Fired on every settled state change, in order. `timeout` may be followed
   * by `active` when a late activation lands inside the grace window; neither
   * state is ever reported twice.
   */
  onState: (state: EntitlementWaitState) => void;
  /**
   * Fired exactly once, when the deadline passes AND the re-check confirms
   * there is still no entitlement. This is the telemetry signal — it must stay
   * rare enough to mean something, so it deliberately does not fire for a wait
   * that was merely slow.
   */
  onTimeoutReport: () => void;
}

export interface EntitlementWaitConfig {
  /** How long to wait before declaring the activation timed out. */
  timeoutMs: number;
  /** How often to re-read `isEntitled()` while waiting. */
  pollMs: number;
  /** How long to keep watching after the deadline for a late activation. */
  lateGraceMs: number;
}

/**
 * Start waiting for the post-checkout entitlement.
 *
 * Returns a cleanup that tears down every watcher. Safe to call twice.
 */
export function startEntitlementWait(
  config: EntitlementWaitConfig,
  deps: EntitlementWaitDeps,
): () => void {
  if (deps.isEntitled()) {
    deps.onState('active');
    return () => {};
  }

  let done = false;
  let unsubscribe: (() => void) | null = null;
  let deadlineHandle: number | null = null;
  let pollHandle: number | null = null;
  let graceHandle: number | null = null;

  const stopAll = (): void => {
    done = true;
    unsubscribe?.();
    unsubscribe = null;
    if (deadlineHandle !== null) {
      deps.clearTimeout(deadlineHandle);
      deadlineHandle = null;
    }
    if (pollHandle !== null) {
      deps.clearInterval(pollHandle);
      pollHandle = null;
    }
    if (graceHandle !== null) {
      deps.clearTimeout(graceHandle);
      graceHandle = null;
    }
  };

  /** Settle on `active` if the entitlement is present. Returns whether it settled. */
  const settleIfEntitled = (): boolean => {
    if (done) return false;
    if (!deps.isEntitled()) return false;
    stopAll();
    deps.onState('active');
    return true;
  };

  deadlineHandle = deps.setTimeout(() => {
    deadlineHandle = null;
    // Re-check BEFORE announcing a failure. The production data says the
    // entitlement is frequently already active at this exact moment.
    if (settleIfEntitled()) return;
    if (done) return;
    deps.onState('timeout');
    deps.onTimeoutReport();
    // Keep watching. The banner stays on screen either way, so a late
    // activation should still be able to correct it.
    graceHandle = deps.setTimeout(() => {
      graceHandle = null;
      stopAll();
    }, config.lateGraceMs);
  }, config.timeoutMs);

  pollHandle = deps.setInterval(() => {
    settleIfEntitled();
  }, config.pollMs);

  unsubscribe = deps.onEntitlementChange(() => {
    settleIfEntitled();
  });

  return stopAll;
}
