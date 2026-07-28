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
    body: JSON.stringify({ type, data }),
  }).then((response) => response.json()).catch(() => undefined);
}

function collectorResponse(ok: boolean, status: number): Response {
  return {
    ok,
    status,
    json: async () => ({}),
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

async function drainPromiseHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Umami client retry policy (#5715)', () => {
  beforeEach(() => {
    resetAnalyticsForTesting();
  });

  afterEach(() => {
    delete (globalThis.window as WinWithUmami).umami;
  });

  it('retries a swallowed HTTP 500 identity write twice at 1s and 2s, then stops after three failures', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    const collectorFetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(false, 500));
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
      assert.equal(window.fetch, collectorFetch, 'the synchronous delivery observer restores window.fetch');
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

  it('cancels a stale retry when a newer identity snapshot is sent', async () => {
    const fakeTimers = installFakeTimers();
    let calls = 0;
    window.fetch = (() => {
      calls += 1;
      return Promise.resolve(collectorResponse(calls !== 1, calls === 1 ? 500 : 200));
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
      data: {
        userId: 'user_1',
        plan: 'pro',
        subStatus: 'cancelled',
        planKey: 'annual',
      },
    });
  });
});
