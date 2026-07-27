// Tests for the auto-refresh layers added to wm-session.ts:
//
//   Layer 1 — periodic refresh:
//     - setInterval-driven mint while the document is visible.
//     - Skips when document.visibilityState !== 'visible'.
//     - Skips when the cached token is still fresh.
//     - visibilitychange listener mints when the tab becomes visible
//       and the cached token is expired.
//
//   Layer 2 — refresh-on-401 inside the fetch interceptor:
//     - A 401 from the API triggers ensureWmSession() and a single replay.
//     - Premium-RPC paths short-circuit BEFORE the wms_ branch — no retry.
//     - When the caller already supplied Authorization, the wms_ branch
//       is skipped — no retry.
//     - If the retry also 401s, the second response is returned (no infinite loop).
//
// Why both layers:
//   Periodic refresh catches the common case (tab open overnight, laptop wake).
//   Refresh-on-401 is belt-and-suspenders for HMAC-key rotation incidents and
//   any edge case the periodic check missed (e.g. server-side cache flap).
//
// The interceptor lives on a module-scoped flag (`interceptorInstalled`), so
// we install it ONCE here and drive behaviour by swapping the captured
// `original` fetch's responses per test.

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';

import { withPremiumIntent } from '../src/services/premium-intent.ts';

// ---------------------------------------------------------------------------
// Stub browser globals BEFORE the wm-session module is imported. The module
// calls `typeof window === 'undefined'` to gate installation, and reads
// `document.visibilityState` from inside the periodic-refresh closures.
// ---------------------------------------------------------------------------

interface StubDocument {
  visibilityState: 'visible' | 'hidden';
  addEventListener: (type: string, listener: () => void) => void;
  __listeners: Map<string, Array<() => void>>;
  __dispatch: (type: string) => void;
}

const stubDocument: StubDocument = {
  visibilityState: 'visible',
  __listeners: new Map(),
  addEventListener(type, listener) {
    const arr = stubDocument.__listeners.get(type) ?? [];
    arr.push(listener);
    stubDocument.__listeners.set(type, arr);
  },
  __dispatch(type) {
    const arr = stubDocument.__listeners.get(type) ?? [];
    for (const fn of arr) fn();
  },
};

// Stash the most recently registered setInterval callback so tests can fire
// it synchronously without waiting wall-clock time.
let lastIntervalCallback: (() => void) | null = null;
let lastIntervalMs = 0;
const stubSetInterval = ((cb: () => void, ms: number) => {
  lastIntervalCallback = cb;
  lastIntervalMs = ms;
  // Return a fake handle; we never call clearInterval in this test.
  return 1 as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;

// Capture the underlying fetch so the interceptor wraps THIS function. Tests
// reassign `currentFetchHandler` to swap responses per scenario.
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let currentFetchHandler: FetchHandler = () => Promise.resolve(new Response('default', { status: 200 }));
const stubFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => currentFetchHandler(input, init)) as typeof fetch;

// In-memory sessionStorage so loadFromStorage / saveToStorage don't blow up.
const memoryStorage = new Map<string, string>();
const stubSessionStorage: Storage = {
  get length() { return memoryStorage.size; },
  clear() { memoryStorage.clear(); },
  getItem(key) { return memoryStorage.has(key) ? memoryStorage.get(key)! : null; },
  key(i) { return Array.from(memoryStorage.keys())[i] ?? null; },
  removeItem(key) { memoryStorage.delete(key); },
  setItem(key, value) { memoryStorage.set(key, String(value)); },
};

// localStorage stub — touched by src/config/variant.ts during module import.
const memoryLocalStorage = new Map<string, string>();
const stubLocalStorage: Storage = {
  get length() { return memoryLocalStorage.size; },
  clear() { memoryLocalStorage.clear(); },
  getItem(key) { return memoryLocalStorage.has(key) ? memoryLocalStorage.get(key)! : null; },
  key(i) { return Array.from(memoryLocalStorage.keys())[i] ?? null; },
  removeItem(key) { memoryLocalStorage.delete(key); },
  setItem(key, value) { memoryLocalStorage.set(key, String(value)); },
};

// Inject all globals before import. Cast through unknown — node doesn't ship
// a Window type and we only need the touched fields.
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { document: StubDocument }).document = stubDocument;
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = stubSessionStorage;
(globalThis as unknown as { localStorage: Storage }).localStorage = stubLocalStorage;
(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = stubSetInterval;
(globalThis as unknown as { fetch: typeof fetch }).fetch = stubFetch;
// `location` must include `hostname` because src/config/variant.ts (loaded
// transitively via runtime.ts → wm-session.ts) reads `location.hostname` at
// module-eval time and calls `.startsWith(...)` on it.
(globalThis as unknown as { location: Location }).location = {
  href: 'https://worldmonitor.app/',
  origin: 'https://worldmonitor.app',
  hostname: 'worldmonitor.app',
  protocol: 'https:',
  host: 'worldmonitor.app',
} as Location;

// ---------------------------------------------------------------------------
// Now import the module and install the interceptor exactly once.
// ---------------------------------------------------------------------------

let mod: typeof import('../src/services/wm-session.ts');
let wrappedFetch: typeof fetch;

before(async () => {
  mod = await import('../src/services/wm-session.ts');
  mod.installWmSessionFetchInterceptor();
  // After install, globalThis.fetch is the wrapper.
  wrappedFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  assert.notEqual(wrappedFetch, stubFetch, 'interceptor should have replaced globalThis.fetch');
  assert.ok(lastIntervalCallback, 'install should register a setInterval callback');
  assert.equal(lastIntervalMs, 30 * 60 * 1000, 'interval should fire every 30 minutes');
});

beforeEach(() => {
  memoryStorage.clear();
  stubDocument.visibilityState = 'visible';
  // Reset the module's cached/inflight state so each test starts from a
  // clean slate. Without this, a `cached` token from a prior test (set via
  // ensureWmSession's storage path) would short-circuit the next test's
  // mint attempt.
  mod.__resetWmSessionForTests();
  // Default handler: no API endpoint configured per test.
  currentFetchHandler = () => Promise.resolve(new Response('unhandled', { status: 500 }));
});

after(() => {
  // Best-effort cleanup so a follow-on test file doesn't see our globals.
  // node:test runs files in their own process so this is mostly defensive.
  memoryStorage.clear();
});

// Helpers --------------------------------------------------------------------

function setStoredSessionExp(_token: string, expMs: number): void {
  memoryStorage.set('wm-session-exp', JSON.stringify({ exp: expMs }));
}

// Fresh = exp far in the future. Expired = exp in the past (or within the
// 5-minute REFRESH_MARGIN_MS window — same effective behaviour for isFresh).
const FAR_FUTURE = Date.now() + 12 * 60 * 60 * 1000;
const PAST = Date.now() - 1000;

// Force the in-memory `cached` state by calling the module's API. ensureWmSession
// reads sessionStorage when cached is null — set the storage and prime via
// getWmSessionToken doesn't help because that only reads cached. We rely on
// ensureWmSession's storage path to populate `cached`.
async function primeCachedFromStorage(): Promise<void> {
  await mod.ensureWmSession();
}

// ---------------------------------------------------------------------------
// Layer 1 — periodic refresh
// ---------------------------------------------------------------------------

describe('wm-session periodic refresh (Layer 1)', () => {
  it('skips the periodic mint when document is hidden', async () => {
    // Cached token is expired so the interval would otherwise mint.
    setStoredSessionExp('wms_old', PAST);
    await primeCachedFromStorage(); // cached stays null because PAST is not fresh

    stubDocument.visibilityState = 'hidden';

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    // Fire the periodic callback. Should be a no-op because hidden.
    lastIntervalCallback?.();
    // Allow any microtasks/promises to settle.
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'hidden tab must NOT trigger a mint');
  });

  it('skips the periodic mint when the cached token is still fresh', async () => {
    setStoredSessionExp('wms_fresh', FAR_FUTURE);
    await primeCachedFromStorage(); // primes `cached` with fresh value

    stubDocument.visibilityState = 'visible';

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    lastIntervalCallback?.();
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'fresh cached token must NOT trigger a mint');
  });

  it('visibilitychange handler mints when token is expired and tab becomes visible', async () => {
    // beforeEach() reset cached/inflight + cleared storage, so the freshness
    // gate inside the listener evaluates to false and the mint runs.
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    stubDocument.visibilityState = 'visible';
    stubDocument.__dispatch('visibilitychange');
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 1, 'expired cache + visible tab must mint once via visibilitychange');
  });

  it('visibilitychange handler does NOT mint when the cached token is fresh', async () => {
    setStoredSessionExp('wms_fresh_visible', FAR_FUTURE);
    await primeCachedFromStorage(); // primes cached with fresh token

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    stubDocument.visibilityState = 'visible';
    stubDocument.__dispatch('visibilitychange');
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'fresh cached token must short-circuit the visibility handler');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — refresh-on-401
// ---------------------------------------------------------------------------

describe('wm-session refresh-on-401 (Layer 2)', () => {
  it('retries an API 401 with a freshly-minted token', async () => {
    // Prime cached with an expiry for a cookie the server will reject.
    setStoredSessionExp('wms_stale', FAR_FUTURE);
    await primeCachedFromStorage();
    assert.equal(mod.getWmSessionToken(), null);

    let bootstrapAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        assert.equal(init?.credentials, 'include');
        return Promise.resolve(new Response(bootstrapAttempts === 1 ? 'expired' : 'ok', {
          status: bootstrapAttempts === 1 ? 401 : 200,
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    assert.equal(resp.status, 200, 'final response should be the retried 200');
    assert.equal(bootstrapAttempts, 2, 'bootstrap should be called twice (initial 401 + retry)');
    assert.equal(mintCalls, 1, 'one mint between the 401 and the retry');
  });

  it('does NOT retry when the path is in PREMIUM_RPC_PATHS', async () => {
    setStoredSessionExp('wms_anything', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      return Promise.resolve(new Response('forbidden', { status: 401 }));
    };

    // Pick any premium path — analyze-stock is one.
    const resp = await wrappedFetch('https://api.worldmonitor.app/api/market/v1/analyze-stock');
    assert.equal(resp.status, 401);
    assert.equal(attempts, 1, 'premium path must NOT trigger a retry inside this interceptor');
    assert.equal(mintCalls, 0, 'premium path must NOT mint a wms_ token (the dedicated injector handles it)');
  });

  it('does NOT retry a premium-intent request whose path is outside PREMIUM_RPC_PATHS', async () => {
    // #5674 root cause. `/api/news/v1/summarize-article` is conditionally
    // premium: the gateway charges Pro auth for spend-bearing summarize calls
    // but keeps `mode: 'translate'` free — and translate NEEDS the anonymous
    // wms_ cookie, so the path cannot join PREMIUM_RPC_PATHS without breaking
    // free translation. premiumFetch marks the per-request intent instead;
    // without honoring it here, every unauthenticated summarize 401 was read
    // as a rejected cookie and blacked out anonymous browsing for 15 minutes.
    setStoredSessionExp('wms_anything', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: 'Pro authentication required' }), { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    let resp: Response;
    try {
      resp = await wrappedFetch(
        'https://api.worldmonitor.app/api/news/v1/summarize-article',
        withPremiumIntent({ method: 'POST', body: JSON.stringify({ mode: 'summarize' }) }),
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(resp.status, 401, 'the expected Pro denial reaches the caller unchanged');
    assert.equal(attempts, 1, 'premium-intent request must NOT be replayed');
    assert.equal(
      mod.isWmSessionDead(),
      false,
      'an expected Pro denial must never enter the 15-minute anonymous cooldown',
    );
  });

  it('still RECOVERS a 401 on the anonymous pro-fresh price tape', async () => {
    // The sibling test below only proves the mint still happens on the happy
    // path — it never 401s, so it passed while recovery was silently gone.
    // This is the case that actually matters: `proFreshRpcFetch` sets
    // forcePremium on the market-quote tape, but there `forcePremium` means
    // "attach a Bearer opportunistically for a fresher cache tier", NOT "this
    // route is Pro-only". Anonymous callers use these paths and they 401 when
    // the wms_ cookie is rejected — exactly the HMAC-rotation / cache-flap
    // episode Layer 2 exists to absorb. Marking them would turn a recoverable
    // blip into a hard 401 and a dead price tape.
    memoryStorage.clear();

    let attempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      return Promise.resolve(attempts === 1
        ? new Response('rejected cookie', { status: 401 })
        : new Response(JSON.stringify({ quotes: [] }), { status: 200 }));
    };

    // Unmarked is what premiumFetch must produce for a pro-fresh target; the
    // producer side of that contract is pinned in tests/premium-fetch.test.mts.
    const resp = await wrappedFetch(
      'https://api.worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL',
      { credentials: 'include' },
    );

    assert.equal(resp.status, 200, 'the price tape must recover, not surface a raw 401');
    assert.equal(attempts, 2, 'one initial attempt plus one replay');
    assert.ok(mintCalls >= 1, 'the replay is preceded by a fresh mint');
    assert.equal(mod.isWmSessionDead(), false);
  });

  it('still mints a session for a premium-intent request that has none', async () => {
    // The marker suppresses RECOVERY, not the session machinery. proFreshRpcFetch
    // sets forcePremium on the market-quote tape, whose paths are not Pro-only —
    // anonymous callers use them and they 401 with no cookie at all. Skipping the
    // mint for marked requests would leave an anonymous first paint with nothing
    // to send and no retry: a silently dead price tape.
    memoryStorage.clear();

    let mintCalls = 0;
    let sawQuoteRequest = false;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      sawQuoteRequest = true;
      return Promise.resolve(new Response(JSON.stringify({ quotes: [] }), { status: 200 }));
    };

    const resp = await wrappedFetch(
      'https://api.worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL',
      withPremiumIntent({}),
    );

    assert.equal(resp.status, 200);
    assert.equal(mintCalls, 1, 'a marked request with no session must still mint one');
    assert.equal(sawQuoteRequest, true, 'the request must still reach the API');
  });

  it('still recovers the session for a translate-mode call on that same path', async () => {
    // The complement of the test above: the free translate path carries no
    // premium intent and DOES depend on the wms_ cookie, so a genuine dead
    // cookie there must still trigger mint-and-replay. This is what makes the
    // marker per-request rather than per-path.
    setStoredSessionExp('wms_stale', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      return Promise.resolve(attempts === 1
        ? new Response('stale cookie', { status: 401 })
        : new Response(JSON.stringify({ summary: 'bonjour' }), { status: 200 }));
    };

    const resp = await wrappedFetch(
      'https://api.worldmonitor.app/api/news/v1/summarize-article',
      { method: 'POST', body: JSON.stringify({ mode: 'translate' }) },
    );

    assert.equal(resp.status, 200, 'translate must still recover from a genuinely dead cookie');
    assert.equal(attempts, 2, 'one initial attempt plus one replay');
    assert.equal(mintCalls, 1, 'the replay is preceded by a fresh mint');
  });

  it('does NOT retry when the caller supplied Authorization', async () => {
    setStoredSessionExp('wms_anything', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    let lastSeenAuth: string | null = null;
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      lastSeenAuth = headers.get('Authorization');
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap', {
      headers: { Authorization: 'Bearer caller-supplied-jwt' },
    });
    assert.equal(resp.status, 401);
    assert.equal(attempts, 1, 'caller-supplied Authorization must NOT be retried by the wms_ interceptor');
    assert.equal(mintCalls, 0, 'caller-supplied Authorization must NOT trigger a wms_ mint');
    assert.equal(lastSeenAuth, 'Bearer caller-supplied-jwt', 'caller Authorization must pass through untouched');
  });

  it('suppresses later anonymous API calls when a refreshed session is still rejected', async () => {
    // No cached expiry and no stored expiry. Server 401s, the interceptor
    // mints a fresh cookie, replays with credentials, server 401s again.
    // The second 401 must be returned as-is (no further retry); later calls
    // are suppressed by the dead-session cooldown.
    memoryStorage.clear();

    let bootstrapAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        // Mint always succeeds with a fresh token; server still rejects on
        // /api/bootstrap to simulate HMAC-key rotation lag.
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      bootstrapAttempts += 1;
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'the failed recovery returns the server response');

      const suppressed = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(suppressed.status, 503, 'the dead session suppresses later gated calls during the cooldown');
      assert.equal(suppressed.headers.get('x-wm-session-degraded'), '1');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(bootstrapAttempts, 2, 'exactly one retry — later calls must not reach the API');
    assert.equal(mintCalls, 2, 'initial preflight mint plus one recovery mint; no later remints');
    assert.deepEqual(warnings, [
      '[wm-session] refreshed HttpOnly session cookie was still rejected; suppressing anonymous API calls briefly',
    ]);
  });

  it('forwards only explicit credential-less public tier reads during the dead-session cooldown', async () => {
    memoryStorage.clear();

    const forwarded: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
      forwarded.push({ url, credentials });
      if (url.includes('public=1')) return Promise.resolve(new Response('public-tier', { status: 200 }));
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(failed.status, 401, 'failed recovery should enter the dead-session cooldown');

      const fast = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
        credentials: 'omit',
      });
      assert.equal(fast.status, 200, 'string input should reach the public tier while the session is dead');

      const slowRequest = new Request('https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', {
        credentials: 'omit',
      });
      const slow = await wrappedFetch(slowRequest);
      assert.equal(slow.status, 200, 'Request input should preserve its effective omit credentials');

      const digest = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', {
        credentials: 'omit',
      });
      assert.equal(digest.status, 200, 'public digest should bypass dead-session suppression');

      const displacement = await wrappedFetch('https://api.worldmonitor.app/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1', {
        credentials: 'omit',
      });
      assert.equal(displacement.status, 200, 'public displacement should bypass dead-session suppression');

      const missingPublicFlag = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast', {
        credentials: 'omit',
      });
      assert.equal(missingPublicFlag.status, 503, 'ordinary tier reads must remain session-gated');

      const credentialed = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
        credentials: 'include',
      });
      assert.equal(credentialed.status, 503, 'credentialed tier reads must remain session-gated');
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      forwarded.slice(-4),
      [
        { url: 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1', credentials: 'omit' },
      ],
      'only exact credential-less public data requests should reach native fetch during cooldown',
    );
  });

  it('captures ONE wm_session_dead Sentry warning per degraded episode, not one per suppressed call', async () => {
    // reportServerError (premium-fetch.ts) deliberately skips the synthetic
    // X-Wm-Session-Degraded 503s, so this once-per-episode capture is the
    // only remote signal that anonymous browsing is degraded (#5245).
    memoryStorage.clear();

    const captures: Array<{ msg: string; ctx: { level?: string; tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({ captureMessage: (msg: string, ctx: { level?: string; tags?: Record<string, string> }) => { captures.push({ msg, ctx }); } });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // First call trips the failed recovery → markWmSessionDead().
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      // Later calls are suppressed by the cooldown — no additional captures.
      const s1 = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      const s2 = await wrappedFetch('https://api.worldmonitor.app/api/supply-chain/v1/get-shipping-stress');
      assert.equal(s1.status, 503);
      assert.equal(s2.status, 503);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1, 'exactly one Sentry capture per dead-session episode');
    assert.equal(captures[0].msg, 'wm-session dead: anonymous API calls suppressed');
    assert.equal(captures[0].ctx.level, 'warning');
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_dead');
    assert.equal(captures[0].ctx.tags?.reason, 'retry_401');
  });

  it('tags wm_session_dead as mint_failed when recovery cannot mint a session', async () => {
    memoryStorage.clear();

    const captures: Array<{ msg: string; ctx: { level?: string; tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({ captureMessage: (msg: string, ctx: { level?: string; tags?: Record<string, string> }) => { captures.push({ msg, ctx }); } });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response('mint unavailable', { status: 503 }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'failed recovery returns the original server response');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(mintCalls, 2, 'initial preflight and recovery mint both fail');
    assert.equal(captures.length, 1, 'the failed mint starts one degraded episode');
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_dead');
    assert.equal(captures[0].ctx.tags?.reason, 'mint_failed');
    // Both call sites pass the route; without this only the retry_401 branch
    // was covered, so a regression on the mint_failed branch would ship silently.
    assert.equal(captures[0].ctx.tags?.route, '/api/bootstrap');
  });

  it('still captures the episode when addBreadcrumb throws', async () => {
    // The breadcrumb is supplemental; the capture is the ONLY remote signal
    // that anonymous browsing is degraded (#5245). Sharing one try/catch would
    // let a throwing addBreadcrumb (an extension patching window state, a
    // malformed value, an SDK bug) swallow the capture and drop the episode.
    // The existing throwing-enqueue test makes the OUTER call throw, so it
    // never exercises this ordering.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        addBreadcrumb: () => { throw new Error('breadcrumb exploded'); },
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'the recovery return must not become a rejection');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1, 'a throwing breadcrumb must not swallow the capture');
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_dead');
    assert.equal(captures[0].ctx.tags?.route, '/api/bootstrap');
  });

  it('redacts identifier segments out of the route tag', async () => {
    // PREMIUM_RPC_PATHS is an exact-match set, so a dynamic route does not
    // match its parent entry and CAN reach this tag. Without redaction the
    // subscriber id lands in an indexed Sentry tag and the tag's cardinality
    // becomes unbounded — which would defeat the aggregation it exists for.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
        addBreadcrumb: () => {},
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/v2/shipping/webhooks/sub_9f8a7b6c5d4e3f21/pause');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1);
    assert.equal(
      captures[0].ctx.tags?.route,
      '/api/v2/shipping/webhooks/:id/pause',
      'the opaque subscriber id must be replaced, and the route shape preserved',
    );
  });

  it('bounds the route tag for a pathologically long pathname', async () => {
    // The tag is capped at 120 chars because Sentry rejects tag values over
    // 200. The cap's only real trigger is an attacker-shaped or generated URL,
    // so it needs a test or the truncation branch never executes anywhere.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
        addBreadcrumb: () => {},
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const longSegment = 'x'.repeat(300);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(`https://api.worldmonitor.app/api/news/v1/${longSegment}?q=1`);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1);
    const route = captures[0].ctx.tags?.route ?? '';
    assert.equal(route.length, 120, 'the tag must be truncated to the 120-char cap');
    assert.ok(route.startsWith('/api/news/v1/'), 'truncation keeps the discriminating prefix');
    assert.ok(!route.includes('?'), 'the query string is never part of the tag');
  });

  it('tags the dead-session capture with the route whose retry 401d', async () => {
    // #5674 blocker 1: the capture carried only kind + reason, so the failing
    // endpoint could not be aggregated in Sentry and the surviving
    // fresh-mint-then-401 path was undiagnosable from telemetry alone.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        captureMessage: (_msg: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
        addBreadcrumb: () => {},
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/news/v1/summarize-article?lang=en', { method: 'POST' });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1);
    assert.equal(
      captures[0].ctx.tags?.route,
      '/api/news/v1/summarize-article',
      'route tag must be the pathname only — the query string is unbounded cardinality',
    );
  });

  it('a throwing Sentry enqueue never skips the degraded-event dispatch nor rejects the recovery return', async () => {
    // greptile P2 on PR #5247: the capture sits upstream of the
    // WM_SESSION_DEGRADED_EVENT dispatch AND inside the interceptor's 401
    // recovery path — an unguarded throw would both hide the UI toast and
    // turn the wrapped fetch into a rejection instead of returning the 401.
    memoryStorage.clear();
    mod.__setWmSessionSentryEnqueueForTests((() => {
      throw new Error('sdk exploded');
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    // window === globalThis in this harness, and Node's main-thread
    // globalThis is not an EventTarget — stub dispatchEvent so the module's
    // `typeof window.dispatchEvent === 'function'` guard takes the dispatch
    // branch and we can observe it.
    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'recovery must return the server 401, not reject');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 1, 'degraded event must still dispatch when telemetry throws');
  });

  it('single-flights concurrent 401 recovery so only one retry verifies the mint', async () => {
    memoryStorage.clear();
    let gatedAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      gatedAttempts += 1;
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const responses = await Promise.all([
        wrappedFetch('https://api.worldmonitor.app/api/bootstrap'),
        wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses'),
        wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health'),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [401, 401, 401]);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(mintCalls, 2, 'all callers share the initial mint and one recovery mint');
    assert.equal(gatedAttempts, 4, 'three initial 401s plus one verifier retry, never one retry per caller');
  });

  it('replays a delayed stale 401 after another caller has refreshed the session', async () => {
    memoryStorage.clear();
    let mintCalls = 0;
    let bootstrapAttempts = 0;
    let cableAttempts = 0;
    let releaseDelayed401: (() => void) | null = null;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        return Promise.resolve(new Response(bootstrapAttempts === 1 ? 'stale' : 'recovered', {
          status: bootstrapAttempts === 1 ? 401 : 200,
        }));
      }
      cableAttempts += 1;
      if (cableAttempts === 1) {
        return new Promise((resolve) => {
          releaseDelayed401 = () => resolve(new Response('stale', { status: 401 }));
        });
      }
      return Promise.resolve(new Response('recovered', { status: 200 }));
    };

    const first = wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    const delayed = wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(releaseDelayed401, 'the second request should already be awaiting its stale response');
    releaseDelayed401?.();

    const [firstResponse, delayedResponse] = await Promise.all([first, delayed]);
    assert.equal(firstResponse.status, 200);
    assert.equal(delayedResponse.status, 200);
    assert.equal(mintCalls, 2, 'one initial mint plus one recovery mint');
    assert.equal(bootstrapAttempts, 2, 'the first caller verifies the reminted cookie once');
    assert.equal(cableAttempts, 2, 'the delayed stale response replays without invalidating the fresh session');
  });
});
