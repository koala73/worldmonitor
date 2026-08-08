import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __testing__ as bootstrapTesting,
  fetchBootstrapData,
  getBootstrapHydrationState,
  getHydratedData,
  waitForBootstrapSlowTier,
} from '../src/services/bootstrap';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type FetchRequest = {
  url: string;
  signal: AbortSignal | null;
  deferred: Deferred<Response>;
};

const originalFetch = globalThis.fetch;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installFetchStub(): FetchRequest[] {
  const requests: FetchRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request: FetchRequest = {
      url: String(input),
      signal: init?.signal ?? null,
      deferred: deferred<Response>(),
    };
    requests.push(request);
    return request.deferred.promise;
  }) as typeof fetch;
  return requests;
}

function tierRequests(requests: FetchRequest[], tier: 'fast' | 'slow'): FetchRequest[] {
  return requests.filter((request) => request.url.includes(`tier=${tier}`));
}

describe('Frontend bootstrap runtime behavior', () => {
  beforeEach(() => {
    bootstrapTesting.resetBootstrapForTests();
  });

  afterEach(() => {
    bootstrapTesting.resetBootstrapForTests();
    globalThis.fetch = originalFetch;
  });

  it('returns after the fast tier and starts the slow tier only after fast state is committed', async () => {
    const requests = installFetchStub();
    let callbackState = getBootstrapHydrationState();

    const boot = fetchBootstrapData(() => {
      callbackState = getBootstrapHydrationState();
    });

    await tick();
    assert.equal(tierRequests(requests, 'fast').length, 1, 'fast tier should start immediately');
    assert.equal(tierRequests(requests, 'slow').length, 0, 'slow tier must wait for fast commit');

    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ fastKey: 'fast-value' }));
    await boot;

    assert.equal(getHydratedData('fastKey'), 'fast-value');
    assert.equal(tierRequests(requests, 'slow').length, 0, 'slow tier should be scheduled after boot returns');

    await tick();
    assert.equal(tierRequests(requests, 'slow').length, 1, 'slow tier should start after the deferred checkpoint');

    tierRequests(requests, 'slow')[0]!.deferred.resolve(jsonResponse({ slowKey: 'slow-value' }));
    assert.equal(await waitForBootstrapSlowTier(100), true);

    assert.equal(callbackState.tiers.slow.source, 'live', 'callback should observe updated slow state');
    assert.equal(getHydratedData('slowKey'), 'slow-value');
  });

  it('ignores a stale slow-tier completion from an earlier bootstrap generation', async () => {
    const requests = installFetchStub();
    const callbacks: string[] = [];

    const firstBoot = fetchBootstrapData(() => callbacks.push('first'));
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ firstFast: true }));
    await firstBoot;
    await tick();
    const firstSlow = tierRequests(requests, 'slow')[0]!;

    const secondBoot = fetchBootstrapData(() => callbacks.push('second'));
    assert.equal(firstSlow.signal?.aborted, true, 'new bootstrap should abort the old slow fetch');
    await tick();
    tierRequests(requests, 'fast')[1]!.deferred.resolve(jsonResponse({ secondFast: true }));
    await secondBoot;
    await tick();

    tierRequests(requests, 'slow')[1]!.deferred.resolve(jsonResponse({ currentSlow: 'current' }));
    assert.equal(await waitForBootstrapSlowTier(100), true);

    firstSlow.deferred.resolve(jsonResponse({ staleSlow: 'stale' }));
    await tick();

    assert.deepEqual(callbacks, ['second']);
    assert.equal(getHydratedData('currentSlow'), 'current');
    assert.equal(getHydratedData('staleSlow'), undefined);
  });

  it('swallows slow-tier failures and still settles the background checkpoint', async () => {
    const requests = installFetchStub();
    let callbackCount = 0;

    const boot = fetchBootstrapData(() => {
      callbackCount += 1;
    });
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ fastKey: true }));
    await boot;
    await tick();

    tierRequests(requests, 'slow')[0]!.deferred.reject(new Error('slow tier failed'));
    assert.equal(await waitForBootstrapSlowTier(100), true);

    assert.equal(callbackCount, 1);
    assert.equal(getBootstrapHydrationState().tiers.slow.source, 'none');
  });
});
