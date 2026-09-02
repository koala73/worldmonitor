import { enqueueSentryCall } from '@/bootstrap/sentry-defer';

const pendingCalls = new Map<string, Map<string, unknown[]>>();

export type PanelCallFailureReporter = (key: string, method: string, error: unknown) => void;

/**
 * Default sink for a rejected panel update.
 *
 * Swallowing the rejection silently would trade an unhandled rejection for an
 * invisible failure, so the panel that failed and the error are reported.
 */
export function reportPanelCallFailure(key: string, method: string, error: unknown): void {
  console.error(`[panel-call] ${key}.${method}() rejected:`, error);
  enqueueSentryCall((s) => {
    s.captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { kind: 'panel_call_rejected', panel: key, method },
    });
  });
}

/**
 * Dispatch a panel method directly, keeping an async rejection observable.
 *
 * WORLDMONITOR-11N: `DataLoader.callPanel` called `obj[method](...args)` and
 * discarded the result. Panel update methods are `async` and can reject —
 * `InsightsPanel.updateInsights` awaits `updateFromServer`, whose catch handler
 * awaits `updateFromClient` outside any try — so the rejection had no handler
 * and escaped to `onunhandledrejection`. Production reported it as the insights
 * loader's shared abort reason (`TimeoutError: signal timed out`) carrying that
 * loader's async stack, even though the loader itself always catches.
 *
 * Returns whether the call was dispatched, so the caller can queue it otherwise.
 * A synchronous throw still propagates, matching the previous direct call.
 */
export function invokePanelMethod(
  panel: unknown,
  key: string,
  method: string,
  args: unknown[],
  report: PanelCallFailureReporter = reportPanelCallFailure,
): boolean {
  const obj = panel as Record<string, unknown> | null | undefined;
  const fn = obj?.[method];
  if (typeof fn !== 'function') return false;
  const result = (fn as (...a: unknown[]) => unknown).apply(obj, args);
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void (result as Promise<unknown>).catch((error: unknown) => {
      // A throwing reporter must not re-reject and recreate the leak.
      try { report(key, method, error); } catch { /* reporting is best-effort */ }
    });
  }
  return true;
}

export function enqueuePanelCall(key: string, method: string, args: unknown[]): void {
  let methods = pendingCalls.get(key);
  if (!methods) {
    methods = new Map();
    pendingCalls.set(key, methods);
  }
  methods.set(method, args);
}

// Race-safe: panels[key] is set BEFORE replay starts (panel-layout.ts line 1147),
// so any concurrent callPanel() during async replay takes the direct-call path
// (not the queue). delete() before iteration prevents double-replay.
export async function replayPendingCalls(key: string, panel: unknown): Promise<void> {
  const methods = pendingCalls.get(key);
  if (!methods) return;
  pendingCalls.delete(key);
  for (const [method, args] of methods) {
    const fn = (panel as Record<string, unknown>)[method];
    if (typeof fn === 'function') {
      const result = fn.apply(panel, args);
      if (result instanceof Promise) await result;
    }
  }
}

export function clearAllPendingCalls(): void {
  pendingCalls.clear();
}
