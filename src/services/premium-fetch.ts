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
  getTesterKeys?: () => string[];
  getClerkToken?: () => Promise<string | null>;
} | null = null;

export function _setTestProviders(
  p: typeof _testProviders,
): void {
  _testProviders = p;
}

function uniqueNonEmptyKeys(keys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keys) {
    const key = raw?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

async function loadTesterKeys(): Promise<string[]> {
  try {
    if (_testProviders?.getTesterKeys) {
      return uniqueNonEmptyKeys(_testProviders.getTesterKeys());
    }
    if (_testProviders?.getTesterKey) {
      return uniqueNonEmptyKeys([_testProviders.getTesterKey()]);
    }
    const { getBrowserTesterKeys } = await import('@/services/widget-store');
    return uniqueNonEmptyKeys(getBrowserTesterKeys());
  } catch {
    return [];
  }
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

  // 2. Tester / widget keys from localStorage.
  // Must run BEFORE Clerk to prevent a free Clerk session from intercepting the
  // request and returning 403 before the tester key is ever checked.
  // Try wm-pro-key first, then wm-widget-key. A relay-only pro key can be invalid
  // for the gateway even when the widget key is valid for premium RPC access.
  const testerKeys = await loadTesterKeys();
  for (const testerKey of testerKeys) {
    const testerHeaders = new Headers(existing);
    testerHeaders.set('X-WorldMonitor-Key', testerKey);
    const res = await globalThis.fetch(input, { ...init, headers: testerHeaders });
    if (res.status !== 401) return res;
    // 401 → try the next tester key, then fall through to Clerk if none work.
  }

  // 3. Clerk Pro session token (fallback for users without tester keys, or when
  //    none of the tester keys are in WORLDMONITOR_VALID_KEYS).
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
