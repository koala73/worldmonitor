import { describe, it, beforeEach, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * WORLDMONITOR-WW/WX/WY — `TypeError: Failed to fetch`, onunhandledrejection,
 * 2026-07-20.
 *
 * Umami's native tracker catches fetch/JSON failures internally, including a
 * non-OK collector response, so its public promise resolves even when the
 * identity write was not delivered. The facade observes only the synchronous
 * `/api/send` identify fetch, then keeps native processing intact while it
 * converts an actual delivery failure into its bounded retry signal.
 *
 * The fake tracker below deliberately has that same catch-and-resolve shape.
 * The unhandled-rejection coverage remains because the observer must consume
 * its own delivery promise too.
 */

const UMAMI_SEND_URL = 'https://abacus.worldmonitor.app/api/send';

const _store = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => _store.get(k) ?? null,
        setItem: (k: string, v: string) => { _store.set(k, v); },
        removeItem: (k: string) => { _store.delete(k); },
      },
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    },
  });
});

const { track, identifyUser, resetAnalyticsForTesting } = await import('../src/services/analytics.ts');
const { COLLECTOR_QUEUE_LIMIT } = await import('../src/services/analytics-collector-transport.ts');

type WinWithUmami = {
  umami?: { track: (...a: unknown[]) => unknown; identify: (...a: unknown[]) => unknown };
};

function nativeTrackerBeacon(type: 'event' | 'identify', data: Record<string, unknown> = {}): Promise<unknown> {
  return window.fetch(UMAMI_SEND_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type,
      payload: {
        website: 'e8800335-c853-46a8-8497-c993ed2f58bc',
        ...(type === 'event' && typeof data.name === 'string' ? { name: data.name } : {}),
        data,
      },
    }),
  }).then((response) => response.json()).catch(() => undefined);
}

const RECEIPT_BODY = JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' });

function collectorResponse(ok: boolean, status: number, body = ok ? RECEIPT_BODY : '{}'): Response {
  return {
    ok,
    status,
    json: async () => ({}),
    text: async () => body,
    clone: () => collectorResponse(ok, status, body),
  } as Response;
}

/** Install a v3.1.0-shaped tracker: fetch errors are caught and resolve. */
function stubFailingUmami(): void {
  (globalThis.window as WinWithUmami).umami = {
    track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
    identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
  };
}

/** Run `fire`, then fail if the beacon rejection escaped to onunhandledrejection. */
async function assertNoLeak(fire: () => void, label: string): Promise<void> {
  const leaked: unknown[] = [];
  const onUnhandled = (reason: unknown) => { leaked.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    fire();
    // Drain microtasks + give the host a macrotask to detect any
    // still-unhandled rejection.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      leaked,
      [],
      `${label}: beacon rejection leaked to onunhandledrejection: ${leaked.map(String).join(', ')}`,
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// Every suite below mutates the shared analytics transport and the process-wide
// `window` test double. Keep the suites serial even when test:data runs with
// `--test-concurrency=16`; otherwise another suite can reset or replace the
// collector between two awaited writes in the wiring assertions.
describe('umami beacon rejection is swallowed (WORLDMONITOR-WW/WX/WY)', { concurrency: false }, () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
    stubFailingUmami();
  });

  afterEach(() => {
    resetAnalyticsForTesting();
    delete (globalThis.window as WinWithUmami).umami;
  });

  it('track(): a failed beacon fetch never escapes to unhandledRejection', async () => {
    await assertNoLeak(() => track('theme-changed', { theme: 'dark' }), 'track');
  });

  it('identifyUser(): a failed beacon fetch never escapes to unhandledRejection', async () => {
    await assertNoLeak(() => identifyUser('user_1', 'free'), 'identify');
  });
});

type ScheduledTimer = {
  id: number;
  callback: () => void;
  delay: number;
  cancelled: boolean;
};

function installFakeTimers(): {
  timers: ScheduledTimer[];
  restore: () => void;
} {
  const timers: ScheduledTimer[] = [];
  const savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  const savedClearTimeout = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
  let nextId = 1;

  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: ((callback: () => void, delay = 0) => {
      const timer = { id: nextId, callback, delay, cancelled: false };
      nextId += 1;
      timers.push(timer);
      return timer.id;
    }) as typeof setTimeout,
  });
  Object.defineProperty(globalThis, 'clearTimeout', {
    configurable: true,
    value: ((timerId: number) => {
      const timer = timers.find((candidate) => candidate.id === timerId);
      if (timer) timer.cancelled = true;
    }) as typeof clearTimeout,
  });

  return {
    timers,
    restore: () => {
      if (savedSetTimeout) Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout);
      if (savedClearTimeout) Object.defineProperty(globalThis, 'clearTimeout', savedClearTimeout);
    },
  };
}

/**
 * Delays belonging to a collector-transport DEADLINE rather than to an in-page
 * re-send.
 *
 * Since #6288 every dispatch schedules a module-owned latch deadline
 * (`REQUEST_TIMEOUT_MS + LATCH_RELEASE_GRACE_MS`), and the health-report POST
 * schedules its own (`COLLECTOR_HEALTH_REPORT_TIMEOUT_MS + the same grace`). The
 * retry-policy tests below assert whether analytics.ts scheduled a RE-SEND, so
 * they must not count those.
 *
 * Deliberately a denylist, not an allowlist of the retry ladder: an unexpected
 * timer then reads as a retry and FAILS the "must not retry" assertions, rather
 * than being silently filtered away. If either constant above moves, these
 * tests go red instead of quietly losing their teeth.
 */
const TRANSPORT_DEADLINE_DELAYS = new Set([25_000, 7_000]);

/** The timers that represent an in-page re-send, in scheduling order. */
function retryTimers(timers: ScheduledTimer[]): ScheduledTimer[] {
  return timers.filter((timer) => !TRANSPORT_DEADLINE_DELAYS.has(timer.delay));
}

/**
 * Drain the microtask queue.
 *
 * A fixed tick count is a magic number tuned to the CURRENT await-chain depth
 * (gate -> queue -> dispatch -> inspectCollectorResponse -> outcome), and it
 * already had to be raised once. Pass `until` wherever the test depends on an
 * observable effect: the drain then stops as soon as it holds and FAILS LOUDLY
 * if it never does, instead of racing silently past the assertion.
 */
async function drainPromiseHandlers(until?: () => boolean, label = 'condition'): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    await Promise.resolve();
    if (until?.()) return;
  }
  if (until) throw new Error(`drainPromiseHandlers: ${label} never became true`);
}

describe('Umami client retry policy (#5715)', { concurrency: false }, () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    delete (globalThis.window as WinWithUmami).umami;
  });

  it('retries a retryable identity write twice at 1s and 2s, then stops after three failures', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    const collectorFetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 503));
    }) as typeof window.fetch;
    window.fetch = collectorFetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      identifyUser('user_1', 'pro');
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.notEqual(window.fetch, collectorFetch, 'the collector serialization gate remains installed');
      assert.equal(retryTimers(fakeTimers.timers)[0]?.delay, 1_000);

      retryTimers(fakeTimers.timers)[0]!.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 2);
      assert.equal(retryTimers(fakeTimers.timers)[1]?.delay, 2_000);

      retryTimers(fakeTimers.timers)[1]!.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 3);
      assert.equal(retryTimers(fakeTimers.timers).length, 2, 'the terminal failed attempt schedules no third timer');
    } finally {
      fakeTimers.restore();
    }
  });

  it('never retries track calls because an Umami 500 may already have committed the event row', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 500));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      track('checkout-success', { source: 'url-return' });
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.deepEqual(retryTimers(fakeTimers.timers), []);
    } finally {
      fakeTimers.restore();
    }
  });

  it('serializes concurrent event and identity writes through one collector request', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const resolveRequests: Array<(response: Response) => void> = [];
    window.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        resolveRequests.push((response) => {
          inFlight -= 1;
          resolve(response);
        });
      });
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    track('checkout-success', { source: 'url-return' });
    identifyUser('user_1', 'pro');
    await drainPromiseHandlers();

    assert.equal(calls, 1, 'the second write must wait behind the first');
    assert.equal(maxInFlight, 1, 'the collector must never receive concurrent session writes');

    resolveRequests.shift()!(collectorResponse(true, 200));
    await drainPromiseHandlers();
    assert.equal(calls, 2);
    assert.equal(maxInFlight, 1);

    resolveRequests.shift()!(collectorResponse(true, 200));
    await drainPromiseHandlers();
    assert.equal(inFlight, 0);
  });

  it('does not retry a conversion after a known session-data uniqueness failure', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 500, JSON.stringify({
        error: {
          errorObject: {
            code: 'P2002',
            meta: { target: ['session_data_pkey'] },
            message: 'Unique constraint failed on the fields: (session_data_id)',
          },
        },
      })));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
        payloadSecret: 'must-not-be-logged',
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      track('checkout-success', { source: 'url-return' });
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.deepEqual(retryTimers(fakeTimers.timers), [], 'known uniqueness failures are not safe to retry');
      const warning = JSON.stringify(warnings);
      assert.match(warning, /P2002/);
      assert.match(warning, /session_data_pkey/);
      assert.match(warning, /failureRate/);
      assert.doesNotMatch(warning, /must-not-be-logged/);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
    }
  });

  it('retries a conversion on a bounded transport failure and keeps its durable marker', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      // 429 is a pre-commit rejection, so a retry cannot double-count.
      return calls === 1
        ? Promise.resolve(collectorResponse(false, 429))
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };
    const storage = new Map<string, string>();
    (globalThis.window as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    try {
      const analytics = await import('../src/services/analytics.ts');
      analytics.trackCheckoutSuccess('url-return');
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.equal(storage.get('wm-checkout-success-pending'), 'url-return');
      assert.equal(retryTimers(fakeTimers.timers)[0]?.delay, 1_000);

      retryTimers(fakeTimers.timers)[0]!.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 2);
      assert.equal(storage.has('wm-checkout-success-pending'), false, 'clear only after a 2xx response');
    } finally {
      fakeTimers.restore();
    }
  });

  it('keeps delivering after another wrapper takes over window.fetch (#5964 deadlock)', async () => {
    // Production boot order: the collector gate installs at first paint + 3s,
    // Sentry's deferred init patches window.fetch at 10s. If the gate re-wrapped
    // on top of that, the second gate would delegate through the first into the
    // SAME queue while the slot was already held — the outer request awaits an
    // inner one that can never drain, and every later write is lost forever.
    let networkCalls = 0;
    const network = (() => {
      networkCalls += 1;
      return Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    window.fetch = network;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    track('checkout-start', { source: 'probe' });
    await drainPromiseHandlers();
    assert.equal(networkCalls, 1, 'baseline: the gate delivers the first event');

    // A later wrapper (Sentry breadcrumbs/tracing) takes over and delegates down.
    const gate = window.fetch;
    window.fetch = ((i: RequestInfo | URL, x?: RequestInit) => gate(i, x)) as typeof window.fetch;

    track('checkout-success', { source: 'url-return' });
    await drainPromiseHandlers();
    assert.equal(networkCalls, 2, 'a write after the foreign wrapper must still reach the network');

    track('checkout-failed', { status: 'declined' });
    await drainPromiseHandlers();
    assert.equal(networkCalls, 3, 'the queue must keep draining, not wedge');
  });

  it('does not retry a conversion on a gateway error that may follow a commit', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 504));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      track('checkout-success', { source: 'url-return' });
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.deepEqual(
        retryTimers(fakeTimers.timers),
        [],
        'a 502/504 cannot be distinguished from commit-then-edge-failure, so it must not retry',
      );
    } finally {
      fakeTimers.restore();
    }
  });

  it('still retries an identity write on HTTP 500 (the original #5715 failure)', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 500));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      identifyUser('user_1', 'pro');
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      // identify is an idempotent latest-snapshot write, so the
      // duplicate-conversion rationale that blocks event retries does not apply.
      assert.equal(retryTimers(fakeTimers.timers)[0]?.delay, 1_000, 'a 500 identity write must still retry');
    } finally {
      fakeTimers.restore();
    }
  });

  it('clears the durable marker on a 502/504 so the next boot cannot duplicate', async () => {
    // The mirror of the receiptless-200 case below. 502/504 reach the origin,
    // which may have committed the event row before failing — that ambiguity is
    // why the in-page retry refuses to re-send them. Keeping the marker armed
    // would let replayPendingCheckoutSuccess re-send it on the next boot anyway,
    // turning one purchase into two conversions.
    for (const status of [502, 504]) {
      resetAnalyticsForTesting();
      const fakeTimers = installFakeTimers();
      let calls = 0;
      window.fetch = (() => {
        calls += 1;
        return Promise.resolve(collectorResponse(false, status));
      }) as typeof window.fetch;
      (globalThis.window as WinWithUmami).umami = {
        track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
          ...(data as Record<string, unknown> | undefined),
          name: event as string,
        }),
        identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
      };
      const storage = new Map<string, string>();
      (globalThis.window as Record<string, unknown>).sessionStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      };

      try {
        const analytics = await import('../src/services/analytics.ts');
        analytics.trackCheckoutSuccess('url-return');
        await drainPromiseHandlers();
        assert.equal(calls, 1, `HTTP ${status}: one attempt`);
        assert.equal(
          storage.has('wm-checkout-success-pending'),
          false,
          `HTTP ${status} may follow a committed row, so the marker must not survive to replay it`,
        );
      } finally {
        fakeTimers.restore();
      }
    }
  });

  it('flushes queued writes on pagehide instead of losing them to navigation', async () => {
    // The tracker sends with keepalive:true so an in-flight request survives
    // unload — but a write still sitting in this queue was never handed to the
    // network stack, so keepalive cannot protect it.
    const listeners: Record<string, Array<() => void>> = {};
    (globalThis.window as Record<string, unknown>).addEventListener = (
      type: string,
      handler: () => void,
    ) => {
      (listeners[type] ??= []).push(handler);
    };
    (globalThis.window as Record<string, unknown>).removeEventListener = () => {};

    let calls = 0;
    let releaseFirst: ((response: Response) => void) | undefined;
    window.fetch = (() => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    // Occupy the single in-flight slot with a write that never settles.
    track('theme-changed', { theme: 'dark' });
    await drainPromiseHandlers();
    assert.equal(calls, 1);

    // A conversion queues behind it and would die with the navigation.
    track('checkout-start', { productId: 'pro-monthly', surface: 'dashboard', authed: false });
    await drainPromiseHandlers();
    assert.equal(calls, 1, 'queued behind the stalled write');

    assert.ok((listeners.pagehide ?? []).length > 0, 'the gate registered a pagehide flush');
    for (const handler of listeners.pagehide ?? []) handler();
    await drainPromiseHandlers();
    assert.equal(calls, 2, 'pagehide dispatches the backlog so keepalive can carry it');

    releaseFirst?.(collectorResponse(true, 200, RECEIPT_BODY));
    await drainPromiseHandlers();
  });

  it('treats a receiptless 200 as undelivered and keeps the durable marker', async () => {
    // Umami answers 200 to a bot-filtered write it silently drops. The CI
    // monitor already refuses that shape; the browser must agree or it clears a
    // conversion marker for an event that was never stored.
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, '{"beep":"boop"}'));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };
    const storage = new Map<string, string>();
    (globalThis.window as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    try {
      const analytics = await import('../src/services/analytics.ts');
      analytics.trackCheckoutSuccess('url-return');
      await drainPromiseHandlers();
      assert.equal(calls, 1);
      assert.equal(
        storage.get('wm-checkout-success-pending'),
        'url-return',
        'a 200 without a write receipt must not clear the marker',
      );
    } finally {
      fakeTimers.restore();
    }
  });

  it('clears the durable marker on a P2002 conflict, which commits the event row', async () => {
    // Umami writes the event in saveEvent() and only then upserts session_data,
    // so #4183's P2002 means the event committed. Treating it as undelivered
    // would replay the conversion on every reload for the life of the tab.
    const fakeTimers = installFakeTimers();
    window.fetch = (() => Promise.resolve(collectorResponse(false, 500, JSON.stringify({
      error: { errorObject: { code: 'P2002', meta: { target: ['session_data_pkey'] } } },
    })))) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };
    const storage = new Map<string, string>();
    (globalThis.window as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    try {
      const analytics = await import('../src/services/analytics.ts');
      analytics.trackCheckoutSuccess('url-return');
      await drainPromiseHandlers();
      assert.equal(
        storage.has('wm-checkout-success-pending'),
        false,
        'a committed event must not replay across boots',
      );
      assert.deepEqual(retryTimers(fakeTimers.timers), [], 'and it must not retry in-page either');
    } finally {
      fakeTimers.restore();
    }
  });

  it('drops a non-critical write before a queued conversion when the queue overflows', async () => {
    // A never-settling collector keeps the single in-flight slot busy so the
    // queue fills. None of the three eviction branches had any coverage.
    //
    // Fake timers are load-bearing, not decoration: the parked request never
    // settles, so its latch deadline (#6288) never reaches `cleanup()`. On real
    // timers that leaves a live 21s timeout holding the node event loop open
    // after the test body returns, adding ~21s of pure wall-clock to every run
    // of this file.
    const fakeTimers = installFakeTimers();
    const warnings: Array<Record<string, unknown>> = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const detail = args[1];
      if (detail && typeof detail === 'object') warnings.push(detail as Record<string, unknown>);
    };
    window.fetch = (() => parkForever()) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      // Fill past the queue bound with non-critical events. Sized from the real
      // constant: this loop used to be a literal 30 against a bound of 25, so
      // raising the bound to 50 left it filling only 60% of the queue — the
      // eviction under test simply stopped happening.
      for (let index = 0; index < COLLECTOR_QUEUE_LIMIT + 5; index += 1) track('search-open');
      await drainPromiseHandlers(
        () => warnings.some((w) => w.failureKind === 'queue-overflow'),
        'a queued non-critical write is dropped',
      );

      const before = warnings.length;
      track('checkout-success', { source: 'url-return' });
      await drainPromiseHandlers(() => warnings.length > before, 'the conversion displaces a queued write');

      // The conversion itself must not be the one rejected — a critical event
      // evicts a non-critical rather than being dropped for it.
      const overflow = warnings.filter((w) => w.failureKind === 'queue-overflow');
      assert.ok(overflow.length > 0, 'overflow must be reported, not silent');
      assert.ok(
        overflow.every((w) => w.requestType === 'event'),
        'only event writes were enqueued in this test',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
    }
  });

  it('keeps the /pro marker until every replayed checkout-start is confirmed', async () => {
    // Writes are serialized now, so only replay #1 is in flight when it lands.
    // Clearing the marker on that first receipt would drop #2 on a reload.
    const resolvers: Array<(response: Response) => void> = [];
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };
    const storage = new Map<string, string>();
    storage.set('wm-pro-funnel-pending', JSON.stringify([
      { event: 'checkout-start', data: { productId: 'p1', surface: 'pro-page', authed: true } },
      { event: 'checkout-start', data: { productId: 'p2', surface: 'pro-page', authed: true } },
    ]));
    (globalThis.window as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    const analytics = await import('../src/services/analytics.ts');
    analytics.replayPendingProFunnelEvents();
    await drainPromiseHandlers(() => calls === 1, 'the first replay reaches the collector');

    resolvers.shift()!(collectorResponse(true, 200));
    await drainPromiseHandlers(() => calls === 2, 'the second replay follows the first');
    assert.equal(
      storage.has('wm-pro-funnel-pending'),
      true,
      'the marker must survive until the whole batch is acknowledged',
    );

    resolvers.shift()!(collectorResponse(true, 200));
    await drainPromiseHandlers(
      () => !storage.has('wm-pro-funnel-pending'),
      'the marker clears once every replay is confirmed',
    );
  });

  it('cancels a stale retry when a newer identity snapshot is sent', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(calls !== 1, calls === 1 ? 503 : 200));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      identifyUser('user_1', 'free');
      await drainPromiseHandlers();
      assert.equal(retryTimers(fakeTimers.timers).length, 1);

      identifyUser('user_1', 'pro');
      await drainPromiseHandlers();
      assert.equal(calls, 2);
      assert.equal(retryTimers(fakeTimers.timers)[0]!.cancelled, true);
    } finally {
      fakeTimers.restore();
    }
  });

  it('serializes live identity writes and coalesces updates received while one is in flight', async () => {
    let resolveFirstResponse: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const payloads: Array<{ type: string; data: Record<string, unknown> }> = [];
    let calls = 0;
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      payloads.push(JSON.parse(String(init?.body)));
      return calls === 1
        ? firstResponse
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (_event: unknown, data?: unknown) => nativeTrackerBeacon('event', (data ?? {}) as Record<string, unknown>),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    identifyUser('user_1', 'free');
    identifyUser('user_1', 'pro', 'active', 'monthly');
    identifyUser('user_1', 'pro', 'cancelled', 'annual');
    await drainPromiseHandlers();

    assert.equal(calls, 1, 'a newer snapshot waits for the active collector write');

    resolveFirstResponse!(collectorResponse(true, 200));
    await drainPromiseHandlers();

    assert.equal(calls, 2, 'only one coalesced snapshot follows the active write');
    assert.deepEqual(payloads[1], {
      type: 'identify',
      payload: {
        website: 'e8800335-c853-46a8-8497-c993ed2f58bc',
        data: {
          userId: 'user_1',
          plan: 'pro',
          subStatus: 'cancelled',
          planKey: 'annual',
        },
      },
    });
  });
});

const {
  inspectCollectorResponse,
  collectorFailureFromError,
  isRetryableCollectorFailure,
  isRetryableIdentityFailure,
  isAlertWorthyCollectorFailure,
  installCollectorFetchGate,
  getCollectorHealthForTesting,
  _setCollectorHealthReporterForTesting,
} = await import('../src/services/analytics-collector-transport.ts');

function collectorEventInit(signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({ type: 'event', payload: { name: 'search-open' } }),
    ...(signal ? { signal } : {}),
  };
}

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  assert.ok(signal, 'the collector request must carry a timeout signal');
  return new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * The reason a real `AbortSignal.timeout()` aborts with.
 *
 * Shaped to match what the platform produces — an Error subclass named
 * `TimeoutError` — because that name is exactly what `collectorFailureFromError`
 * keys on to classify the failure as `timeout` rather than `network`. Using a
 * plain Error here would still satisfy that check while quietly diverging from
 * the thing being simulated.
 */
function createNativeTimeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

describe('collector request timeout compatibility (#6086)', { concurrency: false }, () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    resetAnalyticsForTesting();
  });

  it('aborts a stalled request and drains the queue without AbortSignal.timeout', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    let calls = 0;
    console.warn = () => {};
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return calls === 1
        ? rejectWhenAborted(init?.signal)
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const stalled = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'the second write waits for the stalled request');

      const deadline = fakeTimers.timers.find((timer) => timer.delay === 20_000);
      assert.ok(deadline, 'the compatibility path must schedule the 20s deadline');
      deadline.callback();

      await assert.rejects(stalled, { name: 'TimeoutError' });
      assert.equal((await queued).status, 200);
      assert.equal(calls, 2, 'the timed-out request releases the serialized queue');
      assert.ok(fakeTimers.timers.every((timer) => timer.cancelled), 'settled requests clean up their timers');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('keeps the deadline when AbortSignal.any is unavailable and a caller signal exists', async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => rejectWhenAborted(init?.signal)) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const caller = new AbortController();
      const stalled = window.fetch(UMAMI_SEND_URL, collectorEventInit(caller.signal));
      await drainPromiseHandlers();

      const deadline = fakeTimers.timers.find((timer) => timer.delay === 20_000);
      assert.ok(deadline, 'the caller signal must not replace the collector deadline');
      deadline.callback();

      await assert.rejects(stalled, { name: 'TimeoutError' });
      assert.ok(deadline.cancelled, 'the timeout timer is cleared after rejection');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    }
  });

  it('forwards caller cancellation when AbortSignal.any is unavailable', async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => rejectWhenAborted(init?.signal)) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const caller = new AbortController();
      const reason = new Error('caller cancelled collector write');
      const request = window.fetch(UMAMI_SEND_URL, collectorEventInit(caller.signal));
      caller.abort(reason);

      await assert.rejects(request, (error) => error === reason);
      assert.equal(fakeTimers.timers[0]?.delay, 20_000, 'caller cancellation retains the collector deadline');
      assert.ok(fakeTimers.timers.every((timer) => timer.cancelled), 'caller cancellation clears the deadline');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    }
  });

  // The three tests above each DISABLE a native API to reach withManualAbort.
  // Nothing covered the branches almost all real traffic takes, so a regression
  // dropping the deadline on the native path would have shipped green.
  it('binds the deadline on the native AbortSignal path, with and without a caller signal', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    // No caller signal -> the AbortSignal.timeout branch.
    await window.fetch(UMAMI_SEND_URL, collectorEventInit());
    assert.ok(seen[0] instanceof AbortSignal, 'the native path must still bind a deadline signal');

    // Caller signal present -> the AbortSignal.any composition branch.
    const caller = new AbortController();
    await window.fetch(UMAMI_SEND_URL, collectorEventInit(caller.signal));
    const composed = seen[1];
    assert.ok(composed instanceof AbortSignal, 'a caller signal must not drop the collector deadline');
    assert.notEqual(composed, caller.signal, 'the caller signal must be composed with the deadline, not used raw');
    caller.abort(new Error('caller cancelled collector write'));
    assert.ok(composed.aborted, 'caller cancellation must propagate through the composed signal');
  });

  // The test above asserts the SHAPE of the native signals (they exist, the
  // composed signal is not the caller's raw signal, caller aborts reach it) —
  // none of which requires either signal to carry a live deadline.
  // `new AbortController().signal` on the no-caller branch and
  // `AbortSignal.any([existing, existing])` on the caller branch both satisfy
  // those assertions, and both mutants ARE #6086: the deadline silently drops.
  //
  // Proving the deadline is live means firing it, which the real
  // `AbortSignal.timeout` gives no handle on — hence the controllable stand-in.
  // Both branches under test are `withRequestAbort`'s native paths; what is stubbed
  // is only the clock, not the code path.
  it('fires the native deadline with and without a caller signal', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const deadlines: { ms: number; controller: AbortController }[] = [];
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: (ms: number) => {
        const controller = new AbortController();
        deadlines.push({ ms, controller });
        return controller.signal;
      },
    });
    let calls = 0;
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return calls === 1
        ? rejectWhenAborted(init?.signal)
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const scenarios = [
        { label: 'without a caller signal', caller: undefined },
        { label: 'with a caller signal', caller: new AbortController() },
      ] as const;

      for (const { label, caller } of scenarios) {
        calls = 0;
        deadlines.length = 0;
        const stalled = window.fetch(UMAMI_SEND_URL, collectorEventInit(caller?.signal));
        const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
        await drainPromiseHandlers();

        assert.equal(deadlines.length, 1, `${label}: the native path must request a collector deadline`);
        assert.equal(deadlines[0]?.ms, 20_000, `${label}: the deadline must be the collector bound`);
        assert.equal(calls, 1, `${label}: the second write waits for the stalled request`);

        // Fire the DEADLINE, never the caller signal. If either native branch
        // substituted a non-timing signal, nothing aborts and both awaits hang.
        deadlines[0]?.controller.abort(createNativeTimeoutError());

        await assert.rejects(stalled, { name: 'TimeoutError' });
        assert.equal((await queued).status, 200);
        assert.equal(calls, 2, `${label}: the native deadline must release the serialized queue`);
        if (caller) assert.equal(caller.signal.aborted, false, 'the caller signal was never the thing aborted');
      }
    } finally {
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // The forwarded caller-abort listener is removed in `cleanup()`, which the PR
  // body claims and the issue asked for. `{ once: true }` self-removes only when
  // the signal DOES abort, so the leak lives in the opposite case — a write that
  // completes normally against a caller signal that outlives it. Nothing else in
  // this file observes a caller signal's listener set, so deleting the
  // `removeEventListener` line leaves the whole suite green.
  it('removes the forwarded caller-abort listener when a write completes normally', async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    // Force the manual path: it is the only one that registers a listener.
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    window.fetch = (() => Promise.resolve(collectorResponse(true, 200))) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const caller = new AbortController();
      let added = 0;
      let removed = 0;
      const realAdd = caller.signal.addEventListener.bind(caller.signal);
      const realRemove = caller.signal.removeEventListener.bind(caller.signal);
      caller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === 'abort') added += 1;
        return (realAdd as (...args: unknown[]) => void)(type, ...rest);
      }) as typeof caller.signal.addEventListener;
      caller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === 'abort') removed += 1;
        return (realRemove as (...args: unknown[]) => void)(type, ...rest);
      }) as typeof caller.signal.removeEventListener;

      const response = await window.fetch(UMAMI_SEND_URL, collectorEventInit(caller.signal));
      assert.equal(response.status, 200);

      assert.equal(added, 1, 'the manual path must forward the caller signal exactly once');
      assert.equal(removed, 1, 'cleanup must remove the forwarded listener on normal completion');
      assert.equal(caller.signal.aborted, false, 'a completed write must not abort the caller signal');
    } finally {
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    }
  });

  // Bounded explicitly: if the pre-aborted branch regresses, an already-aborted
  // signal never fires a future 'abort' event, so nothing aborts the controller
  // and BOTH awaits below hang forever. node:test has no default timeout, so
  // without this the regression would stall CI instead of failing it.
  it('forwards a caller signal that was already aborted before dispatch', { timeout: 10_000 }, async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    let calls = 0;
    console.warn = () => {};
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return calls === 1
        ? rejectWhenAborted(init?.signal)
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const caller = new AbortController();
      const reason = new Error('cancelled before the write was dispatched');
      // Aborted BEFORE the write reaches withManualAbort, so the synchronous
      // `if (existing?.aborted) forwardAbort()` branch runs instead of the
      // addEventListener path the other tests exercise.
      caller.abort(reason);

      const request = window.fetch(UMAMI_SEND_URL, collectorEventInit(caller.signal));
      await assert.rejects(request, (error) => error === reason);

      const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      assert.equal((await queued).status, 200, 'a pre-aborted write must not wedge the serialized queue');
      assert.ok(fakeTimers.timers.length > 0, 'the pre-aborted path still schedules a deadline');
      assert.ok(fakeTimers.timers.every((timer) => timer.cancelled), 'the pre-aborted path still clears its timer');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    }
  });
});

/**
 * A transport that DISCARDS its abort signal and never settles.
 *
 * Every fixture in the #6086 block above (`rejectWhenAborted`) is maximally
 * cooperative: it rejects the instant the signal fires. Such a fixture can only
 * ever confirm the signal was ATTACHED — never that the queue survives a
 * transport that throws the signal away. This is the shape a fetch-wrapping RUM
 * SDK produces when it re-times a request by rebuilding it
 * (`orig(new Request(url, { method, headers, body }))`), which silently drops
 * `init.signal`, and the shape of a wrapper that re-wraps the promise without
 * forwarding rejection.
 */
function parkForever(): Promise<Response> {
  return new Promise<Response>(() => {
    // Deliberately never settles and never observes an abort. This is the
    // premise of #6288, not an oversight.
  });
}

/**
 * Page-lifecycle stub for #6968: the gate listens on `window` for pagehide and
 * on `document` for visibilitychange, and it reads `document.visibilityState`
 * on every drain. Tests that only stub `window.addEventListener` never see the
 * visibility half.
 */
function stubPageLifecycle(initialVisibility: DocumentVisibilityState | 'unknown' = 'visible'): {
  setVisibility(state: DocumentVisibilityState | 'unknown'): void;
  firePageHide(persisted?: boolean): void;
  firePageShow(): void;
  fireVisibilityChange(): void;
  restore(): void;
} {
  let visibilityState = initialVisibility;
  type WindowLifecycleHandler = (event?: { persisted?: boolean }) => void;
  const windowListeners: Record<string, Array<WindowLifecycleHandler>> = {};
  const documentListeners: Record<string, Array<() => void>> = {};
  const windowRecord = globalThis.window as Record<string, unknown>;
  const savedAdd = windowRecord.addEventListener;
  const savedRemove = windowRecord.removeEventListener;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  windowRecord.addEventListener = (type: string, handler: WindowLifecycleHandler) => {
    (windowListeners[type] ??= []).push(handler);
  };
  windowRecord.removeEventListener = () => {};
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return visibilityState; },
      addEventListener(type: string, handler: () => void) {
        (documentListeners[type] ??= []).push(handler);
      },
      removeEventListener() {},
    },
  });
  return {
    setVisibility(state: DocumentVisibilityState | 'unknown') { visibilityState = state; },
    firePageHide(persisted = false) {
      for (const handler of windowListeners.pagehide ?? []) handler({ persisted });
    },
    firePageShow() {
      for (const handler of windowListeners.pageshow ?? []) handler();
    },
    fireVisibilityChange() {
      for (const handler of documentListeners.visibilitychange ?? []) handler();
    },
    restore() {
      windowRecord.addEventListener = savedAdd;
      windowRecord.removeEventListener = savedRemove;
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

/**
 * The module-owned latch deadline, pinned to its exact delay.
 *
 * NOT "any timer later than the request bound": a deadline pushed far enough
 * out is indistinguishable from no deadline at all, and a `> 20_000` predicate
 * accepts one happily. Matching the exact value means both halves of
 * `REQUEST_TIMEOUT_MS + LATCH_RELEASE_GRACE_MS` are pinned — moving either one
 * turns these tests red instead of quietly widening the bound.
 */
const LATCH_DEADLINE_MS = 25_000;
const LATCH_RELEASE_GRACE_MS = 5_000;

function findLatchDeadline(timers: ScheduledTimer[]): ScheduledTimer | undefined {
  // `!cancelled` matters once a test issues more than one write: earlier
  // requests leave their own cleared deadlines in the array, and firing one of
  // those is a no-op that hangs the test on a request whose real deadline is
  // still pending.
  return timers.find((timer) => timer.delay === LATCH_DEADLINE_MS && !timer.cancelled);
}

/**
 * #6288 — PR #6088 closed the two abort-binding paths that returned an
 * unbounded `init`, so every collector write now carries a deadline. But that
 * deadline is REQUEST-side: `AbortController` only settles a fetch if the
 * implementation underneath honors the signal, and `collectorRequestInFlight`
 * is released from exactly one place — the `.finally()` on
 * `runCollectorRequest`, which cannot run until `await responsePromise`
 * returns. That promise belongs to whatever `window.fetch` was at install time.
 *
 * `src/bootstrap/sentry-init.ts` documents third-party `window.fetch` wrapping
 * as a live condition on this exact collector host (the Adjust SDK, the
 * DebugBear RUM collector, page-inspector and wallet extensions). Production
 * confirms the consequence: WORLDMONITOR-YD carries 85 `queue-overflow` events
 * over 81 users in which 36% report a single collector write in the whole 60s
 * health window — a `COLLECTOR_QUEUE_LIMIT` of 50 cannot be reached by one
 * write, so the queue was already full before the window opened and never
 * drained.
 *
 * The tests below therefore assert what the #6086 fixtures structurally cannot:
 * the latch releases WITHOUT the transport promise ever settling.
 */
describe('collector latch release is module-owned (#6288)', { concurrency: false }, () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    resetAnalyticsForTesting();
  });

  // The native branch is the sharper half: it owns no module-side timer at all,
  // so the ENTIRE deadline lives inside the `AbortSignal.timeout` object a
  // rebuilding wrapper discards. Essentially all real traffic takes this path.
  it('releases the serialized queue when a native-path transport discards the abort signal', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const requestDeadlines: { ms: number; controller: AbortController }[] = [];
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: (ms: number) => {
        const controller = new AbortController();
        requestDeadlines.push({ ms, controller });
        return controller.signal;
      },
    });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    let calls = 0;
    let parkedSettled = false;
    window.fetch = (() => {
      calls += 1;
      return calls === 1 ? parkForever() : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.then(() => { parkedSettled = true; }, () => { parkedSettled = true; });
      const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'the second write waits behind the parked request');

      // Fire the request-side deadline exactly as production does. It reaches a
      // transport that threw the signal away, so nothing settles. This is the
      // boundary #6088 bought and no further.
      assert.equal(requestDeadlines[0]?.ms, 20_000, 'the native path must still bind the request-side deadline');
      requestDeadlines[0]?.controller.abort(createNativeTimeoutError());
      await drainPromiseHandlers();
      assert.equal(parkedSettled, false, 'the premise: the transport promise never settles');
      assert.equal(calls, 1, 'aborting a transport that discards the signal cannot drain the queue');

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline the transport cannot withhold');
      latchDeadline.callback();

      const error = await parked.then(() => null, (reason: unknown) => reason);
      assert.equal((error as Error | null)?.name, 'TimeoutError');
      await drainPromiseHandlers(() => calls === 2, 'the queued write reaches the network');
      assert.equal((await queued).status, 200, 'the write behind the park is delivered, not shed');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('releases the serialized queue on the compatibility path too', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return calls === 1 ? parkForever() : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'the second write waits behind the parked request');

      const requestDeadline = fakeTimers.timers.find((timer) => timer.delay === 20_000);
      assert.ok(requestDeadline, 'the compatibility path must still schedule the 20s request bound');
      requestDeadline.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'withManualAbort aborts a controller the transport never listened to');

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline on the compatibility path as well');
      latchDeadline.callback();

      await assert.rejects(parked, { name: 'TimeoutError' });
      await drainPromiseHandlers(() => calls === 2, 'the queued write reaches the network');
      assert.equal((await queued).status, 200);
      assert.ok(
        fakeTimers.timers.every((timer) => timer.cancelled),
        'a released request clears both its request bound and its latch deadline',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // A cooperative transport must keep its EXISTING timing and classification.
  // Without a grace period the two deadlines expire on the same tick and the
  // winner is unspecified — on the native path the platform abort timer and the
  // module timer are not even ordered against each other — so every honored
  // abort would intermittently be reclassified as a raced-out request and lose
  // its retry.
  it('lets a cooperative transport win the race, keeping the honored-abort classification', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => rejectWhenAborted(init?.signal)) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const stalled = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();

      const requestDeadline = fakeTimers.timers.find((timer) => timer.delay === 20_000);
      assert.ok(requestDeadline, 'the request bound must be scheduled');
      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the latch deadline must be scheduled');
      assert.ok(
        latchDeadline.delay > requestDeadline.delay,
        'the latch deadline must expire strictly after the request bound, or the winner is a coin flip',
      );

      // Only the request bound fires. A transport that honors it settles first.
      requestDeadline.callback();

      const error = await stalled.then(() => null, (reason: unknown) => reason);
      assert.equal((error as Error | null)?.name, 'TimeoutError');
      assert.deepEqual(
        collectorFailureFromError(error),
        { kind: 'timeout' },
        'an honored abort is NOT a raced-out request and keeps its existing retry policy',
      );
      assert.ok(latchDeadline.cancelled, 'the latch deadline is cleared when the transport settles first');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // Releasing the latch frees the queue but CANNOT stop the underlying request.
  // A raced-out conversion may still commit, so re-sending it double-counts an
  // append-only event — the exact hazard RETRYABLE_CRITICAL_EVENT_STATUSES
  // already excludes 500/502/503/504 for.
  it('classifies a raced-out write distinctly from an honored abort', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const originalNow = Date.now;
    let now = 1_000;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const lifecycle = stubPageLifecycle('visible');
    Date.now = () => now;
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    // This object is the SAME one that rides into Sentry as `extra`, so
    // capturing the console warning is how the reporting payload is observed
    // without standing up the deferred Sentry queue and a stub SDK.
    const diagnostics: Array<Record<string, unknown>> = [];
    console.warn = (...args: unknown[]) => {
      const detail = args[1];
      if (detail && typeof detail === 'object') diagnostics.push(detail as Record<string, unknown>);
    };
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline');
      now = 26_000;
      latchDeadline.callback();

      const error = await parked.then(() => null, (reason: unknown) => reason);
      assert.deepEqual(
        collectorFailureFromError(error),
        { kind: 'timeout', raced: true },
        'the latch was released while the request was still outstanding, and the failure must say so',
      );

      await drainPromiseHandlers(() => diagnostics.length > 0, 'the failure is reported');
      assert.equal(
        diagnostics[0]?.raced,
        true,
        'the reporting payload must carry the marker — an operator triaging a timeout '
        + 'needs to know whether the request is still on the wire',
      );
      assert.equal(diagnostics[0]?.failureKind, 'timeout', 'and it stays a timeout, not a new kind');
      assert.equal(
        diagnostics[0]?.visibilityAtSend,
        'visible',
        'a foreground send is the remaining parked-wrapper population after #6968 holds hidden tabs',
      );
      assert.equal(
        diagnostics[0]?.elapsedAtDeadlineMs,
        25_000,
        'the payload must say how long the browser left the request unsettled',
      );
      assert.equal(
        diagnostics[0]?.racedCount,
        1,
        'WORLDMONITOR-ZF must be judged against this page\'s write count, not as a raw daily total',
      );
      assert.equal(diagnostics[0]?.writeCount, 1);
      assert.equal(diagnostics[0]?.racedRate, 1);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // #6968: WebKit freezes an in-flight fetch when the tab is backgrounded. The
  // previous visibilitychange→hidden path treated a tab switch as unload and
  // flushed the backlog into that freeze; 20s later the latch marked every
  // write `raced` and closed both recovery doors. Holding until the tab is
  // visible again (and only flushing on actual pagehide) is what removes the
  // 71% Apple skew without sendBeacon's receiptless conversion hole.
  it('holds serialized writes while the tab is hidden and drains them when it returns', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('hidden');
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const held = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'a hidden tab must not start a fetch WebKit will freeze');
      assert.equal(
        fakeTimers.timers.filter((timer) => timer.delay === LATCH_DEADLINE_MS && !timer.cancelled).length,
        0,
        'holding must not arm a latch against a write that has not been dispatched',
      );

      lifecycle.fireVisibilityChange();
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'duplicate hidden visibilitychange must not dispatch');

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      await drainPromiseHandlers(() => calls === 1, 'becoming visible drains the held write');
      assert.equal((await held).status, 200);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('still flushes a hidden backlog on pagehide so keepalive can finish the navigation', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('hidden');
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const flushed = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'hidden drain stays parked until unload');

      lifecycle.firePageHide();
      await drainPromiseHandlers(() => calls === 1, 'pagehide dispatches the held backlog');
      assert.equal((await flushed).status, 200);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('keeps a persisted pagehide in bfcache hold and drains on pageshow', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('hidden');
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const held = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'hidden drain stays parked');

      lifecycle.firePageHide(true);
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'bfcache pagehide must not flush into a freeze');

      lifecycle.setVisibility('visible');
      lifecycle.firePageShow();
      await drainPromiseHandlers(() => calls === 1, 'pageshow must resync the page-active cache');
      assert.equal((await held).status, 200);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('does not drain on pageshow while the document is still hidden', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('hidden');
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const held = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      lifecycle.firePageHide(true);
      lifecycle.firePageShow();
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'pageshow must not drain while visibilityState is still hidden');

      lifecycle.setVisibility('visible');
      lifecycle.firePageShow();
      await drainPromiseHandlers(() => calls === 1, 'a later visible pageshow drains');
      assert.equal((await held).status, 200);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('holds serialized writes while the document is prerendered', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('prerender');
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(true, 200, RECEIPT_BODY));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const held = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 0, 'prerender drain stays parked');
      assert.equal(
        findLatchDeadline(fakeTimers.timers),
        undefined,
        'holding must not arm a latch against a write that has not been dispatched',
      );

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      await drainPromiseHandlers(() => calls === 1, 'leaving prerender drains the held write');
      assert.equal((await held).status, 200);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('pauses an in-flight latch while hidden and resumes it when the tab is visible again', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('visible');
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const armed = findLatchDeadline(fakeTimers.timers);
      assert.ok(armed, 'a visible send still owns a latch');

      lifecycle.setVisibility('hidden');
      lifecycle.fireVisibilityChange();
      assert.equal(armed.cancelled, true, 'backgrounding must not race-out a frozen WebKit fetch');

      armed.callback();
      await drainPromiseHandlers();
      let settled = false;
      void parked.then(() => { settled = true; }, () => { settled = true; });
      await drainPromiseHandlers();
      assert.equal(settled, false, 'firing the paused timer is a no-op');

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      // Date.now is not faked, so remainingMs after an immediate pause is
      // slightly under LATCH_DEADLINE_MS. Pin the upper bound and keep the
      // floor so a missing re-arm cannot pass as some other long timer.
      const resumed = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer !== armed
          && timer.delay <= LATCH_DEADLINE_MS && timer.delay > 20_000,
      );
      assert.ok(resumed, 'becoming visible re-arms the remaining latch');
      resumed.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('pauses an in-flight latch on a persisted pagehide without a prior visibilitychange', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('visible');
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const armed = findLatchDeadline(fakeTimers.timers);
      assert.ok(armed, 'a visible send still owns a latch');

      lifecycle.setVisibility('hidden');
      lifecycle.firePageHide(true);
      assert.equal(armed.cancelled, true, 'bfcache pagehide must pause the in-flight latch');

      armed.callback();
      await drainPromiseHandlers();
      let settled = false;
      void parked.then(() => { settled = true; }, () => { settled = true; });
      await drainPromiseHandlers();
      assert.equal(settled, false, 'firing the paused timer is a no-op');

      lifecycle.setVisibility('visible');
      lifecycle.firePageShow();
      const resumed = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer !== armed
          && timer.delay <= LATCH_DEADLINE_MS && timer.delay > 20_000,
      );
      assert.ok(resumed, 'pageshow after bfcache must re-arm the remaining latch');
      resumed.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('re-arms a paused in-flight latch when a real pagehide flushes', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('visible');
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const armed = findLatchDeadline(fakeTimers.timers);
      assert.ok(armed, 'a visible send still owns a latch');

      lifecycle.setVisibility('hidden');
      lifecycle.fireVisibilityChange();
      assert.equal(armed.cancelled, true);

      lifecycle.firePageHide(false);
      const resumed = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer !== armed
          && timer.delay <= LATCH_DEADLINE_MS && timer.delay > 20_000,
      );
      assert.ok(resumed, 'real pagehide must resume the paused in-flight latch');
      resumed.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('gives an exhausted hidden latch a settle-grace when the tab returns', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('visible');
    const savedNow = Date.now;
    let now = savedNow();
    Date.now = () => now;
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const armed = findLatchDeadline(fakeTimers.timers);
      assert.ok(armed, 'a visible send still owns a latch');

      now += LATCH_DEADLINE_MS - 100;
      lifecycle.setVisibility('hidden');
      lifecycle.fireVisibilityChange();
      assert.equal(armed.cancelled, true);

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      // Remaining is a near-zero sliver (< LATCH_RELEASE_GRACE_MS), so resume
      // re-arms with the 5s settle-grace. The request-side abort timer is
      // still armed at 20s; do not pick the first leftover timer.
      const resumed = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer.delay === LATCH_RELEASE_GRACE_MS,
      );
      assert.ok(resumed, 'returning visible must re-arm a near-zero remaining latch with settle grace');
      resumed.callback();
      const error = await parked.then(
        () => { throw new Error('expected raced timeout'); },
        (reason: unknown) => reason,
      );
      assert.deepEqual(collectorFailureFromError(error), { kind: 'timeout', raced: true });
    } finally {
      Date.now = savedNow;
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('grants settle-grace only once across repeated hide and show cycles', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const lifecycle = stubPageLifecycle('visible');
    const savedNow = Date.now;
    let now = savedNow();
    const remainingForegroundMs = 1_000;
    Date.now = () => now;
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const armed = findLatchDeadline(fakeTimers.timers);
      assert.ok(armed, 'a visible send still owns a latch');

      now += LATCH_DEADLINE_MS - remainingForegroundMs;
      lifecycle.setVisibility('hidden');
      lifecycle.fireVisibilityChange();
      assert.equal(armed.cancelled, true);

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      const firstGrace = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer.delay === LATCH_RELEASE_GRACE_MS,
      );
      assert.ok(firstGrace, 'the first return grants settle-grace to the unfreezing transport');

      now += LATCH_RELEASE_GRACE_MS - remainingForegroundMs;
      lifecycle.setVisibility('hidden');
      lifecycle.fireVisibilityChange();
      assert.equal(firstGrace.cancelled, true);

      lifecycle.setVisibility('visible');
      lifecycle.fireVisibilityChange();
      const secondResume = fakeTimers.timers.find(
        (timer) => !timer.cancelled && timer !== firstGrace && timer.delay === remainingForegroundMs,
      );
      assert.ok(secondResume, 'later returns consume the real remaining foreground budget');
      secondResume.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });
    } finally {
      Date.now = savedNow;
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('reports hidden visibility and the write-count rate on a pagehide flush that still races', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    const diagnostics: Array<Record<string, unknown>> = [];
    console.warn = (...args: unknown[]) => {
      const detail = args[1];
      if (detail && typeof detail === 'object') diagnostics.push(detail as Record<string, unknown>);
    };
    const lifecycle = stubPageLifecycle('hidden');
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const flushed = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void flushed.catch(() => {});
      await drainPromiseHandlers();
      lifecycle.firePageHide();
      await drainPromiseHandlers();
      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'an unload flush is still bounded');
      latchDeadline.callback();
      await assert.rejects(flushed, { name: 'TimeoutError' });
      await drainPromiseHandlers(() => diagnostics.length > 0, 'the raced unload flush is reported');
      assert.equal(diagnostics[0]?.visibilityAtSend, 'hidden');
      assert.equal(diagnostics[0]?.visibilityAtDeadline, 'hidden');
      assert.equal(diagnostics[0]?.raced, true);
      assert.equal(diagnostics[0]?.racedCount, 1);
      assert.equal(diagnostics[0]?.writeCount, 1);
      assert.equal(diagnostics[0]?.racedRate, 1);
      assert.equal(getCollectorHealthForTesting().raced, 1);
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      lifecycle.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // `fetch` resolves the moment response HEADERS arrive; the body is a separate
  // stream that `inspectCollectorResponse` reads with `response.text()`. Racing
  // only the headers leaves the wedge intact one line later — the queue parks on
  // the body read instead, with the same symptom and the same cause. This is the
  // shape a wrapper produces when it proxies headers through but stalls or never
  // closes the body stream.
  it('releases the queue when the transport answers headers and then stalls the body', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    let calls = 0;
    // 200 with a receipt-shaped status, but `text()` never settles.
    const headersThenStall = {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: () => new Promise<string>(() => {}),
      clone: () => headersThenStall,
    } as unknown as Response;
    window.fetch = (() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(headersThenStall)
        : Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const stalledBody = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void stalledBody.catch(() => {});
      const queued = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'the second write waits behind the stalled body read');

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the deadline must still be live across the body read');
      latchDeadline.callback();

      await drainPromiseHandlers(() => calls === 2, 'the queued write reaches the network');
      assert.equal((await queued).status, 200, 'a stalled body must not wedge the queue');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // The `raced` doc comment's premise is that the abandoned request is still on
  // the wire and "may yet commit" — so it CAN settle after losing the race. The
  // queue has moved on by then, and nothing may re-resolve the settled deferred,
  // double-count the health window, or leak an unhandled rejection.
  it('ignores a transport that settles after losing the race', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => { leaked.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let settleLate: ((response: Response) => void) | undefined;
    let failLate: ((error: unknown) => void) | undefined;
    let calls = 0;
    // #6708: the fetch stub must return a SECOND deferred on calls === 2,
    // so the late-rejection half below drives a request that was genuinely
    // abandoned by the latch deadline while still outstanding. The old stub
    // returned a resolved promise on calls >= 2, so `failLate` was a no-op
    // on the already-settled first deferred — rejecting a resolved promise
    // does nothing, and the assertion was structurally true for any code.
    let failSecond: ((error: unknown) => void) | undefined;
    window.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((resolve, reject) => { settleLate = resolve; failLate = reject; });
      }
      if (calls === 2) {
        return new Promise<Response>((_resolve, reject) => { failSecond = reject; });
      }
      return Promise.resolve(collectorResponse(true, 200));
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const abandoned = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void abandoned.catch(() => {});
      await drainPromiseHandlers();

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline');
      latchDeadline.callback();
      await assert.rejects(abandoned, { name: 'TimeoutError' });

      const afterRace = getCollectorHealthForTesting().writes;

      // The abandoned request now completes, exactly as a live request would.
      settleLate?.(collectorResponse(true, 200));
      await drainPromiseHandlers();
      assert.equal(
        getCollectorHealthForTesting().writes,
        afterRace,
        'a late success must not be counted a second time',
      );

      // And the other shape: a late REJECTION must not escape as an unhandled
      // rejection just because the race already settled (#6708). The second
      // write gets its own deferred (see the stub above), is abandoned by
      // the latch deadline while still outstanding, and only THEN rejects.
      const secondAbandoned = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void secondAbandoned.catch(() => {});
      await drainPromiseHandlers();

      // Drive the second write's latch deadline so the request is genuinely
      // raced out before the rejection lands.
      const secondLatchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(secondLatchDeadline, 'the second write must also own a latch deadline');
      secondLatchDeadline.callback();
      await assert.rejects(secondAbandoned, { name: 'TimeoutError' });
      await drainPromiseHandlers();

      // Now the abandoned request rejects — this is the production shape.
      failSecond?.(new TypeError('Failed to fetch'));
      await drainPromiseHandlers();
      await new Promise((resolve) => globalThis.queueMicrotask(() => resolve(null)));

      assert.ok(failSecond !== undefined, 'the second deferred was driven, not a resolved stub');
      assert.deepEqual(leaked, [], `late settlement leaked: ${leaked.map(String).join(', ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // The whole point of #6288 is that the parked-transport incident is currently
  // invisible. Fixing the queue REMOVES its only outward symptom (queue-overflow),
  // so if the raced timeout inherits the ordinary environment-noise gating the
  // population goes dark: the module abandons ~2 writes per 60s window against a
  // 5-write floor, and the aggregate-first path only reports to Sentry when the
  // aggregate DECLINES.
  it('alerts on a raced timeout despite the environment-noise floors', () => {
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'timeout' }, { writes: 2, failures: 2 }),
      false,
      'baseline: an ordinary timeout below the sample floor stays silent',
    );
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'timeout', raced: true }, { writes: 2, failures: 2 }),
      true,
      'a raced timeout can never clear a 5-write floor at one abandoned write per ~25s',
    );
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'timeout', raced: true }, { writes: 1, failures: 1, noiseReported: true }),
      true,
      'and an earlier blocked request in the same window must not latch it silent',
    );
  });

  it('reports a raced timeout to Sentry even when the aggregate accepts the report', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const reports: unknown[] = [];
    // `true` = the cross-user aggregate accepted it. On the ordinary
    // environment-noise path that RETURNS before Sentry, which is exactly how a
    // healthy aggregate would hide this incident.
    _setCollectorHealthReporterForTesting(async (report) => { reports.push(report); return true; });
    window.fetch = (() => parkForever()) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline');
      latchDeadline.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });
      await drainPromiseHandlers();

      assert.equal(reports.length, 1, 'the raced write still feeds the cross-user aggregate');
      assert.equal(
        getCollectorHealthForTesting().reportedFailureSignatures,
        1,
        'and it emits its own Sentry event rather than deferring to the aggregate verdict',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // The cohort's once-per-window noise latch is checked BEFORE the per-signature
  // dedup, so an ordinary blocked request earlier in the same window would
  // otherwise return first and suppress the raced report — leaving the signature
  // split inert for the one failure it exists for. A fresh-window test cannot
  // see this: the latch is only load-bearing once something else has tripped it.
  it('still reports a raced timeout after an ordinary blocked request latched the window', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    // The aggregate declines, so the per-page Sentry fallback is the live path.
    _setCollectorHealthReporterForTesting(async () => false);
    // ENVIRONMENT_NOISE_MIN_WRITES — the sample floor an ad-blocker baseline
    // must cross before it is allowed to report even once.
    const noiseFloor = 5;
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return calls <= noiseFloor
        ? Promise.reject(new TypeError('Failed to fetch'))
        : parkForever();
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      for (let index = 0; index < noiseFloor; index += 1) {
        await window.fetch(UMAMI_SEND_URL, collectorEventInit()).catch(() => {});
      }
      await drainPromiseHandlers(
        () => getCollectorHealthForTesting().cohorts.event.noiseReported,
        'the ordinary blocked requests trip the once-per-window noise latch',
      );
      const afterNoise = getCollectorHealthForTesting().reportedFailureSignatures;
      assert.equal(afterNoise, 1, 'the ad-blocker baseline reported exactly once');

      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline');
      latchDeadline.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });

      await drainPromiseHandlers(
        () => getCollectorHealthForTesting().reportedFailureSignatures > afterNoise,
        'the raced timeout reports despite the already-latched window',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // `flushCollectorQueueForUnload` dispatches the WHOLE backlog at once, outside
  // the single-slot serialization, so those writes never pass through the latch
  // that the deadline normally guards. visibilitychange no longer flushes — a
  // tab switch that comes back is held instead (#6968) — but pagehide still
  // does, including bfcache, so an unbounded flushed write would hang forever
  // on a live page, holding whatever the wrapper retains.
  it('bounds every write the unload flush dispatches, not just the queued one', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    const windowRecord = globalThis.window as Record<string, unknown>;
    const savedAdd = windowRecord.addEventListener;
    const savedRemove = windowRecord.removeEventListener;
    const listeners: Record<string, Array<() => void>> = {};
    windowRecord.addEventListener = (type: string, handler: () => void) => {
      (listeners[type] ??= []).push(handler);
    };
    windowRecord.removeEventListener = () => {};
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return parkForever();
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      const inFlight = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      const queuedA = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      const queuedB = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      for (const pending of [inFlight, queuedA, queuedB]) void pending.catch(() => {});
      await drainPromiseHandlers();
      assert.equal(calls, 1, 'only the in-flight write reached the transport');

      assert.ok((listeners.pagehide ?? []).length > 0, 'the gate registered a pagehide flush');
      for (const handler of listeners.pagehide ?? []) handler();
      await drainPromiseHandlers(() => calls === 3, 'the flush dispatches the whole backlog');

      const live = fakeTimers.timers.filter(
        (timer) => timer.delay === LATCH_DEADLINE_MS && !timer.cancelled,
      );
      assert.equal(live.length, 3, 'every flushed write carries its own latch deadline');

      for (const timer of live) timer.callback();
      await assert.rejects(inFlight, { name: 'TimeoutError' });
      await assert.rejects(queuedA, { name: 'TimeoutError' });
      await assert.rejects(queuedB, { name: 'TimeoutError' });
      assert.ok(
        fakeTimers.timers.every((timer) => timer.cancelled),
        'and each one cleans up its timers rather than dangling past navigation',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      windowRecord.addEventListener = savedAdd;
      windowRecord.removeEventListener = savedRemove;
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // sendCollectorHealthReport races its own deadline for the same reason the
  // collector write does — the same fetch wrappers sit in front of this POST.
  // The existing #6086 test only proves a signal is ATTACHED and lets the stub
  // resolve immediately, so nothing exercised the case the race exists for: an
  // aggregate endpoint that never answers. Without the race the reporting
  // promise stays pending forever and the Sentry fallback that reads its result
  // is stranded — a silent loss of the alert, not a visible failure.
  it('bounds the health-report POST when the aggregate endpoint discards its signal', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const originalGlobalFetch = globalThis.fetch;
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    // COLLECTOR_HEALTH_REPORT_TIMEOUT_MS (2s) + LATCH_RELEASE_GRACE_MS (5s).
    const healthDeadlineMs = 7_000;
    const noiseFloor = 5;
    let healthCalls = 0;
    const stub = ((input: RequestInfo | URL) => {
      if (String(input).includes('/api/analytics-health')) {
        healthCalls += 1;
        return parkForever();
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as typeof window.fetch;
    // sendCollectorHealthReport dispatches through globalThis.fetch, a DIFFERENT
    // binding from window.fetch here — stubbing only one misses the POST.
    window.fetch = stub;
    globalThis.fetch = stub;
    installCollectorFetchGate();

    try {
      for (let index = 0; index < noiseFloor; index += 1) {
        await window.fetch(UMAMI_SEND_URL, collectorEventInit()).catch(() => {});
      }
      await drainPromiseHandlers(() => healthCalls > 0, 'the aggregate report is attempted');
      assert.equal(
        getCollectorHealthForTesting().reportedFailureSignatures,
        0,
        'the fallback correctly defers while the aggregate has not answered',
      );

      const healthDeadlines = fakeTimers.timers.filter(
        (timer) => timer.delay === healthDeadlineMs && !timer.cancelled,
      );
      assert.ok(healthDeadlines.length > 0, 'the health POST must own a latch deadline of its own');
      for (const timer of healthDeadlines) timer.callback();

      await drainPromiseHandlers(
        () => getCollectorHealthForTesting().reportedFailureSignatures > 0,
        'an unanswered aggregate falls back to Sentry instead of hanging forever',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      globalThis.fetch = originalGlobalFetch;
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  // A parked transport and an honored abort produce the SAME `kind` and the SAME
  // `status`, so the per-window signature dedup would collapse them into one
  // entry and let whichever landed first silence the other. The `raced` segment
  // in collectorFailureSignature is what keeps them apart — and only a fixture
  // where the two failures differ in NOTHING ELSE can prove it. (The blocked-then-
  // raced test above differs in `kind` as well, so it passes either way.)
  it('keeps a raced timeout from deduping against an honored-abort timeout in one window', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    // Aggregate declines, so the honored-abort timeout reaches the Sentry
    // fallback and lands a signature of its own.
    _setCollectorHealthReporterForTesting(async () => false);
    const noiseFloor = 5;
    let calls = 0;
    window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return calls <= noiseFloor ? rejectWhenAborted(init?.signal) : parkForever();
    }) as typeof window.fetch;
    installCollectorFetchGate();

    try {
      // A cooperative transport that honors every abort: `timeout`, NOT raced.
      for (let index = 0; index < noiseFloor; index += 1) {
        const write = window.fetch(UMAMI_SEND_URL, collectorEventInit());
        void write.catch(() => {});
        await drainPromiseHandlers(() => calls === index + 1, `write ${index + 1} dispatches`);
        const requestBound = fakeTimers.timers.find(
          (timer) => timer.delay === 20_000 && !timer.cancelled,
        );
        assert.ok(requestBound, `write ${index + 1} must carry a request bound`);
        requestBound.callback();
        await assert.rejects(write, { name: 'TimeoutError' });
      }
      await drainPromiseHandlers(
        () => getCollectorHealthForTesting().reportedFailureSignatures === 1,
        'the honored-abort timeout reports once for the window',
      );

      // Same kind, same status — only `raced` differs.
      const parked = window.fetch(UMAMI_SEND_URL, collectorEventInit());
      void parked.catch(() => {});
      await drainPromiseHandlers();
      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the parked write must own a latch deadline');
      latchDeadline.callback();
      await assert.rejects(parked, { name: 'TimeoutError' });

      await drainPromiseHandlers(
        () => getCollectorHealthForTesting().reportedFailureSignatures === 2,
        'the raced timeout must not dedupe against the honored one',
      );
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('refuses to re-send a raced-out conversion but still replays a raced-out identity snapshot', () => {
    assert.equal(
      isRetryableCollectorFailure({ kind: 'timeout' }),
      true,
      'baseline: an honored abort left no row behind and stays retryable',
    );
    assert.equal(
      isRetryableCollectorFailure({ kind: 'timeout', raced: true }),
      false,
      'the raced request is still in flight and may commit; re-sending it double-counts the conversion',
    );
    assert.equal(
      isRetryableIdentityFailure({ kind: 'timeout', raced: true }),
      true,
      'an identity snapshot is an idempotent overwrite, so a duplicate is harmless — this is the idempotency half of the caveat',
    );
  });

  // The in-page retry is only ONE of the two doors that can re-send a
  // conversion. `replayPendingCheckoutSuccess` re-sends it on the next boot from
  // the durable marker, and that path keys off `kind === 'http'` — under which a
  // raced `timeout` would keep the marker armed and smuggle back exactly the
  // duplicate isRetryableCollectorFailure just declined to risk.
  it('clears the durable marker on a raced-out conversion so the next boot cannot duplicate', { timeout: 10_000 }, async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const fakeTimers = installFakeTimers();
    const originalWarn = console.warn;
    console.warn = () => {};
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return parkForever();
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };
    const storage = new Map<string, string>();
    (globalThis.window as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    try {
      const analytics = await import('../src/services/analytics.ts');
      analytics.trackCheckoutSuccess('url-return');
      await drainPromiseHandlers(() => calls === 1, 'the conversion is dispatched');
      assert.equal(storage.get('wm-checkout-success-pending'), 'url-return', 'the marker arms before delivery');

      const latchDeadline = findLatchDeadline(fakeTimers.timers);
      assert.ok(latchDeadline, 'the module must own a latch deadline');
      latchDeadline.callback();
      await drainPromiseHandlers(
        () => !storage.has('wm-checkout-success-pending'),
        'the durable marker resolves',
      );

      assert.equal(
        fakeTimers.timers.filter((timer) => timer.delay === 1_000).length,
        0,
        'a raced-out conversion must not schedule an in-page retry',
      );
      assert.equal(calls, 1, 'nothing re-sends the conversion');
    } finally {
      console.warn = originalWarn;
      fakeTimers.restore();
      delete (globalThis.window as WinWithUmami).umami;
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });
});

/**
 * A bot-filtered write is a REAL delivery failure — Umami stored nothing — but
 * it is not an incident. It is the collector doing its job on traffic we do not
 * want counted. The distinction has to live in the alerting decision, never in
 * the delivery classification, or a suppressed alert silently becomes a
 * suppressed retry and a cleared conversion marker.
 */
describe('bot-filtered collector writes (#5964 alert-noise regression)', { concurrency: false }, () => {
  const botBody = '{"beep":"boop"}';

  it('flags a bot-filtered 200 without changing its delivery classification', async () => {
    const failure = await inspectCollectorResponse(collectorResponse(true, 200, botBody));
    assert.equal(failure?.kind, 'missing-receipt', 'the write really was dropped');
    assert.equal(failure?.status, 200);
    assert.equal(failure?.botFiltered, true);
  });

  it('does not flag a genuine receipt or an ordinary receiptless 200', async () => {
    assert.equal(await inspectCollectorResponse(collectorResponse(true, 200, RECEIPT_BODY)), null);

    const odd = await inspectCollectorResponse(collectorResponse(true, 200, '{"cache":"only"}'));
    assert.equal(odd?.kind, 'missing-receipt');
    assert.ok(!odd?.botFiltered, 'a non-sentinel receiptless 200 is still unexplained and must stay reportable');
  });

  it('leaves retry and durable-marker policy identical to a plain missing receipt', async () => {
    const bot = (await inspectCollectorResponse(collectorResponse(true, 200, botBody)))!;
    const plain = (await inspectCollectorResponse(collectorResponse(true, 200, '{}')))!;

    // Both must stay non-retryable (a retry is filtered identically) and both
    // must stay kind:'missing-receipt' so isDurableMarkerResolved keeps the
    // conversion marker armed for replay. Diverging here would turn an alerting
    // change into a conversion-accounting change.
    assert.equal(isRetryableCollectorFailure(bot), isRetryableCollectorFailure(plain));
    assert.equal(isRetryableIdentityFailure(bot), isRetryableIdentityFailure(plain));
    assert.equal(isRetryableCollectorFailure(bot), false);
    assert.equal(bot.kind, plain.kind);
  });

  it('never alerts on a bot-filtered write, at any failure rate', () => {
    const bot = { kind: 'missing-receipt' as const, status: 200, botFiltered: true };
    assert.equal(isAlertWorthyCollectorFailure(bot, { writes: 1, failures: 1 }), false);
    assert.equal(isAlertWorthyCollectorFailure(bot, { writes: 500, failures: 500 }), false);
  });

  it('gates an unexplained receiptless 200 behind the aggregate floors', () => {
    // 2026-08-01 (WORLDMONITOR-Y3): receiptless-200 reports arrived at ~16/hour
    // from diverse real browsers while the Umami DB was ingesting 15-23k
    // events/hour and every probe shape returned a full receipt. From inside
    // one page, privacy middleware faking a 200 — or a body that cannot be
    // read — is indistinguishable from a discarding collector: the same
    // epistemics as a blocked request, so it gets the same aggregate gate.
    const plain = { kind: 'missing-receipt' as const, status: 200 };
    assert.equal(isAlertWorthyCollectorFailure(plain, { writes: 1, failures: 1 }), false);
    assert.equal(isAlertWorthyCollectorFailure(plain, { writes: 100, failures: 20 }), false);
    assert.equal(isAlertWorthyCollectorFailure(plain, { writes: 5, failures: 5 }), true);
    assert.equal(
      isAlertWorthyCollectorFailure(plain, { writes: 5, failures: 5, noiseReported: true }),
      false,
      'shares the once-per-window cap with the other environment kinds',
    );
  });
});

describe('collector alert policy suppresses expected background conditions', { concurrency: false }, () => {
  const net = { kind: 'network' as const };
  const timeout = { kind: 'timeout' as const };

  it('stays silent for a lone blocked request — the ad-blocker baseline', () => {
    // The overwhelmingly common shape: a page issues one or two writes and an
    // extension blocks them. Nothing here indicates a collector problem.
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 1, failures: 1 }), false);
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 4, failures: 4 }), false);
    assert.equal(isAlertWorthyCollectorFailure(timeout, { writes: 3, failures: 3 }), false);
  });

  it('reports once the window carries a real sample AND a real failure rate', () => {
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 5, failures: 5 }), true);
    assert.equal(isAlertWorthyCollectorFailure(timeout, { writes: 20, failures: 20 }), true);
  });

  it('stays silent when a big sample is mostly succeeding', () => {
    // A collector that answers 80% of writes is not down; one flaky beacon in a
    // healthy window must not page.
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 100, failures: 20 }), false);
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 10, failures: 4 }), false);
    assert.equal(isAlertWorthyCollectorFailure(net, { writes: 10, failures: 5 }), true);
  });

  it('caps environment noise at one event per window', () => {
    const saturated = { writes: 50, failures: 50 };
    assert.equal(isAlertWorthyCollectorFailure(net, saturated), true);
    assert.equal(
      isAlertWorthyCollectorFailure(net, { ...saturated, noiseReported: true }),
      false,
      'a single ad-blocked page must not out-produce the outage it mimics',
    );
  });

  it('always reports failures that are actionable, whatever the window', () => {
    // These are never the client's environment: the origin answered non-2xx, or
    // our own bounded queue dropped a write. One occurrence is worth knowing.
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'http', status: 500 }, { writes: 1, failures: 1 }),
      true,
    );
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'queue-overflow' }, { writes: 1, failures: 1 }),
      true,
    );
    // ...and the cap never applies to them.
    assert.equal(
      isAlertWorthyCollectorFailure({ kind: 'http', status: 400 }, { writes: 50, failures: 50, noiseReported: true }),
      true,
    );
  });

  it('reports the known umami#4183 session_data race until the server is upgraded', () => {
    assert.equal(
      isAlertWorthyCollectorFailure(
        { kind: 'http', status: 500, prismaCode: 'P2002', constraint: 'session_data_pkey' },
        { writes: 1, failures: 1 },
      ),
      true,
    );
  });
});

describe('collector alert policy is wired into the reporting path', { concurrency: false }, () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    delete (globalThis.window as WinWithUmami).umami;
  });

  it('sends low-volume environment failures to the cross-user aggregate', async () => {
    const reports: unknown[] = [];
    _setCollectorHealthReporterForTesting(async (report) => {
      reports.push(report);
      return true;
    });
    window.fetch = (() => Promise.resolve(collectorResponse(true, 200, '{}'))) as typeof window.fetch;
    stubFailingUmami();

    for (let i = 0; i < 4; i += 1) {
      track('panel-open' as Parameters<typeof track>[0], { i });
      await drainPromiseHandlers();
    }

    assert.equal(reports.length, 4, 'every environment failure contributes its delta before the local floor');
    assert.deepEqual(reports[0], {
      cohort: 'event',
      writes: 1,
      failures: 1,
      failureKind: 'missing-receipt',
      bucket: Math.floor(Date.now() / 60_000),
    });
    assert.equal(
      getCollectorHealthForTesting().noiseReported,
      false,
      'an accepted aggregate report does not duplicate the server-side Sentry event locally',
    );
  });

  it('reports a completed zero-failure window so the baseline is not failure-conditioned', async () => {
    const reports: unknown[] = [];
    _setCollectorHealthReporterForTesting(async (report) => {
      reports.push(report);
      return true;
    });
    const originalDateNow = Date.now;
    window.fetch = (() => Promise.resolve(collectorResponse(true, 200))) as typeof window.fetch;
    stubFailingUmami();

    try {
      Date.now = () => 1_000;
      track('panel-open' as Parameters<typeof track>[0], { first: true });
      await drainPromiseHandlers();

      Date.now = () => 62_000;
      track('panel-open' as Parameters<typeof track>[0], { second: true });
      await drainPromiseHandlers();
    } finally {
      Date.now = originalDateNow;
    }

    assert.deepEqual(reports, [{
      cohort: 'event',
      writes: 1,
      failures: 0,
      failureKind: 'none',
      bucket: 0,
    }]);
  });

  // Deliberately does NOT stub the reporter: resetAnalyticsForTesting restores the
  // real sendCollectorHealthReport, so this exercises the actual POST. Without a
  // deadline here a hung /api/analytics-health leaves the reporting promise pending
  // forever — the same unbounded-fetch defect this PR fixes for collector writes.
  it('binds a deadline on the health-report POST when AbortSignal.timeout is unavailable', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const originalGlobalFetch = globalThis.fetch;
    const healthInits: (RequestInit | undefined)[] = [];
    // Fake timers are what make the `finally { bound?.cleanup(); }` in
    // sendCollectorHealthReport observable. Asserting only that a signal was
    // attached leaves that finally untested: the stub resolves immediately, the
    // real 2s timer is simply left dangling, and deleting the cleanup ships green.
    const fakeTimers = installFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    const stub = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/analytics-health')) {
        healthInits.push(init);
        return Promise.resolve(collectorResponse(true, 200, '{}'));
      }
      return Promise.resolve(collectorResponse(true, 200, '{}'));
    }) as typeof window.fetch;
    // sendCollectorHealthReport dispatches through globalThis.fetch, which is a
    // DIFFERENT binding from window.fetch in this environment — stubbing only
    // window.fetch silently misses the health POST entirely.
    window.fetch = stub;
    globalThis.fetch = stub;
    stubFailingUmami();

    try {
      track('panel-open' as Parameters<typeof track>[0], {});
      await drainPromiseHandlers();

      assert.equal(healthInits.length, 1, 'the environment failure must reach the aggregate endpoint');
      assert.ok(
        healthInits[0]?.signal instanceof AbortSignal,
        'the health report must carry a deadline even without AbortSignal.timeout',
      );

      const healthDeadline = fakeTimers.timers.find((timer) => timer.delay === 2_000);
      assert.ok(healthDeadline, 'the health report must schedule its own 2s deadline, not the collector 20s one');
      assert.ok(healthDeadline.cancelled, 'the health report timer is cleared once the POST settles');
    } finally {
      fakeTimers.restore();
      globalThis.fetch = originalGlobalFetch;
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
    }
  });

  it('keeps critical-event health separate from successful ordinary writes', async () => {
    const reports: unknown[] = [];
    _setCollectorHealthReporterForTesting(async (report) => {
      reports.push(report);
      return true;
    });
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(calls <= 10 ? collectorResponse(true, 200) : collectorResponse(true, 200, '{}'));
    }) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    for (let i = 0; i < 10; i += 1) {
      track('panel-open' as Parameters<typeof track>[0], { i });
      await drainPromiseHandlers();
    }
    track('checkout-success');
    await drainPromiseHandlers();

    assert.deepEqual(reports.at(-1), {
      cohort: 'critical-event',
      writes: 1,
      failures: 1,
      failureKind: 'missing-receipt',
      bucket: Math.floor(Date.now() / 60_000),
    });
  });

  it('flips the once-per-window latch only after the sample floor is crossed', async () => {
    // Drives REAL writes through the gate so this proves recordCollectorOutcome
    // consults the predicate — a policy unit test alone would pass even if the
    // reporting path ignored it entirely.
    _setCollectorHealthReporterForTesting(async () => false);
    window.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof window.fetch;
    stubFailingUmami();

    // 'panel-open' is not a CRITICAL_TRACK_EVENT, so a network failure does not
    // schedule a retry and each call is exactly one write.
    const fire = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        track('panel-open' as Parameters<typeof track>[0], { i });
        await drainPromiseHandlers();
      }
    };

    await fire(4);
    const below = getCollectorHealthForTesting();
    assert.equal(below.writes, 4);
    assert.equal(below.failures, 4);
    assert.equal(below.noiseReported, false, 'four blocked beacons must not alert');

    await fire(1);
    assert.equal(getCollectorHealthForTesting().noiseReported, true, 'the fifth crosses the floor');
    assert.equal(getCollectorHealthForTesting().reportedFailureSignatures, 1, 'the window emits one event per signature');

    await fire(10);
    const after = getCollectorHealthForTesting();
    assert.equal(after.writes, 15, 'writes keep accruing');
    assert.equal(after.noiseReported, true, 'the latch stays set — no second event this window');
    assert.equal(after.reportedFailureSignatures, 1, 'repeated failures stay latched');
  });
});

/**
 * An alarm has to be attacked for the case it exists to catch: can it stay
 * SILENT while the collector is actually dead? #5565 ran for four days unseen.
 */
describe('collector alert policy still fires when the collector is dead', { concurrency: false }, () => {
  it('alerts on the first 5xx, with no sample or rate floor to clear', () => {
    // The #5565 shape: Railway origin OOM-dead, Cloudflare answers 502. This is
    // kind:'http', so it is never subject to the environment-noise gating.
    for (const status of [500, 502, 503, 504]) {
      assert.equal(
        isAlertWorthyCollectorFailure({ kind: 'http', status }, { writes: 1, failures: 1 }),
        true,
        `HTTP ${status} must alert immediately`,
      );
    }
  });

  it('alerts on a sustained total network failure once the floor is crossed', () => {
    assert.equal(isAlertWorthyCollectorFailure({ kind: 'network' }, { writes: 5, failures: 5 }), true);
  });

  it('alerts on a collector that discards every write once the floor is crossed', () => {
    // The other way an outage can look green: Umami up and answering 200 but
    // storing nothing (a deleted website row, an isbot update swallowing real
    // browsers). Each affected page crosses the floor and reports once per
    // window, so the cross-user step change stays visible in the aggregate.
    const plain = { kind: 'missing-receipt' as const, status: 200 };
    assert.equal(isAlertWorthyCollectorFailure(plain, { writes: 10, failures: 10 }), true);
  });

  it('cannot be muted by a non-2xx body that mimics the bot sentinel', async () => {
    // The suppression must be reachable ONLY through a 2xx. A proxy or a dead
    // origin echoing {"beep":"boop"} with an error status is still an outage.
    const failure = await inspectCollectorResponse(collectorResponse(false, 502, '{"beep":"boop"}'));
    assert.equal(failure?.kind, 'http');
    assert.ok(!failure?.botFiltered, 'a non-2xx must never be classified as bot-filtered');
    assert.equal(isAlertWorthyCollectorFailure(failure!, { writes: 1, failures: 1 }), true);
  });
});
