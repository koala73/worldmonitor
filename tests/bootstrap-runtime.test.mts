import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  __testing__ as bootstrapTesting,
  fetchBootstrapData,
  getBootstrapHydrationState,
  getHydratedData,
  waitForBootstrapSlowTier,
} from '../src/services/bootstrap';
import type { BootstrapTransferRumSample } from '../src/bootstrap/bootstrap-transfer-rum';

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
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function installLocalStorage(): void {
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

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
  return new Response(JSON.stringify({ data, missing: [] }), {
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
  let rumSamples: BootstrapTransferRumSample[];

  beforeEach(() => {
    installLocalStorage();
    bootstrapTesting.resetBootstrapForTests();
    rumSamples = [];
    bootstrapTesting.setBootstrapTransferRumTierForTests('fast');
    bootstrapTesting.setBootstrapTransferRumReporterForTests((sample) => rumSamples.push(sample));
    bootstrapTesting.setBootstrapTransferRumEnabledForTests(true);
    bootstrapTesting.setEncodedBodySizeResolverForTests(() => 321);
  });

  afterEach(() => {
    bootstrapTesting.resetBootstrapForTests();
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it('does not report the slow tier settled while a bootstrap is still in flight', async () => {
    // fetchBootstrapData clears slowTierSettled up front and only assigns it
    // once the fast tier has committed. waitForBootstrapSlowTier opens with
    // `if (!pending) return true`, so during that window "not scheduled yet"
    // was indistinguishable from "already done" and the wait no-opped.
    //
    // App.ts awaits this checkpoint before setting viewportHydrationReady and
    // registering the scroll listener, precisely so an early scroll cannot
    // consume the consume-once slow-tier hydration keys before they land
    // (getHydratedData deletes on read). A fail-open here opens that gate early
    // whenever Phase 6 wins the race against fast-tier completion — panels then
    // fall back to per-panel RPCs that never re-read the late payload, wasting
    // the ~500 KB slow tier. Surfaced as the #5876 e2e flaking under CI load.
    const requests = installFetchStub();
    const boot = fetchBootstrapData();

    await tick();
    assert.equal(tierRequests(requests, 'fast').length, 1, 'fast tier should be in flight');
    assert.equal(tierRequests(requests, 'slow').length, 0, 'slow tier must not be scheduled yet');

    // The bootstrap is running and the slow tier has NOT settled, so a bounded
    // wait must report "not settled" rather than clearing instantly.
    assert.equal(
      await waitForBootstrapSlowTier(50),
      false,
      'the checkpoint must not clear before the slow tier has even been scheduled',
    );

    // Let the boot finish so the suite leaves no in-flight state behind.
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ fastKey: 'fast' }));
    await boot;
    await tick();
    tierRequests(requests, 'slow')[0]!.deferred.resolve(jsonResponse({ slowKey: 'slow' }));
    assert.equal(await waitForBootstrapSlowTier(100), true, 'a settled slow tier still clears');
  });

  it('releases a superseded bootstrap checkpoint instead of stranding its awaiters', async () => {
    // The reservation must be resolved on EVERY path out of fetchBootstrapData,
    // not just the happy one. waitForBootstrapSlowTier captures `pending` at
    // call time, so an awaiter can be holding a generation's promise when a
    // newer bootstrap supersedes it and that generation returns early without
    // ever scheduling a slow tier. Leaving that promise unresolved would turn
    // the old fail-open into a permanent hang for waitForBootstrapSlowTier(0)
    // callers (CorrelationPanel awaits with no timeout).
    const requests = installFetchStub();
    const firstBoot = fetchBootstrapData();
    await tick();

    // Capture the checkpoint belonging to the FIRST generation, mid-flight.
    const captured = waitForBootstrapSlowTier(0);

    // A second bootstrap supersedes it; the first generation now returns early.
    const secondBoot = fetchBootstrapData();
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ a: 1 }));
    tierRequests(requests, 'fast')[1]!.deferred.resolve(jsonResponse({ b: 2 }));
    await firstBoot.catch(() => {});
    await secondBoot.catch(() => {});

    const outcome = await Promise.race([
      captured.then(() => 'resolved' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250)),
    ]);
    assert.equal(outcome, 'resolved', 'a superseded generation must not strand slow-tier awaiters');
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

    const fastData = { fastKey: 'fast-välue' };
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse(fastData));
    await boot;

    assert.equal(getHydratedData('fastKey'), 'fast-välue');
    assert.equal(tierRequests(requests, 'slow').length, 0, 'slow tier should be scheduled after boot returns');

    await tick();
    assert.equal(tierRequests(requests, 'slow').length, 1, 'slow tier should start after the deferred checkpoint');

    tierRequests(requests, 'slow')[0]!.deferred.resolve(jsonResponse({ slowKey: 'slow-value' }));
    assert.equal(await waitForBootstrapSlowTier(100), true);

    assert.equal(callbackState.tiers.slow.source, 'live', 'callback should observe updated slow state');
    assert.equal(getHydratedData('slowKey'), 'slow-value');
    assert.equal(rumSamples.length, 1, 'the unselected slow tier must not overwrite the page sample');
    assert.equal(rumSamples[0]!.tier, 'fast');
    assert.equal(rumSamples[0]!.outcome, 'complete');
    assert.equal(
      rumSamples[0]!.decoded_bytes,
      Buffer.byteLength(JSON.stringify({ data: fastData, missing: [] }), 'utf8'),
    );
    assert.equal(rumSamples[0]!.encoded_bytes, 321);
  });

  it('keeps the ordinary unsampled startup on the response.json path', async () => {
    bootstrapTesting.setBootstrapTransferRumEnabledForTests(false);
    const requests = installFetchStub();
    const boot = fetchBootstrapData(() => {});
    await tick();

    const response = jsonResponse({ fastKey: 'ordinary' });
    let textReads = 0;
    const originalText = response.text.bind(response);
    Object.defineProperty(response, 'text', {
      value: async () => {
        textReads += 1;
        return originalText();
      },
    });
    tierRequests(requests, 'fast')[0]!.deferred.resolve(response);
    await boot;

    assert.equal(getHydratedData('fastKey'), 'ordinary');
    assert.equal(textReads, 0);
    assert.deepEqual(rumSamples, []);
  });

  it('closes abort, HTTP, network, parse, and persistent-cache outcomes exactly once', async () => {
    const cases = [
      {
        expected: 'abort',
        settle(request: FetchRequest) {
          request.deferred.reject(new DOMException('aborted before headers', 'AbortError'));
        },
      },
      {
        expected: 'abort',
        settle(request: FetchRequest) {
          const response = new Response(null, { status: 200 });
          Object.defineProperty(response, 'text', {
            value: async () => { throw new DOMException('aborted during body', 'AbortError'); },
          });
          request.deferred.resolve(response);
        },
      },
      {
        expected: 'http-error',
        settle(request: FetchRequest) {
          request.deferred.resolve(new Response('unavailable', { status: 503 }));
        },
      },
      {
        expected: 'network-error',
        settle(request: FetchRequest) {
          request.deferred.reject(new Error('network down'));
        },
      },
      {
        expected: 'parse-error',
        settle(request: FetchRequest) {
          request.deferred.resolve(new Response('{not-json', { status: 200 }));
        },
      },
      {
        expected: 'parse-error',
        settle(request: FetchRequest) {
          request.deferred.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
        },
      },
      {
        expected: 'cached-fallback',
        cached: true,
        settle(request: FetchRequest) {
          request.deferred.reject(new Error('network down'));
        },
      },
    ] as const;

    for (const scenario of cases) {
      bootstrapTesting.resetBootstrapForTests();
      localStorage.clear();
      rumSamples = [];
      bootstrapTesting.setBootstrapTransferRumTierForTests('fast');
      bootstrapTesting.setBootstrapTransferRumReporterForTests((sample) => rumSamples.push(sample));
      bootstrapTesting.setBootstrapTransferRumEnabledForTests(true);
      bootstrapTesting.setEncodedBodySizeResolverForTests(() => 321);
      if ('cached' in scenario) {
        localStorage.setItem('worldmonitor-persistent-cache:bootstrap:tier:fast', JSON.stringify({
          key: 'bootstrap:tier:fast',
          updatedAt: Date.now(),
          data: { cachedFast: true },
        }));
      }

      const requests = installFetchStub();
      const boot = fetchBootstrapData(() => {});
      await tick();
      scenario.settle(tierRequests(requests, 'fast')[0]!);
      await boot;

      assert.equal(rumSamples.length, 1, `${scenario.expected} must close once`);
      assert.equal(rumSamples[0]!.outcome, scenario.expected);
      assert.equal(rumSamples[0]!.decoded_bytes, -1);
      assert.equal(rumSamples[0]!.encoded_bytes, -1);
    }
  });

  it('keeps persistent-cache recovery available when its telemetry reporter throws', async () => {
    localStorage.setItem('worldmonitor-persistent-cache:bootstrap:tier:fast', JSON.stringify({
      key: 'bootstrap:tier:fast',
      updatedAt: Date.now(),
      data: { cachedFast: true },
    }));
    bootstrapTesting.setBootstrapTransferRumReporterForTests(() => {
      throw new Error('telemetry unavailable');
    });
    const requests = installFetchStub();

    const boot = fetchBootstrapData(() => {});
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.reject(new Error('network down'));
    await boot;

    assert.equal(getHydratedData('cachedFast'), true);
    assert.equal(getBootstrapHydrationState().tiers.fast.source, 'cached');
    assert.ok(getBootstrapHydrationState().tiers.fast.updatedAt);
  });

  it('does not emit another custom-field outcome on a later bootstrap generation', async () => {
    const requests = installFetchStub();
    const first = fetchBootstrapData(() => {});
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ first: true }));
    await first;

    const second = fetchBootstrapData(() => {});
    await tick();
    tierRequests(requests, 'fast')[1]!.deferred.resolve(jsonResponse({ second: true }));
    await second;

    assert.equal(rumSamples.length, 1);
  });

  it('does not let a superseded fast request claim the page RUM sample', async () => {
    let encodedSizeCalls = 0;
    bootstrapTesting.setEncodedBodySizeResolverForTests(() => {
      encodedSizeCalls += 1;
      return 321;
    });
    const requests = installFetchStub();
    const first = fetchBootstrapData(() => {});
    await tick();

    const second = fetchBootstrapData(() => {});
    await tick();

    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ staleFast: true }));
    await first;
    assert.deepEqual(rumSamples, []);
    assert.equal(encodedSizeCalls, 0);

    tierRequests(requests, 'fast')[1]!.deferred.resolve(jsonResponse({ currentFast: true }));
    await second;

    assert.equal(rumSamples.length, 1);
    assert.equal(rumSamples[0]!.tier, 'fast');
    assert.equal(rumSamples[0]!.outcome, 'complete');
    assert.equal(encodedSizeCalls, 1);
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

  it('hands each hydrated key to exactly one reader', async () => {
    // Consume-once is what stops a second panel from rendering the boot
    // payload instead of fetching live data — the hydrated value is a
    // one-shot handoff, not a cache.
    const requests = installFetchStub();
    const boot = fetchBootstrapData(() => {});
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ fastKey: 'once' }));
    await boot;

    assert.equal(getHydratedData('fastKey'), 'once');
    assert.equal(
      getHydratedData('fastKey'),
      undefined,
      'a second read must not re-serve the boot payload',
    );
  });

  it('reports null for a key the payload never carried', async () => {
    const requests = installFetchStub();
    const boot = fetchBootstrapData(() => {});
    await tick();
    tierRequests(requests, 'fast')[0]!.deferred.resolve(jsonResponse({ fastKey: 'value' }));
    await boot;

    assert.equal(getHydratedData('neverSeeded'), undefined);
  });
});
