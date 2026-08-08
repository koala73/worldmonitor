type IdleCallback = () => void;
type RequestIdleCallback = (cb: IdleCallback, opts?: { timeout: number }) => number;

/**
 * Run non-critical work after first paint and browser load, then yield to idle time when available.
 */
export function scheduleAfterFirstPaint(task: () => void, timeoutMs = 3000): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let ran = false;
  const runOnce = (): void => {
    if (ran) return;
    ran = true;
    task();
  };

  const scheduleIdle = (): void => {
    const ric = (window as unknown as { requestIdleCallback?: RequestIdleCallback }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(runOnce, { timeout: timeoutMs });
      return;
    }
    setTimeout(runOnce, 0);
  };

  const afterPaint = (): void => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleIdle));
      return;
    }
    scheduleIdle();
  };

  if (document.readyState === 'complete') {
    afterPaint();
  } else {
    window.addEventListener('load', afterPaint, { once: true });
  }
}

/**
 * Yield to the main thread (ends the current task) so a long render can be split into
 * sub-50ms tasks — lowers TBT, which deferral alone does not (#4442), and shortens
 * INP processing time by letting a higher-priority paint run between chunks (#4537).
 *
 * Prefers the native `scheduler.yield()` where available: it ends the current task
 * AND resumes the continuation ahead of a fresh `setTimeout(0)`, which is clamped and
 * scheduled behind other timer work — strictly better for INP. Falls back to
 * `setTimeout(resolve, 0)` on browsers without the Scheduler API.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Whether the browser currently has queued input (a click/keypress) waiting to
 * be dispatched. Recurring, animation-driven work on the input path calls this
 * and skips its tick when input is pending, so the interaction handler can run
 * sooner (#5042).
 *
 * Feature-detected: `navigator.scheduling.isInputPending` is Chromium-only,
 * which matches INP being a Chromium-measured metric. Returns `false` wherever
 * the API is absent (Firefox/Safari/node), so callers degrade to today's
 * behavior with no functional change.
 *
 * Called with no arguments, so it reports DISCRETE input (clicks/keys) only —
 * `includeContinuous` defaults to `false`. That is the correct scope for the
 * click/keypress control targets; passing `{ includeContinuous: true }` would
 * also report pointermove/wheel/drag and stall callers during any hover/pan.
 */
export function isInputPending(): boolean {
  const scheduling = (globalThis as unknown as {
    navigator?: { scheduling?: { isInputPending?: () => boolean } };
  }).navigator?.scheduling;
  if (typeof scheduling?.isInputPending !== 'function') return false;
  return scheduling.isInputPending();
}

/**
 * Adapt `yieldToMain()` to a fire-once scheduler with a cancel handle:
 * `scheduleYield(run)` runs `run` after the yield resolves and returns a cancel
 * that prevents it. `DeferredHeavyCommit` (#4558) depends on this shape to
 * coalesce a burst of stages into one flush and to drop the flush on teardown;
 * the `yieldToMain` promise can't be cleared, so an abort flag preserves those
 * semantics. Prefer this over `setTimeout(0)`: `scheduler.yield()` resumes ahead
 * of clamped timer work (but still behind queued input), lowering commit latency
 * without newly blocking the input path (#5042 U4).
 */
export function scheduleYield(run: () => void): () => void {
  let aborted = false;
  void yieldToMain().then(() => {
    if (aborted) return;
    try {
      run();
    } catch (err) {
      // Surface a throw from the deferred flush on the global error channel
      // (window.onerror -> Sentry) exactly as the replaced setTimeout(fn, 0)
      // did, rather than leaving it as a floating promise rejection.
      setTimeout(() => { throw err; });
    }
  });
  return () => { aborted = true; };
}
