/**
 * Fetch timeout signal with a fallback for engines that lack
 * `AbortSignal.timeout` (Baseline 2024 / Chrome 103+).
 *
 * WORLDMONITOR-109: Chrome Mobile 101 on Android 9 threw
 * `TypeError: AbortSignal.timeout is not a function` in the /pro
 * pricing catalog `useEffect` before `fetch` ran. `AbortController` +
 * `setTimeout` covers that class without a polyfill package.
 *
 * Why the throw is not survivable at the call site: the signal is built as an
 * ARGUMENT, so it throws before `fetch()` is entered. No promise exists yet,
 * so the `.catch()` on the fetch chain never attaches and the TypeError
 * escapes to `window.onerror` — which is why WORLDMONITOR-109 arrived
 * `handled: false` and took the React render down with it. Inside an `async`
 * function an enclosing `try` does catch it, so the other call sites degraded
 * silently instead (an entitlement poll that could never succeed).
 *
 * MIRROR PAIR: `src/services/timeout-signal.ts` and
 * `pro-test/src/services/timeout-signal.ts` MUST stay byte-identical. Each
 * root's `checkout-transport.ts` imports it as `./timeout-signal`, and that
 * specifier only resolves in both bundles if the helper sits at the same
 * relative path under each root. `tests/marketing-mirror-parity.test.mts`
 * enforces it; drift is quiet, because the import still resolves while one
 * bundle loses its fallback.
 */
export function createTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => {
    try {
      // Native `AbortSignal.timeout` aborts with a `TimeoutError` DOMException;
      // a bare `controller.abort()` produces an `AbortError` instead. The
      // difference is load-bearing in this codebase —
      // `analytics-collector-transport.ts` branches on `name === 'TimeoutError'`
      // to tell a request that timed out from one the caller cancelled — so the
      // fallback reproduces the native reason rather than silently reclassifying
      // every old-engine timeout as a cancellation.
      controller.abort(
        typeof DOMException === 'function'
          ? new DOMException('signal timed out', 'TimeoutError')
          : undefined,
      );
    } catch {
      /* already aborted or exotic AbortController */
    }
  }, ms);
  return controller.signal;
}

/** Compose cancellation without assuming the Baseline 2024 AbortSignal.any API. */
export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = (): void => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  const forward = (signal: AbortSignal): void => {
    cleanup();
    try {
      controller.abort(signal.reason);
    } catch {
      controller.abort();
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      forward(signal);
      break;
    }
    const listener = (): void => forward(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
}

/**
 * True for deadline/cancel outcomes from `createTimeoutSignal` / fetch abort.
 *
 * WORLDMONITOR-10F: Mobile Safari reports `AbortSignal.timeout` as
 * `AbortError: Fetch is aborted` (DOMException code 20), not `TimeoutError`.
 * Callers that `captureException` on every catch must skip these — they are
 * expected operational outcomes, not product failures.
 */
export function isTimeoutOrAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
