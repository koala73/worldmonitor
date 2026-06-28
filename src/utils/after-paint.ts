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
 * sub-50ms tasks — lowers TBT, which deferral alone does not (#4442).
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}
