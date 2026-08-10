/**
 * Unit tests for src/services/premium-fetch.ts
 *
 * Covers the auth injection matrix:
 *  - Passthrough when caller already sets auth header
 *  - Tester key: valid key → returns response immediately (no second fetch)
 *  - Tester key: 401 → falls through to Clerk JWT
 *  - wm-pro-key 401 → retries with wm-widget-key before Clerk
 *  - Tester key: non-401 returned immediately (no fallback)
 *  - Tester key: network error / AbortError propagates to caller (not swallowed)
 *  - No keys, no Clerk → unauthenticated request forwarded
 *  - wm-pro-key / wm-widget-key order is deterministic and deduped
 */

import assert from 'node:assert/strict';
import { describe, it, before, after, mock } from 'node:test';
import { premiumFetch, proFreshRpcFetch, reportServerError, _setTestProviders } from '@/services/premium-fetch';
import { hasPremiumIntent } from '@/services/premium-intent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeRes(status: number) {
  return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
}

type FetchMock = ReturnType<typeof mock.method<typeof globalThis, 'fetch'>>;
let fetchMock: FetchMock;

function sentHeaders(callIndex = 0): Headers {
  const call = fetchMock.mock.calls[callIndex];
  return new Headers((call.arguments[1] as RequestInit | undefined)?.headers);
}

// Real path that lives in PREMIUM_RPC_PATHS — required because Bearer
// injection is now path-gated. Using `some-premium-rpc` (a non-existent
// path) made every "Clerk Bearer attached" assertion silently fail under
// the new logic. See PREMIUM_RPC_PATHS in src/shared/premium-paths.ts.
const TARGET = 'https://api.worldmonitor.app/api/sanctions/v1/list-sanctions-pressure';
// A real PUBLIC path used to verify the path-gating bypass: hits below
// fetch the same way but should NOT see Bearer attached.
const PUBLIC_TARGET = 'https://api.worldmonitor.app/api/economic/v1/get-fred-series-batch';
const PUBLIC_INSIDER_TRANSACTIONS_TARGET =
  'https://api.worldmonitor.app/api/market/v1/get-insider-transactions?symbol=AAPL';
const PRO_FRESH_MARKET_TARGET =
  'https://api.worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('premiumFetch', () => {
  before(() => {
    fetchMock = mock.method(globalThis, 'fetch', () => Promise.resolve(fakeRes(200)));
  });

  after(() => {
    fetchMock.mock.restore();
    _setTestProviders(null);
  });

  function setup(opts: {
    testerKey?: string;
    testerKeys?: string[];
    clerkToken?: string | null;
    fetchImpl?: () => Promise<Response>;
  } = {}) {
    _setTestProviders({
      getTesterKeys: () => opts.testerKeys ?? (opts.testerKey ? [opts.testerKey] : []),
      getClerkToken: async () => opts.clerkToken ?? null,
    });
    fetchMock.mock.resetCalls();
    fetchMock.mock.mockImplementation(opts.fetchImpl ?? (() => Promise.resolve(fakeRes(200))));
  }

  it('passthrough when Authorization header already set', async () => {
    setup();
    await premiumFetch(TARGET, { headers: { Authorization: 'Bearer existing-token' } });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), 'Bearer existing-token');
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), null);
  });

  it('passthrough when X-WorldMonitor-Key header already set', async () => {
    setup();
    await premiumFetch(TARGET, { headers: { 'X-WorldMonitor-Key': 'caller-key' } });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), 'caller-key');
  });

  it('tester key: valid key accepted — exactly one fetch, key forwarded', async () => {
    setup({ testerKey: 'valid-gateway-key' });
    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 1, 'No Clerk retry expected');
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), 'valid-gateway-key');
  });

  it('tester key: 401 falls through to Clerk JWT (two fetches)', async () => {
    let n = 0;
    setup({
      testerKey: 'widget-only-key',
      clerkToken: 'clerk-jwt-abc',
      fetchImpl: () => Promise.resolve(fakeRes(n++ === 0 ? 401 : 200)),
    });

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 2, 'Expected tester-key attempt + Clerk retry');
    // First call: tester key sent
    assert.equal(sentHeaders(0).get('X-WorldMonitor-Key'), 'widget-only-key');
    assert.equal(sentHeaders(0).get('Authorization'), null);
    // Second call: Clerk Bearer sent, no tester key
    assert.equal(sentHeaders(1).get('Authorization'), 'Bearer clerk-jwt-abc');
    assert.equal(sentHeaders(1).get('X-WorldMonitor-Key'), null);
  });

  it('wm-pro-key 401 retries with wm-widget-key before Clerk', async () => {
    let n = 0;
    setup({
      testerKeys: ['relay-only-pro-key', 'valid-widget-key'],
      clerkToken: 'clerk-jwt-should-not-be-used',
      fetchImpl: () => Promise.resolve(fakeRes(n++ === 0 ? 401 : 200)),
    });

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 2, 'Expected pro-key attempt then widget-key retry');
    assert.equal(sentHeaders(0).get('X-WorldMonitor-Key'), 'relay-only-pro-key');
    assert.equal(sentHeaders(0).get('Authorization'), null);
    assert.equal(sentHeaders(1).get('X-WorldMonitor-Key'), 'valid-widget-key');
    assert.equal(sentHeaders(1).get('Authorization'), null);
  });

  it('tester key: 403 returned immediately, no Clerk fallback', async () => {
    setup({ testerKey: 'widget-only-key', clerkToken: 'clerk-jwt' });
    fetchMock.mock.mockImplementation(() => Promise.resolve(fakeRes(403)));

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 403);
    assert.equal(fetchMock.mock.calls.length, 1, 'Should not retry on 403');
  });

  it('tester key: AbortError propagates to caller (not swallowed)', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    setup({
      testerKey: 'some-key',
      fetchImpl: () => Promise.reject(abortErr),
    });

    await assert.rejects(
      () => premiumFetch(TARGET),
      (err: unknown) => {
        assert.ok(err instanceof DOMException, 'Expected DOMException');
        assert.equal((err as DOMException).name, 'AbortError');
        return true;
      },
    );
  });

  it('no keys and no Clerk → unauthenticated request forwarded', async () => {
    setup({ testerKey: '', clerkToken: null });
    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), null);
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), null);
  });

  it('Clerk JWT used when no tester key', async () => {
    setup({ testerKey: '', clerkToken: 'clerk-only-token' });
    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), 'Bearer clerk-only-token');
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), null);
  });

  // ---------------------------------------------------------------------
  // Path-gated Bearer injection — regression for "Pro user 401s on FRED"
  // ---------------------------------------------------------------------
  //
  // The same RPC client is wrapped with premiumFetch end-to-end even
  // though only some methods target a premium path. Attaching a Clerk
  // Bearer JWT to non-premium calls suppresses the wm-session
  // interceptor's wms_ attach (premiumFetch sets Authorization → the
  // interceptor steps aside) and the gateway only resolves Bearer JWTs
  // on tier-gated paths. Result: Pro users without tester keys 401'd
  // on every FRED / BLS / BIS call while anon users (whose premiumFetch
  // falls through and the interceptor attaches wms_) saw the data.
  //
  // The fix: only attach Bearer when the path is in PREMIUM_RPC_PATHS.
  // Public paths fall through so the wm-session interceptor handles
  // wms_ attach.

  it('non-premium path: Clerk JWT NOT attached, falls through to plain fetch', async () => {
    setup({ testerKey: '', clerkToken: 'clerk-token-should-be-skipped' });
    const res = await premiumFetch(PUBLIC_TARGET);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(
      sentHeaders().get('Authorization'),
      null,
      'Bearer must NOT be attached on non-premium paths — gateway only resolves it on tier-gated routes',
    );
    assert.equal(sentHeaders().get('X-WorldMonitor-Key'), null);
  });

  it('forcePremium attaches Clerk JWT on a non-premium path without forwarding the option', async () => {
    setup({ testerKey: '', clerkToken: 'forced-clerk-token' });

    await premiumFetch(PUBLIC_TARGET, { forcePremium: true });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), 'Bearer forced-clerk-token');
    assert.equal(
      'forcePremium' in ((fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined) ?? {}),
      false,
      'forcePremium is a premiumFetch-only control and must not be forwarded to native fetch',
    );
  });

  it('Pro-fresh market adapter attaches Clerk JWT only on the shared allowlist', async () => {
    setup({ testerKey: '', clerkToken: 'pro-fresh-clerk-token' });

    await proFreshRpcFetch(PRO_FRESH_MARKET_TARGET);
    assert.equal(sentHeaders(0).get('Authorization'), 'Bearer pro-fresh-clerk-token');

    fetchMock.mock.resetCalls();
    await proFreshRpcFetch(PUBLIC_INSIDER_TRANSACTIONS_TARGET);
    assert.equal(
      sentHeaders(0).get('Authorization'),
      null,
      'other methods on the MarketService client must retain anonymous-session auth',
    );
  });

  it('public insider transactions path: Clerk JWT NOT attached', async () => {
    setup({ testerKey: '', clerkToken: 'clerk-token-should-be-skipped' });
    await premiumFetch(PUBLIC_INSIDER_TRANSACTIONS_TARGET);
    assert.equal(sentHeaders().get('Authorization'), null);
  });

  it('non-premium path: tester key still attached (works on any path)', async () => {
    setup({ testerKey: 'valid-key', clerkToken: 'clerk-token' });
    await premiumFetch(PUBLIC_TARGET);
    assert.equal(sentHeaders(0).get('X-WorldMonitor-Key'), 'valid-key');
    assert.equal(sentHeaders(0).get('Authorization'), null);
  });

  it('premium path: Clerk JWT IS attached (regression guard against over-gating)', async () => {
    setup({ testerKey: '', clerkToken: 'clerk-only-token' });
    await premiumFetch(TARGET);
    assert.equal(sentHeaders().get('Authorization'), 'Bearer clerk-only-token');
  });

  it('non-premium path: pre-set Authorization still passes through unchanged', async () => {
    // Caller-supplied auth was always passed through; verify the
    // path-gating change didn't accidentally alter that contract.
    setup({ testerKey: '', clerkToken: 'unused' });
    await premiumFetch(PUBLIC_TARGET, { headers: { Authorization: 'Bearer caller-supplied' } });
    assert.equal(sentHeaders().get('Authorization'), 'Bearer caller-supplied');
  });

  // ---------------------------------------------------------------------
  // Boot-window token-generation race — regression for "Pro user 401s on
  // analyze-stock / premium paths on first paint".
  //
  // getConvexClient() calls client.setAuth() at boot; Convex invokes the
  // token callback (sometimes with forceRefreshToken) → clearClerkTokenCache()
  // bumps _tokenGen. Concurrently the FINANCIAL panel fires analyzeStock per
  // symbol → premiumFetch → getClerkToken(). A panel token fetch in-flight
  // when the gen bumps is correctly abandoned to null (so a rotating user's
  // stale JWT is never painted) — but premiumFetch used to treat that
  // transient null as "no auth" and fire an unauthenticated request → 401.
  //
  // Fix: for a signed-in user, retry the token exactly once after the
  // rotation settles. Anonymous users skip the retry entirely.

  it('premium path: signed-in user retries the token once after a transient null (gen race)', async () => {
    let tokenCalls = 0;
    _setTestProviders({
      getTesterKeys: () => [],
      // First acquisition loses the boot-window gen race and abandons to
      // null; the retry (after rotation settles) returns the real JWT.
      getClerkToken: async () => (tokenCalls++ === 0 ? null : 'clerk-jwt-after-settle'),
      isClerkUserSignedIn: () => true,
    });
    fetchMock.mock.resetCalls();
    fetchMock.mock.mockImplementation(() => Promise.resolve(fakeRes(200)));

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(tokenCalls, 2, 'token acquisition must be retried exactly once');
    assert.equal(fetchMock.mock.calls.length, 1, 'only the authenticated request is sent');
    assert.equal(
      sentHeaders().get('Authorization'),
      'Bearer clerk-jwt-after-settle',
      'the retried token must be attached so the request authenticates instead of 401ing',
    );
  });

  it('premium path: anonymous user does NOT retry — single unauthenticated request', async () => {
    let tokenCalls = 0;
    _setTestProviders({
      getTesterKeys: () => [],
      getClerkToken: async () => { tokenCalls++; return null; },
      isClerkUserSignedIn: () => false,
    });
    fetchMock.mock.resetCalls();
    fetchMock.mock.mockImplementation(() => Promise.resolve(fakeRes(200)));

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(tokenCalls, 1, 'anonymous visitors must not pay the retry delay');
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), null);
  });

  // -------------------------------------------------------------------------
  // #5674 — the unauthenticated fallback must announce its premium intent.
  //
  // Without the marker the wm-session interceptor cannot tell an expected Pro
  // denial from a rejected anonymous cookie, so it mints a fresh session,
  // replays, 401s again, and suppresses EVERY anonymous API call for 15
  // minutes. `forcePremium` targets are the population that matters: their
  // path is deliberately absent from PREMIUM_RPC_PATHS (see
  // src/services/premium-intent.ts), so the path check cannot cover them.
  // -------------------------------------------------------------------------

  const FORCE_PREMIUM_TARGET = 'https://api.worldmonitor.app/api/news/v1/summarize-article';

  function fallbackInit(callIndex = 0): RequestInit | undefined {
    return fetchMock.mock.calls[callIndex].arguments[1] as RequestInit | undefined;
  }

  it('marks premium intent on the unauthenticated fallback for a forcePremium target', async () => {
    setup({ clerkToken: null });

    await premiumFetch(FORCE_PREMIUM_TARGET, { method: 'POST', forcePremium: true });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), null, 'this is the unauthenticated fallback');
    assert.equal(
      hasPremiumIntent(fallbackInit()),
      true,
      'an unauthenticated forcePremium request must be marked, or its expected 401 '
      + 'blacks out anonymous browsing for 15 minutes (#5674)',
    );
  });

  it('marks premium intent on the unauthenticated fallback for a path-listed premium target', async () => {
    // Redundant with the interceptor's path check, but keeps one rule rather
    // than two: "premiumFetch could not authenticate a premium request".
    setup({ clerkToken: null });

    await premiumFetch(TARGET);

    assert.equal(hasPremiumIntent(fallbackInit()), true);
  });

  it('does NOT mark a non-premium target — those still need session recovery', async () => {
    // The complement, and the one that must not regress: an ordinary
    // anonymous read depends on the wms_ cookie, so a genuine dead cookie
    // there must still trigger mint-and-replay.
    setup({ clerkToken: null });

    await premiumFetch(PUBLIC_TARGET);

    assert.equal(sentHeaders().get('Authorization'), null);
    assert.equal(
      hasPremiumIntent(fallbackInit()),
      false,
      'non-premium reads must keep full wm-session recovery',
    );
  });

  it('does NOT mark the pro-fresh price tape — forcePremium means something else there', async () => {
    // `forcePremium` is overloaded. On the summarize route it means "this call
    // requires Pro, so a 401 is an expected denial". In proFreshRpcFetch it
    // means "attach a Bearer opportunistically for a fresher cache tier" — the
    // route is NOT Pro-only, anonymous callers use it, and it 401s when the
    // wms_ cookie is rejected. Marking it would strip wm-session's 401 recovery
    // from the anonymous price tape and turn a recoverable cookie blip into a
    // dead panel.
    setup({ clerkToken: null });

    await proFreshRpcFetch(PRO_FRESH_MARKET_TARGET);

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(sentHeaders().get('Authorization'), null, 'anonymous: unauthenticated fallback');
    assert.equal(
      hasPremiumIntent(fallbackInit()),
      false,
      'a pro-fresh market read must keep wm-session 401 recovery',
    );
  });

  it('does not leak the marker into an authenticated request', async () => {
    setup({ clerkToken: 'clerk-jwt' });

    await premiumFetch(TARGET);

    assert.equal(sentHeaders().get('Authorization'), 'Bearer clerk-jwt');
    assert.equal(
      hasPremiumIntent(fallbackInit()),
      false,
      'an authenticated request already steps aside via its Authorization header',
    );
  });

  it('premium path: signed-in user with a still-null retry falls through unauthenticated', async () => {
    // If the token is genuinely unavailable (not just mid-rotation), the
    // single retry returns null too and we fall through — the gateway 401 is
    // then correct, and we never loop.
    let tokenCalls = 0;
    _setTestProviders({
      getTesterKeys: () => [],
      getClerkToken: async () => { tokenCalls++; return null; },
      isClerkUserSignedIn: () => true,
    });
    fetchMock.mock.resetCalls();
    fetchMock.mock.mockImplementation(() => Promise.resolve(fakeRes(200)));

    const res = await premiumFetch(TARGET);
    assert.equal(res.status, 200);
    assert.equal(tokenCalls, 2, 'retried once, then gives up — no infinite loop');
    assert.equal(sentHeaders().get('Authorization'), null);
  });
});

// ---------------------------------------------------------------------------
// reportServerError — the Sentry origin-5xx surface.
// ---------------------------------------------------------------------------
describe('reportServerError', () => {
  type CaptureCtx = { level: string; tags: Record<string, string>; fingerprint?: string[] };
  function makeSpy() {
    const calls: Array<{ msg: string; ctx: CaptureCtx }> = [];
    const enqueue = ((fn: (s: unknown) => void) => {
      fn({ captureMessage: (msg: string, ctx: CaptureCtx) => { calls.push({ msg, ctx }); } });
    }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
    return { calls, enqueue };
  }

  /** Capture one response and return the fingerprint Sentry would group on. */
  function fingerprintOf(res: Response, target: string = PUBLIC_TARGET): string[] | undefined {
    const { calls, enqueue } = makeSpy();
    reportServerError(res, target, enqueue);
    assert.equal(calls.length, 1, 'expected exactly one capture');
    return calls[0].ctx.fingerprint;
  }

  it('captures a genuine origin 503 at error level with kind api_5xx', () => {
    const { calls, enqueue } = makeSpy();
    reportServerError(new Response('oops', { status: 503 }), PUBLIC_TARGET, enqueue);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].msg, 'API 503: /api/economic/v1/get-fred-series-batch');
    assert.equal(calls[0].ctx.level, 'error');
    assert.equal(calls[0].ctx.tags.kind, 'api_5xx');
  });

  it('keeps Cloudflare edge 52x at warning with kind api_cf_5xx', () => {
    const { calls, enqueue } = makeSpy();
    reportServerError(new Response('cf', { status: 521 }), PUBLIC_TARGET, enqueue);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.level, 'warning');
    assert.equal(calls[0].ctx.tags.kind, 'api_cf_5xx');
  });

  it('skips the client-synthesized session-degraded 503 (X-Wm-Session-Degraded)', () => {
    // wm-session's dead-session cooldown fabricates this Response locally —
    // it never left the browser, so it must NOT be reported as an origin 5xx
    // (#5245: 17 per-endpoint `API 503:` issues flooded after #5219 shipped).
    const { calls, enqueue } = makeSpy();
    const res = new Response(JSON.stringify({ error: 'Anonymous session temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-Wm-Session-Degraded': '1' },
    });
    reportServerError(res, PUBLIC_TARGET, enqueue);
    assert.equal(calls.length, 0, 'synthetic degraded 503 must not be reported as an origin 5xx');
  });

  it('skips fail-closed rate-limit degradation already captured by the server', () => {
    const { calls, enqueue } = makeSpy();
    const res = new Response(JSON.stringify({ error: 'Rate-limit service temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-RateLimit-Mode': 'degraded' },
    });
    reportServerError(res, PUBLIC_TARGET, enqueue);
    assert.equal(calls.length, 0, 'rate-limit degradation must not be captured again by every browser');
  });

  // -------------------------------------------------------------------------
  // Grouping — WORLDMONITOR-P4.
  //
  // `captureMessage` varies the message per status (`API 520: …` vs
  // `API 503: …`), but these are message-only events (`attachStacktrace`
  // defaults to false and is never set), so Sentry groups them by message and
  // its server-side parameterization normalizes the status integer — both
  // collapse to one grouping message. Without an explicit fingerprint every
  // status for a path folds into ONE issue, titled by whichever fired first.
  //
  // Measured on WORLDMONITOR-P4 ("API 520: /api/economic/v1/get-fred-series-batch",
  // 2026-08-10): the group held `kind` = api_5xx x256 and api_cf_5xx x25, and
  // 92 of its last 100 events were status 503 from the 2026-07-12 origin
  // incident — only 8 were the 520 in the title. Three consequences:
  //   1. the headline count overstates the 520 population by ~11x;
  //   2. #3854's warning-vs-error split is void, because one issue carries one
  //      level — the warning 520s inherit the error 503s' grouping;
  //   3. an issue resolved with no release pin reopens and pages on ANY origin
  //      5xx for that path, not on the Cloudflare edge error it is named for.
  // -------------------------------------------------------------------------
  it('does not group a Cloudflare 520 with an origin 503 on the same path', () => {
    const cf = fingerprintOf(new Response('cf', { status: 520 }));
    const origin = fingerprintOf(new Response('oops', { status: 503 }));
    assert.ok(cf, 'Cloudflare edge capture must carry an explicit fingerprint');
    assert.ok(origin, 'origin 5xx capture must carry an explicit fingerprint');
    assert.notDeepEqual(
      cf, origin,
      'a CDN-transport 520 and an origin 503 are different failures and must not share a Sentry issue',
    );
  });

  it('keeps repeat events of the same status and path in one group', () => {
    // The fix must split by cause, not fragment per event — otherwise volume
    // stops being readable and every blip mints a fresh issue.
    const first = fingerprintOf(new Response('cf', { status: 520 }));
    const second = fingerprintOf(new Response('cf again', { status: 520 }));
    // Assert presence explicitly: two absent fingerprints are deep-equal, so
    // without this the case would pass vacuously against the unfixed code.
    assert.ok(first, 'fingerprint must be set');
    assert.deepEqual(first, second, 'two 520s on one path must stay a single issue');
  });

  it('separates two different origin 5xx statuses on the same path', () => {
    // The 520-vs-503 case above is also satisfied by grouping on the
    // Cloudflare-vs-origin class alone, which would leave every origin status
    // for a path folded together — the same defect one level down (a 500 from
    // a handler throw sharing an issue with a 503 from a dependency outage).
    assert.notDeepEqual(
      fingerprintOf(new Response('boom', { status: 500 })),
      fingerprintOf(new Response('down', { status: 503 })),
      'a 500 and a 503 are different origin failures and must not share a Sentry issue',
    );
  });

  it('separates the same status across different paths', () => {
    assert.notDeepEqual(
      fingerprintOf(new Response('cf', { status: 520 }), PUBLIC_TARGET),
      fingerprintOf(new Response('cf', { status: 520 }), 'https://www.worldmonitor.app/api/news/v1/summarize-article'),
      'per-path grouping is what makes the issue title actionable',
    );
  });

  it('pins the exact fingerprint tuple', () => {
    // Every other case here is relational (equal / not-equal), so a refactor
    // that reorders the tuple or renames a token keeps them green while
    // silently re-splitting every live Sentry issue — the groups are identified
    // by these literal strings, so the identity itself needs a test.
    assert.deepEqual(
      fingerprintOf(new Response('cf', { status: 520 })),
      ['api-cf-5xx', '/api/economic/v1/get-fred-series-batch', '520'],
    );
    assert.deepEqual(
      fingerprintOf(new Response('down', { status: 503 })),
      ['api-5xx', '/api/economic/v1/get-fred-series-batch', '503'],
    );
  });

  it('excludes the query string from the grouping key', () => {
    // `path` is `new URL(...).pathname`, which drops the query. Switching it to
    // `pathname + search` would mint one Sentry issue per distinct URL — the
    // cardinality blow-up the bounded-key claim rules out — and real callers do
    // send per-request query strings through premiumFetch (McpConnectModal
    // posts `/api/mcp-proxy?<qs>`). Two calls differing only in query must group
    // together, and no query value may reach the key.
    const withQuery = fingerprintOf(
      new Response('cf', { status: 520 }),
      `${PUBLIC_TARGET}?token=SECRET&cursor=abc`,
    );
    assert.deepEqual(withQuery, fingerprintOf(new Response('cf', { status: 520 })));
    assert.ok(
      !withQuery?.some((part) => part.includes('SECRET')),
      'no query-string value may enter the Sentry grouping key',
    );
  });

  it('groups a Request input with the equivalent string URL', () => {
    // reportServerError normalizes via `input instanceof Request ? input.url :
    // String(input)`. Callers pass both shapes, and one endpoint must stay one
    // issue regardless of which the caller used.
    assert.deepEqual(
      fingerprintOf(new Response('cf', { status: 520 }), PUBLIC_TARGET),
      (() => {
        const { calls, enqueue } = makeSpy();
        reportServerError(new Response('cf', { status: 520 }), new Request(PUBLIC_TARGET), enqueue);
        return calls[0].ctx.fingerprint;
      })(),
    );
  });

  it('exposes status as a searchable tag, not only in extra', () => {
    // Sentry does not index `extra`, so a status that lives only there is
    // readable per event but never aggregable. Both sibling fingerprint sites
    // mirror their grouping dimensions into tags; this pins that parity so a
    // triage query like `kind:api_5xx status:503` keeps working.
    const tagsFor = (status: number) => {
      const { calls, enqueue } = makeSpy();
      reportServerError(new Response('x', { status }), PUBLIC_TARGET, enqueue);
      return calls[0].ctx.tags;
    };
    assert.equal(tagsFor(503).status, '503');
    assert.equal(tagsFor(520).status, '520');
    assert.equal(tagsFor(520).kind, 'api_cf_5xx', 'kind must survive alongside status');
  });

  it('classifies the Cloudflare range at its exact boundaries', () => {
    // The 520-527 window now feeds the grouping key, not just the level and
    // tag, so an off-by-one here would re-split live issues rather than only
    // mislabel them. 530 is a real Cloudflare status that sits OUTSIDE the
    // window by design and must stay on the origin class.
    const classOf = (status: number) => fingerprintOf(new Response('x', { status }))?.[0];
    assert.equal(classOf(519), 'api-5xx', '519 is below the Cloudflare window');
    assert.equal(classOf(520), 'api-cf-5xx', '520 is the first Cloudflare code');
    assert.equal(classOf(527), 'api-cf-5xx', '527 is the last Cloudflare code');
    assert.equal(classOf(528), 'api-5xx', '528 is above the Cloudflare window');
    assert.equal(classOf(530), 'api-5xx', 'CF 530 is deliberately outside the transient-transport window');
  });
});
