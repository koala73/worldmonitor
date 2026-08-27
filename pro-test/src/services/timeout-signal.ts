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
 * `pro-test/src/services/timeout-signal.ts` MUST stay byte-identical, because
 * `entitlement-watchdog.ts` — itself a byte-identical mirror across the two
 * roots — imports it as `./timeout-signal`. That specifier only resolves in
 * both bundles if the helper sits at the same relative path under each root.
 * `tests/entitlement-watchdog-parity.test.mts` enforces both halves; drift
 * there is quiet, because the import still resolves while one bundle loses
 * its fallback.
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
