import type { Page } from '@playwright/test';

/**
 * #6501 — make the next "Target page, context or browser has been closed"
 * name its own cause.
 *
 * Two smoke specs have lost the browser during their FIRST `page.goto`, with
 * a trace that ends mid-navigation: no `after` record, zero network events,
 * no DOM snapshot. A Playwright trace records the client side of the
 * protocol, so when the target vanishes it cannot say whether the renderer
 * crashed, the browser process exited, or the context was closed — and those
 * three have three different fixes (per-spec workers vs GPU flags vs a
 * harness bug).
 *
 * This helper separates them for the window that keeps dying: attach it
 * before the boot navigation, dispose it once boot settles. Any terminal
 * signal INSIDE that window prints one timestamped `[browser-loss]` line in
 * the step log (which rides the uploaded artifacts); after dispose, ordinary
 * per-test teardown closes the context silently as it always did. It
 * deliberately changes no behavior — no retries, no timeouts, no navigation —
 * per the issue's "only after (1)–(3) identify the cause should a fix be
 * attempted".
 */
export interface BrowserLossEvents {
  /** Renderer for THIS page crashed (the page object survives to report it). */
  onCrash(listener: () => void): void;
  /** The whole browser process went away (exit, kill, OOM). */
  onBrowserDisconnected(listener: () => void): void;
  /** The page's context closed under the test (normal only AFTER dispose). */
  onContextClose(listener: () => void): void;
}

/** Adapt a real Playwright page to the three terminal signals. */
export function pageBrowserLossEvents(page: Page): BrowserLossEvents {
  return {
    onCrash: (listener) => page.on('crash', listener),
    onBrowserDisconnected: (listener) => {
      const browser = page.context().browser();
      if (browser) browser.on('disconnected', listener);
    },
    onContextClose: (listener) => page.context().on('close', listener),
  };
}

export function attachBrowserLossDiagnostics(
  events: BrowserLossEvents,
  label: string,
  log: (line: string) => void = (line) => console.error(line),
  now: () => string = () => new Date().toISOString(),
): { dispose: () => void } {
  // First terminal signal wins: once the browser is gone, the context-close
  // that follows is a consequence, not a second cause — reporting both would
  // recreate the ambiguity this exists to remove. `dispose` closes the watch
  // window so ordinary after-test teardown never prints.
  let armed = true;
  let reported = false;
  const report = (kind: 'renderer-crash' | 'browser-disconnected' | 'context-closed') => {
    if (!armed || reported) return;
    reported = true;
    log(`[browser-loss] kind=${kind} spec="${label}" at=${now()}`);
  };
  events.onCrash(() => report('renderer-crash'));
  events.onBrowserDisconnected(() => report('browser-disconnected'));
  // Playwright closes contexts before it emits Browser.disconnected when the
  // whole browser exits. Defer the ambiguous context signal for one microtask
  // so the process-level signal can win the same synchronous close cascade.
  events.onContextClose(() => queueMicrotask(() => report('context-closed')));
  return { dispose: () => { armed = false; } };
}
