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
import { premiumFetch, _setTestProviders } from '@/services/premium-fetch';

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
});

