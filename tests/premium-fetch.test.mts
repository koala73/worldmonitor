/**
 * Unit tests for src/services/premium-fetch.ts
 *
 * Covers the auth injection matrix:
 *  - Passthrough when caller already sets auth header
 *  - Tester key: valid key → returns response immediately (no second fetch)
 *  - Tester key: 401 → falls through to Clerk JWT
 *  - Tester key: non-401 returned immediately (no fallback)
 *  - Tester key: network error / AbortError propagates to caller (not swallowed)
 *  - No keys, no Clerk → unauthenticated request forwarded
 *  - wm-widget-key / wm-pro-key precedence
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

const TARGET = 'https://api.worldmonitor.app/api/some-premium-rpc';

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
    clerkToken?: string | null;
    fetchImpl?: () => Promise<Response>;
  } = {}) {
    _setTestProviders({
      getTesterKey: () => opts.testerKey ?? '',
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
});
