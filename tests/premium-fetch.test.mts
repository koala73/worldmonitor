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
  function makeSpy() {
    const calls: Array<{ msg: string; ctx: { level: string; tags: Record<string, string> } }> = [];
    const enqueue = ((fn: (s: unknown) => void) => {
      fn({ captureMessage: (msg: string, ctx: { level: string; tags: Record<string, string> }) => { calls.push({ msg, ctx }); } });
    }) as unknown as typeof import('@/bootstrap/sentry-defer').enqueueSentryCall;
    return { calls, enqueue };
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
});
