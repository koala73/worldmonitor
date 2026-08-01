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

describe('umami beacon rejection is swallowed (WORLDMONITOR-WW/WX/WY)', () => {
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

describe('Umami client retry policy (#5715)', () => {
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
      assert.equal(fakeTimers.timers[0]?.delay, 1_000);

      fakeTimers.timers[0]!.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 2);
      assert.equal(fakeTimers.timers[1]?.delay, 2_000);

      fakeTimers.timers[1]!.callback();
      await drainPromiseHandlers();
      assert.equal(calls, 3);
      assert.equal(fakeTimers.timers.length, 2, 'the terminal failed attempt schedules no third timer');
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
      assert.deepEqual(fakeTimers.timers, []);
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
      assert.deepEqual(fakeTimers.timers, [], 'known uniqueness failures are not safe to retry');
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
      assert.equal(fakeTimers.timers[0]?.delay, 1_000);

      fakeTimers.timers[0]!.callback();
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
        fakeTimers.timers,
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
      assert.equal(fakeTimers.timers[0]?.delay, 1_000, 'a 500 identity write must still retry');
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
      assert.deepEqual(fakeTimers.timers, [], 'and it must not retry in-page either');
    } finally {
      fakeTimers.restore();
    }
  });

  it('drops a non-critical write before a queued conversion when the queue overflows', async () => {
    // A never-settling collector keeps the single in-flight slot busy so the
    // queue fills. None of the three eviction branches had any coverage.
    const warnings: Array<Record<string, unknown>> = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const detail = args[1];
      if (detail && typeof detail === 'object') warnings.push(detail as Record<string, unknown>);
    };
    window.fetch = (() => new Promise<Response>(() => {})) as typeof window.fetch;
    (globalThis.window as WinWithUmami).umami = {
      track: (event: unknown, data?: unknown) => nativeTrackerBeacon('event', {
        ...(data as Record<string, unknown> | undefined),
        name: event as string,
      }),
      identify: (data: unknown) => nativeTrackerBeacon('identify', data as Record<string, unknown>),
    };

    try {
      // Fill well past UMAMI_COLLECTOR_QUEUE_LIMIT (25) with non-critical events.
      for (let index = 0; index < 30; index += 1) track('search-open');
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
      assert.equal(fakeTimers.timers.length, 1);

      identifyUser('user_1', 'pro');
      await drainPromiseHandlers();
      assert.equal(calls, 2);
      assert.equal(fakeTimers.timers[0]!.cancelled, true);
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
  isRetryableCollectorFailure,
  isRetryableIdentityFailure,
  isAlertWorthyCollectorFailure,
  getCollectorHealthForTesting,
} = await import('../src/services/analytics-collector-transport.ts');

/**
 * A bot-filtered write is a REAL delivery failure — Umami stored nothing — but
 * it is not an incident. It is the collector doing its job on traffic we do not
 * want counted. The distinction has to live in the alerting decision, never in
 * the delivery classification, or a suppressed alert silently becomes a
 * suppressed retry and a cleared conversion marker.
 */
describe('bot-filtered collector writes (#5964 alert-noise regression)', () => {
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

  it('still alerts on an unexplained receiptless 200', () => {
    const plain = { kind: 'missing-receipt' as const, status: 200 };
    assert.equal(isAlertWorthyCollectorFailure(plain, { writes: 1, failures: 1 }), true);
  });
});

describe('collector alert policy suppresses expected background conditions', () => {
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

  it('stays silent for the known umami#4183 session_data race', () => {
    assert.equal(
      isAlertWorthyCollectorFailure(
        { kind: 'http', status: 500, prismaCode: 'P2002', constraint: 'session_data_pkey' },
        { writes: 1, failures: 1 },
      ),
      false,
    );
  });
});

describe('collector alert policy is wired into the reporting path', () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    delete (globalThis.window as WinWithUmami).umami;
  });

  it('flips the once-per-window latch only after the sample floor is crossed', async () => {
    // Drives REAL writes through the gate so this proves recordCollectorOutcome
    // consults the predicate — a policy unit test alone would pass even if the
    // reporting path ignored it entirely.
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

    await fire(10);
    const after = getCollectorHealthForTesting();
    assert.equal(after.writes, 15, 'writes keep accruing');
    assert.equal(after.noiseReported, true, 'the latch stays set — no second event this window');
  });
});

/**
 * An alarm has to be attacked for the case it exists to catch: can it stay
 * SILENT while the collector is actually dead? #5565 ran for four days unseen.
 */
describe('collector alert policy still fires when the collector is dead', () => {
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

  it('cannot be muted by a non-2xx body that mimics the bot sentinel', async () => {
    // The suppression must be reachable ONLY through a 2xx. A proxy or a dead
    // origin echoing {"beep":"boop"} with an error status is still an outage.
    const failure = await inspectCollectorResponse(collectorResponse(false, 502, '{"beep":"boop"}'));
    assert.equal(failure?.kind, 'http');
    assert.ok(!failure?.botFiltered, 'a non-2xx must never be classified as bot-filtered');
    assert.equal(isAlertWorthyCollectorFailure(failure!, { writes: 1, failures: 1 }), true);
  });
});
