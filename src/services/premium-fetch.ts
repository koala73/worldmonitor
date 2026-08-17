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
 * Net effect: Pro users without a tester session got 401s on FRED + BLS + BIS etc., while anon users (whose
 * premiumFetch falls through to globalThis.fetch and the interceptor
 * attaches wms_) saw the data normally — the inverse of the expected
 * "Pro sees more" behaviour.
 *
 * Fix: don't attach Bearer for non-premium paths. Fall through to the
 * unauth path so the wm-session interceptor handles the wms_ attach.
 * API-key holders (step 1) and tester-key holders (step 2) are unaffected
 * — those keys travel via X-WorldMonitor-Key which works on any path.
 */
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';
import { PRO_FRESH_CACHE_RPC_PATHS } from '@/shared/pro-fresh-rpc';
import { withPremiumIntent } from './premium-intent';
import { isDesktopRuntime } from './runtime';

/**
 * Test seam — set in unit tests to inject key/token providers without needing
 * browser globals (localStorage, Clerk session). Null in production.
 */
let _testProviders: {
  getTesterKey?: () => string;
  getTesterKeys?: () => string[];
  getClerkToken?: () => Promise<string | null>;
  isClerkUserSignedIn?: () => boolean | Promise<boolean>;
} | null = null;

type PremiumFetchInit = RequestInit & { forcePremium?: boolean };

export function _setTestProviders(
  p: typeof _testProviders,
): void {
  _testProviders = p;
}

// Exported for tests (tests/premium-fetch.test.mts) — the `enqueue` parameter
// exists only so tests can observe captures without loading the Sentry SDK;
// production call sites never pass it.
export function reportServerError(
  res: Response,
  input: RequestInfo | URL,
  enqueue: typeof enqueueSentryCall = enqueueSentryCall,
): void {
  if (res.status < 500) return;
  // wm-session's dead-session cooldown synthesizes a local 503 (marked with
  // X-Wm-Session-Degraded) for every suppressed anonymous call — it never
  // left the browser, so reporting it here floods one `API 503:` issue per
  // widget endpoint and drowns the genuine origin-5xx canary (#5245).
  // markWmSessionDead() captures the episode once instead.
  if (res.headers.get('X-Wm-Session-Degraded') === '1') return;
  // Fail-closed rate-limit degradation is already captured at the server
  // decision point. Reporting every browser-visible 503 again would turn one
  // Redis outage into a per-route, per-client Sentry flood.
  if (res.headers.get('X-RateLimit-Mode') === 'degraded') return;
  try {
    const href = input instanceof Request ? input.url : String(input);
    const path = new URL(href, globalThis.location?.href ?? 'https://worldmonitor.app').pathname;
    // Cloudflare edge errors (520-527) are CDN<->origin transport failures, not
    // origin application errors — a single one is a transient blip. Capture at
    // `warning` so a sustained outage still escalates by volume without a lone
    // transient drowning genuine origin 5xx in the error dashboard
    // (WORLDMONITOR-RG). Genuine origin 5xx (500-511) stay at `error`.
    const isCloudflareEdgeError = res.status >= 520 && res.status <= 527;
    const message = `API ${res.status}: ${path}`;
    const level: 'warning' | 'error' = isCloudflareEdgeError ? 'warning' : 'error';
    // `status` is a tag, not just an `extra`: `extra` is not indexed, so a
    // status that is only there can be read one event at a time but never
    // aggregated. Both sibling fingerprint sites mirror every grouping
    // dimension into tags for that reason — analytics-collector-transport.ts
    // tags `status` beside its fingerprint, and api/user-prefs.ts promotes
    // fields out of `extra` explicitly to make them searchable. Without it
    // `kind:api_cf_5xx` is queryable but `status:503` is not, so triage cannot
    // ask "every 503 this week, across all routes" — the exact question that
    // separated this issue's 503s from its 520s. Cardinality is the bounded
    // 5xx set, same as the fingerprint's.
    const tags = {
      kind: isCloudflareEdgeError ? 'api_cf_5xx' : 'api_5xx',
      status: String(res.status),
    };
    const extra = { path, status: res.status };
    // Group explicitly rather than letting Sentry infer it. These are
    // message-only events — `attachStacktrace` defaults to false and is never
    // set in sentry-init.ts — so Sentry groups them by message, and its
    // server-side parameterization normalizes the embedded status integer:
    // `API 520: /x` and `API 503: /x` collapse to the same grouping message.
    // WORLDMONITOR-P4 ("API 520: /api/economic/v1/get-fred-series-batch") held
    // 256 api_5xx events beside 25 api_cf_5xx ones that way — 92 of its last
    // 100 were the 2026-07-12 origin 503s, not the 520 it is named for. That
    // inflates the headline count, voids the level split above (one issue
    // carries one level), and makes an unpinned resolve reopen and page on any
    // origin 5xx for the path.
    //
    // `path` and the status are the two grouping axes. The leading token is a
    // readable class label in the style of analytics-collector-transport.ts's
    // fingerprint namespace, but it is derived from the status, so it splits
    // nothing on its own — do not read it as a third axis.
    // Cardinality stays bounded at the RPC path set x the 5xx status set —
    // `path` is a pathname, so query strings never enter the key. Keep it that
    // way: a path-parameterized caller would mint one Sentry issue per URL.
    const fingerprint = [
      isCloudflareEdgeError ? 'api-cf-5xx' : 'api-5xx',
      path,
      String(res.status),
    ];
    enqueue((s) => s.captureMessage(message, { level, tags, extra, fingerprint }));
  } catch { /* ignore URL parse errors */ }
}

/**
 * The single dispatch point for every authenticated variant below: fetch, then
 * report whatever the caller will actually receive.
 *
 * The retryable billing-verification 503 (#6483) is honored one layer down, by
 * `withBillingVerificationRetry` around the `window.fetch` patch in
 * services/runtime.ts. It moved there because the server's contract is
 * route-agnostic while this function is not: the legacy-Pro-bearer gate
 * (server/gateway.ts:1467) 503s routes that are in neither ENDPOINT_ENTITLEMENTS
 * nor PREMIUM_RPC_PATHS, and those callers never reach `premiumFetch`. Retrying
 * here as well would double the bound to two attempts and ~10s of inline wait.
 *
 * Reporting the FINAL response is still the point, and still works: the patch
 * resolves to the post-retry response, so a transient it absorbs produces no
 * Sentry event at all — matching how the two other expected-transient 503s on
 * this path are handled (see reportServerError) — while a sustained outage
 * still yields exactly one event per call, so the origin-5xx canary keeps its
 * signal.
 */
async function fetchReportingServerErrors(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await globalThis.fetch(input, init);
  reportServerError(res, input);
  return res;
}

function withCredentials(init?: RequestInit): RequestInit {
  return { ...(init ?? {}), credentials: init?.credentials ?? 'include' };
}

/**
 * Whether `input` targets a path enumerated in PREMIUM_RPC_PATHS — the
 * canonical list of routes that REQUIRE per-user pro auth. Tier-gated
 * endpoints (`ENDPOINT_ENTITLEMENTS` in server/_shared/entitlement-check.ts)
 * are a strict subset of PREMIUM_RPC_PATHS at the time of writing, so this
 * one check covers both.
 */
function isPremiumRpcTarget(input: RequestInfo | URL, forcePremium = false): boolean {
  if (forcePremium) return true;
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

function isProFreshCacheRpcTarget(input: RequestInfo | URL): boolean {
  try {
    const href = input instanceof Request ? input.url : String(input);
    const path = new URL(href, globalThis.location?.href ?? 'https://worldmonitor.app').pathname;
    return PRO_FRESH_CACHE_RPC_PATHS.has(path);
  } catch {
    return false;
  }
}

/**
 * Fetch adapter for generated RPC clients that include Pro-fresh market reads.
 *
 * Only the exact shared allowlist opts into Clerk bearer injection. Other
 * methods on the same generated client retain the anonymous wm-session path.
 */
export function proFreshRpcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isProFreshCacheRpcTarget(input)) {
    return globalThis.fetch(input, init);
  }
  return premiumFetch(input, { ...init, forcePremium: true });
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

// Delay before the single Clerk-token retry (see step 3 in premiumFetch).
// Long enough for the boot-window token-generation rotation to settle, short
// enough to stay imperceptible on the one premium call that loses the race.
const CLERK_TOKEN_RETRY_DELAY_MS = 300;

async function resolveClerkToken(): Promise<string | null> {
  if (_testProviders) {
    return _testProviders.getClerkToken ? _testProviders.getClerkToken() : null;
  }
  const { getClerkToken } = await import('@/services/clerk');
  return getClerkToken();
}

/**
 * Whether a Clerk user is currently present. Gates the token retry: a present
 * user means a null token is a transient boot-window artifact worth retrying;
 * an absent user means a genuinely anonymous visitor who must NOT pay the
 * retry delay and should fall through immediately.
 */
async function isClerkUserSignedIn(): Promise<boolean> {
  if (_testProviders) {
    return (await _testProviders.isClerkUserSignedIn?.()) ?? false;
  }
  try {
    const { getCurrentClerkUser } = await import('@/services/clerk');
    return getCurrentClerkUser() !== null;
  } catch {
    return false;
  }
}

function delayBeforeClerkRetry(): Promise<void> {
  // Test providers stand in for the real Clerk session, so never block the
  // suite on a real timer.
  const ms = _testProviders ? 0 : CLERK_TOKEN_RETRY_DELAY_MS;
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function premiumFetch(
  input: RequestInfo | URL,
  init?: PremiumFetchInit,
): Promise<Response> {
  const forcePremium = init?.forcePremium === true;
  const requestInit = init ? { ...init } : undefined;
  if (requestInit) delete requestInit.forcePremium;

  // Skip injection if the caller already set an auth header.
  const existing = new Headers(requestInit?.headers);
  if (existing.has('Authorization') || existing.has('X-WorldMonitor-Key')) {
    return fetchReportingServerErrors(input, withCredentials(requestInit));
  }

  // 1. Browser/test runtime key. Desktop keys remain inside the native
  // sidecar; its native proxy authenticates these requests without placing a
  // license key in renderer memory.
  if (!isDesktopRuntime()) {
    try {
      const { getRuntimeConfigSnapshot } = await import('@/services/runtime-config');
      const wmKey = getRuntimeConfigSnapshot().secrets['WORLDMONITOR_API_KEY']?.value;
      if (wmKey) {
        existing.set('X-WorldMonitor-Key', wmKey);
        // `return await`, not a bare `return`: this sits inside the try below,
        // and only an awaited rejection is caught by it. Returning the promise
        // unawaited would escape the catch and propagate instead of falling
        // through to the next credential — a silent behavior change.
        return await fetchReportingServerErrors(
          input,
          { ...withCredentials(requestInit), headers: existing },
        );
      }
    } catch { /* not available — fall through */ }
  }

  // 2. Legacy in-memory test seam. In production, tester/widget keys are
  // HttpOnly cookies and ride along through credentials: 'include'.
  const testerKeys = await loadTesterKeys();
  for (const testerKey of testerKeys) {
    const testerHeaders = new Headers(existing);
    testerHeaders.set('X-WorldMonitor-Key', testerKey);
    // A 401 is never reported (reportServerError ignores anything under 500),
    // so dispatching through the shared path here does not change what the
    // fallback chain surfaces — it only lets a tester-key call absorb the same
    // retryable 503 as every other variant.
    const res = await fetchReportingServerErrors(input, { ...withCredentials(requestInit), headers: testerHeaders });
    if (res.status !== 401) return res;
    // 401 → try the next tester key, then fall through to Clerk if none work.
  }

  // 3. Clerk Pro session token — ONLY for premium paths. For non-premium
  //    endpoints, attaching Bearer would suppress the wm-session
  //    interceptor's wms_ attach and produce a 401 (see the file-level
  //    comment for the full chain). Falling through to step 4 instead lets
  //    the interceptor attach wms_ and the gateway accept it.
  if (isPremiumRpcTarget(input, forcePremium)) {
    try {
      let token = await resolveClerkToken();
      // Boot-window auth race: while Clerk/Convex bootstrap the session,
      // clearClerkTokenCache() bumps the token generation (so a rotating
      // user's stale JWT is never painted), which makes any in-flight
      // getClerkToken() abandon to null. A signed-in user's premium fetch
      // that lands in that window would otherwise fall through to an
      // unauthenticated request and 401 (the FINANCIAL panel firing
      // analyze-stock per symbol on first paint is the canonical trigger).
      // Retry the token exactly once after the rotation settles, gated on a
      // present Clerk user so anonymous visitors fall through immediately.
      if (!token && await isClerkUserSignedIn()) {
        await delayBeforeClerkRetry();
        token = await resolveClerkToken();
      }
      if (token) {
        existing.set('Authorization', `Bearer ${token}`);
        // `return await` — see the wm-key branch above: this is inside the
        // enclosing try, whose catch must keep seeing a rejection here.
        return await fetchReportingServerErrors(
          input,
          { ...withCredentials(requestInit), headers: existing },
        );
      }
    } catch { /* not signed in — fall through */ }
  }

  // 4. No auth — let the request through.
  // For NON-premium paths this lands on the wm-session interceptor (which
  // attaches wms_) → gateway accepts → 200. For premium paths reached here
  // (no API key, no tester key, no Clerk Bearer) the gateway will return
  // 401, which is correct.
  //
  // Mark premium-intent requests so the interceptor reads that 401 as the
  // expected auth denial it is (#5674). Path-listed premium routes already
  // short-circuit inside the interceptor, so this only changes behaviour for
  // routes that are premium per REQUEST rather than per path — today
  // `/api/news/v1/summarize-article` via `forcePremium`, which must stay out
  // of PREMIUM_RPC_PATHS so its free translate mode keeps receiving the
  // anonymous wms_ cookie. Unmarked, each denial cost a session mint, a
  // replay, and a 15-minute blackout of every anonymous API call.
  //
  // Steps 1-3 return as soon as any credential resolves, so everything that
  // reaches this line is unauthenticated by definition — exactly the population
  // the marker is meant to describe, and never a request that already steps
  // aside via its own Authorization / X-WorldMonitor-Key header.
  //
  // EXCEPT the Pro-fresh cache tape. `forcePremium` carries two meanings, and
  // only one of them licenses the marker:
  //
  //   - summarization.ts  — "this call requires Pro"; a 401 IS the expected
  //     denial, so suppressing session recovery is correct.
  //   - proFreshRpcFetch  — "attach a Bearer opportunistically for a fresher
  //     cache tier". PRO_FRESH_CACHE_RPC_PATHS is explicitly an authentication
  //     surface, not an authorization gate: anonymous and free callers keep
  //     access on the ordinary cache policy, and those paths 401 when the wms_
  //     cookie is rejected (verified against prod). Marking them would strip
  //     the mint-and-replay that absorbs an HMAC rotation or cache flap, so a
  //     recoverable blip would surface as a dead price tape instead.
  const marksPremiumIntent =
    isPremiumRpcTarget(input, forcePremium) && !isProFreshCacheRpcTarget(input);
  const unauthenticatedInit = marksPremiumIntent
    ? withPremiumIntent(withCredentials(requestInit))
    : withCredentials(requestInit);
  return fetchReportingServerErrors(input, unauthenticatedInit);
}
