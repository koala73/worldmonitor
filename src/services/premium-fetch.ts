/**
 * Fetch wrapper for premium RPC clients.
 *
 * Injects a Clerk Bearer token (or WORLDMONITOR_API_KEY as fallback) directly
 * into every request. This is the source-of-truth auth injection for premium
 * market endpoints — no reliance on the global fetch patch.
 */

/**
 * Test seam — set in unit tests to inject key/token providers without needing
 * browser globals (localStorage, Clerk session). Null in production.
 */
let _testProviders: {
  getTesterKey?: () => string;
  getClerkToken?: () => Promise<string | null>;
} | null = null;

export function _setTestProviders(
  p: typeof _testProviders,
): void {
  _testProviders = p;
}

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
  // If the gateway returns 401 (key not in WORLDMONITOR_VALID_KEYS), fall through
  // to Clerk JWT rather than surfacing the error — widget relay keys and gateway
  // API keys can be different sets.
  let testerKey: string | null = null;
  try {
    if (_testProviders?.getTesterKey) {
      testerKey = _testProviders.getTesterKey();
    } else {
      const { getProWidgetKey, getWidgetAgentKey } = await import('@/services/widget-store');
      testerKey = getProWidgetKey() || getWidgetAgentKey();
    }
  } catch { /* widget-store not available — fall through */ }

  if (testerKey) {
    const testerHeaders = new Headers(existing);
    testerHeaders.set('X-WorldMonitor-Key', testerKey);
    const res = await globalThis.fetch(input, { ...init, headers: testerHeaders });
    if (res.status !== 401) return res;
    // 401 → tester key not in WORLDMONITOR_VALID_KEYS; fall through to Clerk.
  }

  // 3. Clerk Pro session token (fallback for users without a tester key, or when
  //    the tester key is not in WORLDMONITOR_VALID_KEYS).
  try {
    let token: string | null = null;
    if (_testProviders?.getClerkToken) {
      token = await _testProviders.getClerkToken();
    } else {
      const { getClerkToken } = await import('@/services/clerk');
      token = await getClerkToken();
    }
    if (token) {
      existing.set('Authorization', `Bearer ${token}`);
      return globalThis.fetch(input, { ...init, headers: existing });
    }
  } catch { /* not signed in — fall through */ }

  // 4. No auth — let the request through (gateway will return 401).
  return globalThis.fetch(input, init);
}
