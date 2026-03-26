/**
 * Fetch wrapper for premium RPC clients.
 *
 * Injects a Clerk Bearer token (or WORLDMONITOR_API_KEY as fallback) directly
 * into every request. This is the source-of-truth auth injection for premium
 * market endpoints — no reliance on the global fetch patch.
 */

export async function premiumFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Skip injection if the caller already set an auth header.
  const existing = new Headers(init?.headers);
  if (existing.has('Authorization') || existing.has('X-WorldMonitor-Key')) {
    return globalThis.fetch(input, init);
  }

  // 1. WORLDMONITOR_API_KEY from env (desktop / test environments).
  try {
    const { getRuntimeConfigSnapshot } = await import('@/services/runtime-config');
    const wmKey = getRuntimeConfigSnapshot().secrets['WORLDMONITOR_API_KEY']?.value;
    if (wmKey) {
      existing.set('X-WorldMonitor-Key', wmKey);
      return globalThis.fetch(input, { ...init, headers: existing });
    }
  } catch { /* not available — fall through */ }

  // 2. Tester / widget key from localStorage (wm-pro-key or wm-widget-key).
  // Must run BEFORE Clerk to prevent a free Clerk session from intercepting the
  // request and returning 403 before the tester key is ever checked.
  try {
    const { getProWidgetKey, getWidgetAgentKey } = await import('@/services/widget-store');
    const testerKey = getProWidgetKey() || getWidgetAgentKey();
    if (testerKey) {
      existing.set('X-WorldMonitor-Key', testerKey);
      return globalThis.fetch(input, { ...init, headers: existing });
    }
  } catch { /* not available — fall through */ }

  // 3. Clerk Pro session token (fallback for users without a tester key).
  try {
    const { getClerkToken } = await import('@/services/clerk');
    const token = await getClerkToken();
    if (token) {
      existing.set('Authorization', `Bearer ${token}`);
      return globalThis.fetch(input, { ...init, headers: existing });
    }
  } catch { /* not signed in — fall through */ }

  // 4. No auth — let the request through (gateway will return 401).
  return globalThis.fetch(input, init);
}
