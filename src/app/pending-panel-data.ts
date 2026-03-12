const pendingCalls = new Map<string, Map<string, unknown[]>>();

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
