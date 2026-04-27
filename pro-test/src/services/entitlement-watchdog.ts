/**
 * Entitlement-polling watchdog for the Dodo checkout overlay.
 *
 * Context: Dodo's overlay can navigate to /status/{id}/wallet-return
 * after a successful payment (observed on subscription-trial amount=0
 * flows) and never emit a terminal postMessage (checkout.status /
 * checkout.redirect_requested) back to the parent. When that happens,
 * the merchant's onEvent handler can't tell the purchase succeeded and
 * the user is stranded on Dodo's success page forever.
 *
 * This module polls /api/me/entitlement at a fixed interval. When the
 * webhook has flipped the user to pro, `onPro` fires once. The poller
 * stops on: (1) a single onPro fire, (2) stop() call, (3) hard timeout.
 * The caller owns the onPro side effects (post-checkout cleanup,
 * overlay close, navigation).
 *
 * Shape: pure DI module. All environmental dependencies (fetch, timers,
 * clock, token source) are injected so the state machine is testable
 * without any DOM or network. See tests/entitlement-watchdog.test.mts.
 *
 * This file MUST be kept byte-identical with
 * pro-test/src/services/entitlement-watchdog.ts. The parity check in
 * tests/entitlement-watchdog-parity.test.mts enforces that. If you
 * change one, change both.
 */

export interface EntitlementWatchdogDeps {
  /** Returns a Bearer token or null if the user isn't signed in yet. */
  getToken: () => Promise<string | null>;
  /** Injected fetch — use globalThis.fetch in production, a stub in tests. */
  fetch: typeof fetch;
  /** Injected timer. Use window.setInterval in production. */
  setInterval: (handler: () => void, timeout: number) => number;
  /** Injected clearer. */
  clearInterval: (id: number) => void;
  /** Monotonic-ish clock. Use Date.now in production, a controllable stub in tests. */
  now: () => number;
  /** Fired exactly once when entitlement flips to pro. */
  onPro: () => void;
}

export interface EntitlementWatchdog {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
}

export interface EntitlementWatchdogConfig {
  /** Endpoint to poll. Must return `{ isPro: boolean }` on 200. */
  endpoint: string;
  /** Poll interval in ms. 3000ms is our production value. */
  intervalMs: number;
  /** Hard cap after which the poller self-terminates WITHOUT firing onPro. */
  timeoutMs: number;
  /** AbortSignal timeout for each individual fetch. Optional; defaults to 8000. */
  fetchTimeoutMs?: number;
}

export function createEntitlementWatchdog(
  config: EntitlementWatchdogConfig,
  deps: EntitlementWatchdogDeps,
): EntitlementWatchdog {
  let intervalId: number | null = null;
  let startedAt = 0;
  let fired = false;
  const fetchTimeoutMs = config.fetchTimeoutMs ?? 8_000;

  const stop = (): void => {
    if (intervalId !== null) {
      deps.clearInterval(intervalId);
      intervalId = null;
    }
  };

  const tick = async (): Promise<void> => {
    // Re-check inside the tick in case start/stop raced with this
    // scheduled callback. setInterval can fire one more time after
    // clearInterval in some runtimes.
    if (intervalId === null || fired) return;
    if (deps.now() - startedAt > config.timeoutMs) {
      // Hard cap. Do NOT fire onPro on timeout — if the webhook hasn't
      // landed after the cap, something else is broken and promoting
      // the user via a stale entitlement read would mask it.
      stop();
      return;
    }
    try {
      const token = await deps.getToken();
      if (!token) return;
      const resp = await deps.fetch(config.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!resp.ok) return;
      const body = (await resp.json()) as { isPro?: boolean };
      if (body.isPro && !fired) {
        fired = true;
        stop();
        deps.onPro();
      }
    } catch {
      // Swallow — poll retries on next tick. Unexpected exceptions
      // would otherwise spam Sentry once every interval for up to
      // timeoutMs.
    }
  };

  return {
    start: (): void => {
      if (intervalId !== null || fired) return;
      startedAt = deps.now();
      // Cast: the DOM lib types setInterval's return as number, the
      // Node lib types it as NodeJS.Timeout. Injected deps use number
      // because that matches window.setInterval and our fake timer.
      intervalId = deps.setInterval(() => { void tick(); }, config.intervalMs);
    },
    stop,
    isActive: (): boolean => intervalId !== null,
  };
}
