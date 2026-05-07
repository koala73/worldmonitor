/**
 * Fetch wrapper for premium RPC clients.
 *
 * Injects a Clerk Bearer token (or WORLDMONITOR_API_KEY as fallback) directly
 * into every request for premium endpoints. This is the source-of-truth auth
 * injection for those routes — no reliance on the global fetch patch.
 *
 * IMPORTANT — Bearer injection is path-gated to PREMIUM_RPC_PATHS only.
 * Many service clients (economic, supply-chain, …) wrap the WHOLE generated
 * client with `premiumFetch` even though only a few of its methods target
 * a premium path. For non-premium methods (FRED batch, BLS batch, BIS,
 * energy, etc.) attaching `Authorization: Bearer …` actively harmed Pro
 * users with no tester key:
 *
 *   1. premiumFetch sets Authorization → wm-session interceptor sees it
 *      and steps aside (no `X-WorldMonitor-Key: wms_…` is attached).
 *   2. Server gateway only resolves Bearer JWTs on tier-gated paths
 *      (gateway.ts: `if (isTierGated) resolveClerkSession(...)`); for
 *      non-tier-gated paths the JWT is ignored entirely.
 *   3. api/_api-key.js `validateApiKey()` reads ONLY X-WorldMonitor-Key.
 *      With no key present it returns { valid: false, required: true } →
 *      gateway emits 401.
 *
 * Net effect: Pro users on subdomains whose localStorage didn't carry a
 * tester key got 401s on FRED + BLS + BIS etc., while anon users (whose
 * premiumFetch falls through to globalThis.fetch and the interceptor
 * attaches wms_) saw the data normally — the inverse of the expected
 * "Pro sees more" behaviour.
 *
 * Fix: don't attach Bearer for non-premium paths. Fall through to the
 * unauth path so the wm-session interceptor handles the wms_ attach.
 * API-key holders (step 1) and tester-key holders (step 2) are unaffected
 * — those keys travel via X-WorldMonitor-Key which works on any path.
 */
import * as Sentry from '@sentry/browser';
import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';

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

function reportServerError(res: Response, input: RequestInfo | URL): void {
  if (res.status < 500) return;
  try {
    const href = input instanceof Request ? input.url : String(input);
    const path = new URL(href, globalThis.location?.href ?? 'https://worldmonitor.app').pathname;
    Sentry.captureMessage(`API ${res.status}: ${path}`, {
      level: 'error',
      tags: { kind: 'api_5xx' },
      extra: { path, status: res.status },
    });
  } catch { /* ignore URL parse errors */ }
}

/**
 * Whether `input` targets a path enumerated in PREMIUM_RPC_PATHS — the
 * canonical list of routes that REQUIRE per-user pro auth. Tier-gated
 * endpoints (`ENDPOINT_ENTITLEMENTS` in server/_shared/entitlement-check.ts)
 * are a strict subset of PREMIUM_RPC_PATHS at the time of writing, so this
 * one check covers both.
 */
function isPremiumRpcTarget(input: RequestInfo | URL): boolean {
  try {
    const href = input instanceof Request ? input.url : String(input);
    const path = new URL(href, globalThis.location?.href ?? 'https://worldmonitor.app').pathname;
    return PREMIUM_RPC_PATHS.has(path);
  } catch {
    // If we can't parse the URL, fall through to the strict path: keep
    // attaching Bearer so premium endpoints stay authenticated. This
    // preserves prior behaviour for malformed inputs.
    return true;
  }
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
    const res = await globalThis.fetch(input, init);
    reportServerError(res, input);
    return res;
  }

  // 1. WORLDMONITOR_API_KEY from env (desktop / test environments).
  try {
    const { getRuntimeConfigSnapshot } = await import('@/services/runtime-config');
    const wmKey = getRuntimeConfigSnapshot().secrets['WORLDMONITOR_API_KEY']?.value;
    if (wmKey) {
      existing.set('X-WorldMonitor-Key', wmKey);
      const res = await globalThis.fetch(input, { ...init, headers: existing });
      reportServerError(res, input);
      return res;
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
    if (res.status !== 401) {
      reportServerError(res, input);
      return res;
    }
    // 401 → try the next tester key, then fall through to Clerk if none work.
  }

  // 3. Clerk Pro session token — ONLY for premium paths. For non-premium
  //    endpoints, attaching Bearer would suppress the wm-session
  //    interceptor's wms_ attach and produce a 401 (see the file-level
  //    comment for the full chain). Falling through to step 4 instead lets
  //    the interceptor attach wms_ and the gateway accept it.
  if (isPremiumRpcTarget(input)) {
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
        const res = await globalThis.fetch(input, { ...init, headers: existing });
        reportServerError(res, input);
        return res;
      }
    } catch { /* not signed in — fall through */ }
  }

  // 4. No auth — let the request through.
  // For NON-premium paths this lands on the wm-session interceptor (which
  // attaches wms_) → gateway accepts → 200. For premium paths reached here
  // (no API key, no tester key, no Clerk Bearer) the gateway will return
  // 401, which is correct.
  const res = await globalThis.fetch(input, init);
  reportServerError(res, input);
  return res;
}
