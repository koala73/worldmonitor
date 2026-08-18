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

// Force the in-memory `cached` expiry the way a successful mint does.
// ensureWmSession no longer copies sessionStorage `{exp}` into `cached`
// without a token (that leftover is the WG bug), so tests that want
// "session already established this page" use the dedicated prime hook.
async function primeCachedFromStorage(): Promise<void> {
  const raw = memoryStorage.get('wm-session-exp');
  if (!raw) {
    await mod.ensureWmSession();
    return;
  }
  const parsed = JSON.parse(raw) as { exp?: unknown };
  if (typeof parsed.exp !== 'number') {
    await mod.ensureWmSession();
    return;
  }
  mod.__primeWmSessionCacheForTests(parsed.exp);
}

describe('wm-session first RPC after mint (WORLDMONITOR-XP)', () => {
  it('attaches X-WorldMonitor-Key on the first anonymous RPC after mint', async () => {
    const mintedToken = 'wms_first-rpc-header-token';
    let firstRpcKey: string | null = 'unset';
    let firstRpcCredentials: RequestCredentials | undefined;
    let premiumKey: string | null = 'unset';
    let mintCalls = 0;

    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: mintedToken,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const headers = new Headers(init?.headers);
      if (url.includes('/api/military/v1/get-usni-fleet-report')) {
        firstRpcKey = headers.get('X-WorldMonitor-Key');
        firstRpcCredentials = init?.credentials;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      if (url.includes('/api/market/v1/analyze-stock')) {
        premiumKey = headers.get('X-WorldMonitor-Key');
        return Promise.resolve(new Response('premium auth remains separate', { status: 200 }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    const response = await wrappedFetch(
      'https://api.worldmonitor.app/api/military/v1/get-usni-fleet-report',
    );
    assert.equal(response.status, 200);
    assert.equal(mintCalls, 1, 'ensureWmSession must mint before the first RPC');
    assert.equal(firstRpcKey, mintedToken, 'first non-premium RPC must carry X-WorldMonitor-Key: wms_…');
    assert.equal(firstRpcCredentials, 'include', 'cookie remains primary via credentials: include');

    const premium = await wrappedFetch('https://api.worldmonitor.app/api/market/v1/analyze-stock');
    assert.equal(premium.status, 200);
    assert.equal(premiumKey, null, 'premium paths must not receive the anonymous wms_ header');
  });

  it('reload with only sessionStorage exp remints and attaches wms_ on first RPC', async () => {
    const mintedToken = 'wms_reload-remint-header-token';
    let firstRpcKey: string | null = 'unset';
    let mintCalls = 0;

    memoryStorage.set('wm-session-exp', JSON.stringify({ exp: FAR_FUTURE }));
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: mintedToken,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const headers = new Headers(init?.headers);
      if (url.includes('/api/military/v1/get-usni-fleet-report')) {
        firstRpcKey = headers.get('X-WorldMonitor-Key');
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    const response = await wrappedFetch(
      'https://api.worldmonitor.app/api/military/v1/get-usni-fleet-report',
    );
    assert.equal(response.status, 200);
    assert.equal(mintCalls, 1, 'must remint because sessionStorage cannot retain the in-memory header token');
    assert.equal(firstRpcKey, mintedToken, 'first RPC after reload remint must carry X-WorldMonitor-Key: wms_…');
  });
});

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
    //
    // The cookie-cannot-be-delivered failure this models rejects EVERY route,
    // so two distinct routes must fail before the global cooldown engages
    // (#5674 — one route's denial is not evidence about the session).
    memoryStorage.clear();

    let apiAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        // Mint always succeeds with a fresh token; the server still rejects
        // every gated route to simulate HMAC-key rotation lag.
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      apiAttempts += 1;
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'the failed recovery returns the server response');

      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the second distinct route also returns the server response');

      const suppressed = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(suppressed.status, 503, 'the dead session suppresses later gated calls during the cooldown');
      assert.equal(suppressed.headers.get('x-wm-session-degraded'), '1');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(apiAttempts, 4, 'one retry per corroborating route — later calls must not reach the API');
    assert.equal(mintCalls, 3, 'initial preflight mint plus one recovery mint per route; no later remints');
    assert.deepEqual(warnings, [
      '[wm-session] refreshed HttpOnly session cookie was still rejected; suppressing anonymous API calls briefly',
    ]);
  });

  it('forwards only explicit credential-less public data reads during the dead-session cooldown', async () => {
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
      assert.equal(failed.status, 401, 'failed recovery returns the server response');
      // Two distinct routes must fail before the global cooldown engages (#5674).
      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the corroborating failure enters the dead-session cooldown');

      const fast = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
        credentials: 'omit',
      });
      assert.equal(fast.status, 200, 'string input should reach the public tier while the session is dead');

      const slowRequest = new Request('https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', {
        credentials: 'omit',
      });
      const slow = await wrappedFetch(slowRequest);
      assert.equal(slow.status, 200, 'Request input should preserve its effective omit credentials');

      const onDemandRequest = new Request('https://api.worldmonitor.app/api/bootstrap?keys=chinaPolicyEvents&public=1', {
        credentials: 'omit',
      });
      const onDemand = await wrappedFetch(onDemandRequest);
      assert.equal(onDemand.status, 200, 'public on-demand hydration must not participate in wm-session state');

      // weatherAlerts rides the fast tier but has its own public URL (#5386),
      // so it is a single-key public read like the on-demand keys above.
      const publicWeather = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1', {
        credentials: 'omit',
      });
      assert.equal(publicWeather.status, 200, 'public weather hydration must not participate in wm-session state');

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

      const multipleKeys = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?keys=a,b&public=1', {
        credentials: 'omit',
      });
      assert.equal(multipleKeys.status, 503, 'multi-key bootstrap reads must remain session-gated');

      const nonPublicKey = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes&public=1', {
        credentials: 'omit',
      });
      assert.equal(nonPublicKey.status, 503, 'a single key outside the public single-key registry must remain session-gated');

      // The marker is what makes the read public. Without it the same key is the
      // credentialed URL, where a 401 IS ordinary session evidence (#5386).
      const unmarkedWeather = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts', {
        credentials: 'omit',
      });
      assert.equal(unmarkedWeather.status, 503, 'the unmarked weather URL must remain session-gated');
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      forwarded.slice(-6),
      [
        { url: 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/bootstrap?keys=chinaPolicyEvents&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1', credentials: 'omit' },
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

    const { captures } = collectSentry();

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
      // Two distinct routes must fail before the episode starts (#5674).
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      // Later calls are suppressed by the cooldown — no additional captures.
      const s1 = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      const s2 = await wrappedFetch('https://api.worldmonitor.app/api/supply-chain/v1/get-shipping-stress');
      assert.equal(s1.status, 503);
      assert.equal(s2.status, 503);
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one Sentry capture per dead-session episode');
    assert.equal(dead[0].msg, 'wm-session dead: anonymous API calls suppressed');
    assert.equal(dead[0].ctx.level, 'warning');
    assert.equal(dead[0].ctx.tags?.reason, 'retry_401');
    assert.equal(dead[0].ctx.tags?.route, '/api/infrastructure/v1/get-cable-health');
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
    // A failed mint implicates /api/wm-session itself, not the route that happened
    // to trigger recovery. Tagging the blocked route would pollute the route census
    // with an innocent endpoint.
    assert.equal(captures[0].ctx.tags?.route, '/api/wm-session');
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
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_route_401');
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
    // The tag is capped at 96 chars. Use legal static-looking segments so the
    // whole-route cap, rather than the per-segment identifier collapse, is what
    // truncates the value.
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

    const longPath = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrst').join('/');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(`https://api.worldmonitor.app/api/news/v1/${longPath}?q=1`);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(captures.length, 1);
    const route = captures[0].ctx.tags?.route ?? '';
    assert.equal(route.length, 96, 'the tag must be truncated to the 96-char cap');
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
      // A throwing enqueue must not break the per-route report either, and the
      // corroborating route is what reaches the degraded-event dispatch (#5674).
      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the corroborating recovery must also return, not reject');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 1, 'degraded event must still dispatch when telemetry throws');
  });

  it('single-flights the MINT across a concurrent 401 burst, and lets the burst corroborate itself', async () => {
    // The invariant that matters is the MINT count: one shared mint for the
    // whole burst, never one per caller (#5219 amplification).
    //
    // Each follower does re-send once with the freshly minted cookie, and that
    // is load-bearing rather than waste (#5674): a dashboard fires its panels
    // together, so the cookie-cannot-be-delivered failure arrives as ONE
    // concurrent burst. If followers returned the leader's verdict without
    // testing their own route, the burst would contribute a single strike and
    // could never reach SESSION_DEAD_ROUTE_QUORUM — the global cooldown would be
    // deferred to a later sequential round. Verifying its own route is also what
    // keeps this honest in the other direction: a follower whose route is
    // actually healthy gets a 200 and clears the corroboration evidence.
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
    assert.equal(
      gatedAttempts, 6,
      'three initial 401s, the leader’s verifier retry, and one fresh-cookie re-send per follower — no extra MINTS',
    );
    // The behavioural delta this burst exists to pin: three distinct routes all
    // rejected a demonstrably fresh cookie, which is the #5219/#5251 failure, so
    // the quorum is satisfied by the burst itself rather than a later round.
    assert.equal(
      mod.isWmSessionDead(), true,
      'a concurrent burst of distinct routes rejecting a fresh cookie must reach the quorum',
    );
  });

  it('records a follower 401 after the recovery leader succeeds', async () => {
    memoryStorage.clear();
    const { captures } = collectSentry();
    const leaderUrl = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    const followerUrl = 'https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health';
    let mintCalls = 0;
    let releaseRecoveryMint: (() => void) | null = null;
    const attempts = new Map<string, number>();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        if (mintCalls === 2) {
          return new Promise((resolve) => {
            releaseRecoveryMint = () => resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      if (url === leaderUrl && count === 2) return Promise.resolve(new Response('recovered', { status: 200 }));
      return Promise.resolve(new Response('denied', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const leader = wrappedFetch(leaderUrl);
      const follower = wrappedFetch(followerUrl);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseRecoveryMint, 'the leader should be holding the shared recovery mint');
      releaseRecoveryMint?.();

      const [leaderResponse, followerResponse] = await Promise.all([leader, follower]);
      assert.equal(leaderResponse.status, 200);
      assert.equal(followerResponse.status, 401);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(mod.getStruckRoutes(), ['/api/infrastructure/v1/get-cable-health']);
    assert.equal(mod.isWmSessionDead(), false, 'one failed follower route is not a dead session');
    assert.ok(
      captures.some((capture) => (
        capture.ctx.tags?.kind === 'wm_session_route_401'
        && capture.ctx.tags?.route === '/api/infrastructure/v1/get-cable-health'
      )),
      'the follower denial must be reported and suppressed just like a leader denial',
    );
  });

  it('lets a late healthy follower lift a retry_401 cooldown from the same burst', async () => {
    memoryStorage.clear();
    collectSentry();
    const leaderUrl = 'https://api.worldmonitor.app/api/bootstrap';
    const deniedFollowerUrl = 'https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health';
    const healthyFollowerUrl = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    let mintCalls = 0;
    let releaseRecoveryMint: (() => void) | null = null;
    let releaseDeniedFollower: (() => void) | null = null;
    let releaseHealthyFollower: (() => void) | null = null;
    const attempts = new Map<string, number>();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        if (mintCalls === 2) {
          return new Promise((resolve) => {
            releaseRecoveryMint = () => resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      if (count === 1 || url === leaderUrl) return Promise.resolve(new Response('denied', { status: 401 }));
      if (url === deniedFollowerUrl) {
        return new Promise((resolve) => {
          releaseDeniedFollower = () => resolve(new Response('denied', { status: 401 }));
        });
      }
      if (url === healthyFollowerUrl) {
        return new Promise((resolve) => {
          releaseHealthyFollower = () => resolve(new Response('healthy', { status: 200 }));
        });
      }
      return Promise.resolve(new Response('unexpected', { status: 500 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const responses = Promise.all([
        wrappedFetch(leaderUrl),
        wrappedFetch(deniedFollowerUrl),
        wrappedFetch(healthyFollowerUrl),
      ]);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseRecoveryMint, 'the concurrent burst should share one recovery mint');
      releaseRecoveryMint?.();
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseDeniedFollower && releaseHealthyFollower, 'both followers should have started their fresh-cookie replays');

      releaseDeniedFollower?.();
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(mod.isWmSessionDead(), true, 'two fresh-cookie denials briefly reach the retry_401 quorum');

      releaseHealthyFollower?.();
      const settled = await responses;
      assert.deepEqual(settled.map((response) => response.status), [401, 401, 200]);
      assert.equal(
        mod.isWmSessionDead(), false,
        'the already-in-flight credentialed success proves the session is live and lifts only the retry_401 cooldown',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not let an in-flight success lift a mint_failed cooldown', async () => {
    memoryStorage.clear();
    collectSentry();
    const failedUrl = 'https://api.worldmonitor.app/api/bootstrap';
    const healthyUrl = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    let releaseHealthy: (() => void) | null = null;

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response('mint unavailable', { status: 503 }));
      }
      if (url === healthyUrl) {
        return new Promise((resolve) => {
          releaseHealthy = () => resolve(new Response('healthy', { status: 200 }));
        });
      }
      return Promise.resolve(new Response('denied', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = wrappedFetch(failedUrl);
      const healthy = wrappedFetch(healthyUrl);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(mod.isWmSessionDead(), true, 'the recovery mint failure enters its immediate cooldown');
      assert.ok(releaseHealthy, 'the credentialed success should already be in flight');

      releaseHealthy?.();
      assert.deepEqual((await Promise.all([failed, healthy])).map((response) => response.status), [401, 200]);
      assert.equal(
        mod.isWmSessionDead(), true,
        'a late response cannot lift the stronger mint_failed cooldown',
      );
    } finally {
      console.warn = originalWarn;
    }
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

// ---------------------------------------------------------------------------
// #5674 — one route's denial must not black out the whole anonymous session
// ---------------------------------------------------------------------------
//
// WORLDMONITOR-WG regrew 34x (traffic-normalized) after #5516 with 97% of
// episodes tagged `retry_401`. Server-side telemetry (wm_api_usage, Axiom)
// for 12 sampled affected browsers showed 11 of them emitting ZERO 401s for
// the entire episode, and sibling routes on the same tab returning 200 in the
// same second the client declared the session dead. The cookie was healthy;
// the diagnosis was not.
//
// Two things are pinned here:
//   1. The offending route is now aggregable (`route` tag + manual breadcrumb),
//      because neither Sentry's fetch instrumentation nor the gateway's own
//      telemetry can see the 401 that causes the episode.
//   2. A lone route may suppress only itself. Blacking out every anonymous
//      call still requires corroboration from a second distinct route — which
//      the original "browser cannot deliver the cookie" failure (#5219/#5251)
//      always produces, since it makes EVERY route 401.

type Capture = { msg: string; ctx: { level?: string; tags?: Record<string, string> } };
type Crumb = { category?: string; message?: string; data?: Record<string, string> };

function collectSentry(): { captures: Capture[]; crumbs: Crumb[]; order: string[] } {
  const captures: Capture[] = [];
  const crumbs: Crumb[] = [];
  const order: string[] = [];
  mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
    fn({
      captureMessage: (msg: string, ctx: Capture['ctx']) => {
        captures.push({ msg, ctx });
        order.push(`capture:${ctx.tags?.kind ?? '?'}`);
      },
      addBreadcrumb: (crumb: Crumb) => {
        crumbs.push(crumb);
        order.push(`crumb:${crumb.message ?? '?'}`);
      },
    });
  }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);
  return { captures, crumbs, order };
}

/** Mint always succeeds; only the listed routes 401. */
function handlerRejecting(rejected: string[], counters: { mints: number; hits: Map<string, number> }): FetchHandler {
  return (input) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    if (url.includes('/api/wm-session')) {
      counters.mints += 1;
      return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    counters.hits.set(url, (counters.hits.get(url) ?? 0) + 1);
    const denied = rejected.some((route) => url.includes(route));
    return Promise.resolve(new Response(denied ? 'denied' : 'ok', { status: denied ? 401 : 200 }));
  };
}

describe('wm-session route-scoped recovery failures (#5674)', () => {
  it('reduces a pathname to a bounded, aggregable route tag', () => {
    assert.equal(
      mod.toRouteTag('/api/intelligence/v1/get-risk-scores'),
      '/api/intelligence/v1/get-risk-scores',
      'a real static API route is preserved verbatim so it can be read off the tag',
    );
    assert.equal(mod.toRouteTag('/api/bootstrap'), '/api/bootstrap');
    assert.equal(mod.toRouteTag('/api/v2/shipping/route-intelligence'), '/api/v2/shipping/route-intelligence');

    // Dynamic segments are caller-controlled — collapse them or the tag's
    // cardinality is unbounded and Sentry stops aggregating.
    assert.equal(mod.toRouteTag('/api/v2/shipping/webhooks/sub_8f2a11'), '/api/v2/shipping/webhooks/:id');
    assert.equal(mod.toRouteTag('/api/user/prefs/9d4c7b2e'), '/api/user/prefs/:id');
    assert.equal(mod.toRouteTag('/api/thing/' + 'x'.repeat(64)), '/api/thing/:id');

    // Real RPC method names embed small numbers. Collapsing these would throw
    // away the only thing the tag exists to deliver (#5674 AC#1) while looking
    // exactly like a legitimately-collapsed dynamic route family, so a triager
    // would read `/api/climate/v1/:id` and dismiss it as unresolvable noise.
    assert.equal(mod.toRouteTag('/api/climate/v1/get-co2-monitoring'), '/api/climate/v1/get-co2-monitoring');
    assert.equal(mod.toRouteTag('/api/health/v1/get-pm25-exposure'), '/api/health/v1/get-pm25-exposure');
    assert.equal(mod.toRouteTag('/api/economic/v1/get-g20-outlook'), '/api/economic/v1/get-g20-outlook');
    // ...but a segment whose word STARTS with a digit, or that runs letters and
    // digits together at id length, is an identifier and must still collapse.
    assert.equal(mod.toRouteTag('/api/brief/2026-07-27'), '/api/brief/:id');
    assert.equal(mod.toRouteTag('/api/thing/a1b2c3d4e5'), '/api/thing/:id');

    // The longest real route name in the registered table (33 chars) must
    // survive verbatim. A 32-char per-segment cap collapsed this live panel
    // route to `/api/supply-chain/v1/:id`, which is worse than no tag: it reads
    // as a legitimately-collapsed dynamic family, so a triager reading the
    // census would dismiss the one route it was supposed to name.
    assert.equal(
      mod.toRouteTag('/api/supply-chain/v1/get-china-corridor-control-towers'),
      '/api/supply-chain/v1/get-china-corridor-control-towers',
      'the longest real route name must not be mistaken for an id',
    );
    // Next-longest sits at exactly 32, i.e. one character from the old cap.
    assert.equal(
      mod.toRouteTag('/api/consumer-prices/v1/get-consumer-price-basket-series'),
      '/api/consumer-prices/v1/get-consumer-price-basket-series',
    );

    // Non-API paths never reach the wms_ branch; bucket rather than leak.
    assert.equal(mod.toRouteTag('/dashboard'), 'other');
    assert.equal(mod.toRouteTag(''), 'other');

    // Segment cap: many short segments are truncated by MAX_ROUTE_TAG_SEGMENTS.
    const many = mod.toRouteTag(`/api/${Array.from({ length: 40 }, () => 'segment').join('/')}`);
    assert.ok(many.length <= 96, `route tag must stay bounded, got ${many.length}`);
    assert.equal(many.split('/').filter(Boolean).length, 8, 'segment cap applies');
    // Length cap: 8 legal-but-long segments clear the segment cap, so this is
    // the case that actually exercises MAX_ROUTE_TAG_LENGTH. The previous
    // 40-short-segment input collapsed to 60 chars and never reached the slice.
    const wide = mod.toRouteTag(`/api/${Array.from({ length: 7 }, () => 'x'.repeat(30)).join('/')}`);
    assert.ok(wide.length > 60, 'pre-slice input must exceed the segment-cap-only length');
    assert.equal(wide.length, 96, 'the length cap itself must truncate');
  });

  it('suppresses ONLY the offending route when a single endpoint 401s after a fresh mint', async () => {
    memoryStorage.clear();
    const { captures, crumbs } = collectSentry();

    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const denied = await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(denied.status, 401, "the caller still receives the server's own verdict");

      // The exact scenario Axiom proved: sibling routes are healthy and must
      // keep working. Today's code returns 503 for both of these.
      const sibling = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      const sibling2 = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(sibling.status, 200, 'a healthy sibling route must NOT be blacked out by another route’s 401');
      assert.equal(sibling2.status, 200, 'the anonymous session is alive — every other panel keeps loading');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 0, 'no degraded-session toast for a single-route denial');
    assert.deepEqual(warnings, [], 'the session was never dead, so nothing warns about suppression');
    assert.equal(mod.isWmSessionDead(), false, 'the global cooldown must NOT engage on one route');

    assert.equal(captures.length, 1, 'the offending route is still reported exactly once');
    // A distinct `kind` keeps WORLDMONITOR-WG the blackout counter it was
    // designed to be (#5245) while this becomes the route census (#5674).
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_route_401');
    assert.equal(captures[0].ctx.tags?.route, '/api/intelligence/v1/get-risk-scores');
    assert.equal(crumbs.length, 1, 'the invisible 401 gets a manual breadcrumb');
    assert.equal(crumbs[0].data?.route, '/api/intelligence/v1/get-risk-scores');
  });

  it('does not re-mint for a route that already failed its fresh-cookie replay', async () => {
    memoryStorage.clear();
    const { captures } = collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const url = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);
      const mintsAfterFirst = counters.mints;
      const second = await wrappedFetch(url);
      const third = await wrappedFetch(url);
      assert.equal(second.status, 401);
      assert.equal(third.status, 401);
      assert.equal(
        counters.mints, mintsAfterFirst,
        'a struck route must not spend another mint — that is the #5219 amplification this guards',
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(counters.hits.get(url), 4, 'first attempt + one verifier retry, then one bare pass-through each');
    // reportRouteRecoveryFailure is documented as bounded to one report per
    // route per cooldown window. Without this assertion a regression that
    // re-reported on every pass-through would keep the suite green while
    // multiplying wm_session_route_401 volume in Sentry.
    assert.equal(captures.length, 1, 'a struck route must not re-report on every pass-through hit');
  });

  it('still blacks out the session once a SECOND distinct route fails the fresh-cookie replay', async () => {
    // The original #5219/#5251 failure — the browser cannot deliver the
    // HttpOnly cookie at all — makes every route 401, so the quorum is reached
    // and the global cooldown must still engage.
    memoryStorage.clear();
    const { captures, crumbs, order } = collectSentry();

    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/'], counters);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const first = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(first.status, 401);
      assert.equal(mod.isWmSessionDead(), false, 'one route is not yet proof');

      const second = await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(second.status, 401, 'the corroborating route returns the server response');
      assert.equal(mod.isWmSessionDead(), true, 'two distinct routes DO prove the cookie is not being delivered');

      const suppressed = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(suppressed.status, 503, 'the global cooldown engages exactly as before');
      assert.equal(suppressed.headers.get('x-wm-session-degraded'), '1');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 1, 'the degraded toast fires once the session really is dead');
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one wm_session_dead per episode');
    assert.equal(dead[0].ctx.tags?.reason, 'retry_401');
    assert.equal(
      dead[0].ctx.tags?.route, '/api/intelligence/v1/get-risk-scores',
      'the blackout capture names the route that tripped it (#5674 AC#1)',
    );
    assert.ok(
      crumbs.some((c) => c.data?.route === '/api/intelligence/v1/get-risk-scores' && c.data?.reason === 'retry_401'),
      'the otherwise-invisible 401 is recorded as a breadcrumb before the capture',
    );
    // ORDERING is the load-bearing half of the AC#1 fix, not mere existence: the
    // manual crumb only lands in the episode's event if it is added BEFORE the
    // captureMessage. Assert the interleaving the harness collects, or a
    // regression that swapped the two calls would keep every other assertion
    // above green while restoring the invisible-401 blind spot.
    const deadCapture = order.indexOf('capture:wm_session_dead');
    const deadCrumb = order.indexOf('crumb:wm-session recovery failed');
    assert.ok(deadCrumb >= 0 && deadCapture >= 0, `both events must be recorded, got ${JSON.stringify(order)}`);
    assert.ok(deadCrumb < deadCapture, `breadcrumb must precede the capture, got ${JSON.stringify(order)}`);
  });

  it('does NOT black out when two route denials fall outside the corroboration window', async () => {
    // Corroboration is temporal coincidence, not "twice in 15 minutes". Two
    // unrelated endpoint bugs an hour apart are not evidence that the cookie is
    // undeliverable, and blacking out a demonstrably healthy session on that
    // basis is the exact harm #5674 is about.
    memoryStorage.clear();
    collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/'], counters);

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(mod.isWmSessionDead(), false, 'one route is not yet proof');

      // Well past SESSION_DEAD_CORROBORATION_MS but well inside the 15-minute
      // per-route suppression window.
      clock += 5 * 60 * 1000;
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(
        mod.isWmSessionDead(), false,
        'a denial 5 minutes later is not corroborating evidence of a session-wide failure',
      );
    } finally {
      Date.now = realNow;
      console.warn = originalWarn;
    }
  });

  it('lets a healthy sibling’s 200 retire the corroboration evidence', async () => {
    // The #5674 diagnosis rested on siblings returning 200 in the very same
    // second the client declared the session dead. A success is therefore
    // counter-evidence and must void the quorum — while NOT releasing the struck
    // route's own mint guard, which is what keeps #5219 amplification bounded.
    memoryStorage.clear();
    collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(
      ['/api/intelligence/v1/get-risk-scores', '/api/economic/v1/get-bls-series'],
      counters,
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(mod.isWmSessionDead(), false, 'one broken endpoint is not a dead session');

      const healthy = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(healthy.status, 200, 'the sibling is fine, which is the whole point');

      // A second, unrelated broken endpoint. Two failures — but a success in
      // between proved the cookie is being delivered, so this is two endpoint
      // bugs, not a session failure.
      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(
        mod.isWmSessionDead(), false,
        'a proven-live session must not be blacked out by two unrelated endpoint denials',
      );

      const stillWorking = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(stillWorking.status, 200, 'every healthy panel keeps loading');

      // The mint guard for the broken route must survive the sibling's success,
      // or it would remint on every poll (~120/hr instead of ~4/hr).
      const mintsBefore = counters.mints;
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(
        counters.mints, mintsBefore,
        'a sibling’s success must NOT release the struck route’s mint guard (#5219)',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('lets a successful recovery leader retire earlier quorum evidence', async () => {
    memoryStorage.clear();
    collectSentry();
    const firstDenied = '/api/intelligence/v1/get-risk-scores';
    const recovering = '/api/news/v1/list-feed-digest';
    const laterDenied = '/api/economic/v1/get-bls-series';
    const attempts = new Map<string, number>();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      if (url.includes(recovering) && count === 2) {
        return Promise.resolve(new Response('recovered', { status: 200 }));
      }
      return Promise.resolve(new Response('denied', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(`https://api.worldmonitor.app${firstDenied}`);
      assert.equal(mod.isWmSessionDead(), false, 'the first failed route contributes one quorum vote');

      const recovered = await wrappedFetch(`https://api.worldmonitor.app${recovering}`);
      assert.equal(recovered.status, 200, 'the second route succeeds after its fresh mint');

      await wrappedFetch(`https://api.worldmonitor.app${laterDenied}`);
      assert.equal(
        mod.isWmSessionDead(), false,
        'the successful recovery must clear the earlier vote before a later route fails',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('clears route strikes when a key-bound session replaces the anonymous one', async () => {
    // establishWmKeySession is what migrateLegacyKeysToHttpOnlySession calls when
    // a user holding a legacy widget/pro key upgrades. Strikes recorded against
    // the anonymous identity say nothing about what the key-bound one may reach,
    // so a paying user must not inherit a 15-minute suppression on their panel.
    memoryStorage.clear();
    collectSentry();
    const gated = '/api/intelligence/v1/get-risk-scores';
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        counters.mints += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      counters.hits.set(url, (counters.hits.get(url) ?? 0) + 1);
      const denied = url.includes(gated);
      return Promise.resolve(new Response(denied ? 'denied' : 'ok', { status: denied ? 401 : 200 }));
    };

    const url = `https://api.worldmonitor.app${gated}`;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);

      // Struck: the next call short-circuits, spending neither a mint nor a retry.
      let mintsBefore = counters.mints;
      let hitsBefore = counters.hits.get(url) ?? 0;
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsBefore, 'a struck route spends no mint');
      assert.equal(counters.hits.get(url), hitsBefore + 1, 'a struck route passes through exactly once');

      assert.equal(await mod.establishWmKeySession({ proKey: 'pk_test' }), true, 'the key session is established');

      // Still denied, so the observable difference is whether recovery is
      // ATTEMPTED. Asserting a 200 here instead would pass even with the clear
      // removed, because a route that starts succeeding returns at the success
      // branch before the struck check is ever consulted.
      mintsBefore = counters.mints;
      hitsBefore = counters.hits.get(url) ?? 0;
      await wrappedFetch(url);
      assert.equal(
        counters.mints, mintsBefore + 1,
        'the upgraded identity must get a fresh recovery attempt, not inherit the anonymous strike',
      );
      assert.equal(counters.hits.get(url), hitsBefore + 2, 'initial attempt plus the verifier retry');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('ignores an anonymous recovery result that settles after a key-session upgrade', async () => {
    memoryStorage.clear();
    const { captures } = collectSentry();
    const gated = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    let gatedAttempts = 0;
    let anonymousMintCalls = 0;
    let releaseAnonymousMint: (() => void) | null = null;
    const initialAnonymousToken = 'wms_initial-anonymous-session';
    const anonymousToken = 'wms_stale-anonymous-recovery';
    const fallbackHeaders: Array<string | null> = [];

    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { proKey?: string } : {};
        if (!body.proKey) {
          anonymousMintCalls += 1;
          if (anonymousMintCalls === 1) {
            return Promise.resolve(new Response(JSON.stringify({
              exp: FAR_FUTURE,
              hadSession: false,
              token: initialAnonymousToken,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
          return new Promise((resolve) => {
            releaseAnonymousMint = () => resolve(new Response(JSON.stringify({
              exp: FAR_FUTURE,
              hadSession: false,
              token: anonymousToken,
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          });
        }
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: 'wms_key-upgrade-mint',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      fallbackHeaders.push(new Headers(init?.headers).get('X-WorldMonitor-Key'));
      gatedAttempts += 1;
      if (gatedAttempts === 1) return Promise.resolve(new Response('stale', { status: 401 }));
      return Promise.resolve(new Response('key cookie accepted', { status: 200 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const anonymousRequest = wrappedFetch(gated);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseAnonymousMint, 'the anonymous recovery mint should still be in flight');

      assert.equal(
        await mod.establishWmKeySession({ proKey: 'pk_test' }),
        true,
        'the key-bound identity should replace the anonymous one',
      );
      releaseAnonymousMint?.();
      assert.equal((await anonymousRequest).status, 200, 'the stale caller replays through the upgraded identity');
      assert.equal(
        (await wrappedFetch(gated)).status,
        200,
        'later requests continue through the upgraded key session',
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      fallbackHeaders,
      [initialAnonymousToken, null, null],
      'a stale anonymous mint must never inject its token after a key-session upgrade',
    );
    assert.deepEqual(mod.getStruckRoutes(), [], 'the old identity must not repopulate route suppression');
    assert.equal(mod.isWmSessionDead(), false, 'the old identity must not degrade the key-bound session');
    assert.equal(captures.length, 0, 'the stale anonymous denial must not be reported against the key-bound identity');
  });

  it('gives a struck route the free newer-cookie replay when the session has moved on', async () => {
    // The struck-route short-circuit must sit BELOW the sessionGeneration check.
    // That replay spends no mint, so denying it to a struck route pins the route
    // to a stale 401 for the rest of its 15-minute window even after an
    // unrelated caller has already obtained a cookie that works.
    memoryStorage.clear();
    collectSentry();
    const struck = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    let mints = 0;
    let struckAttempts = 0;
    let bootstrapAttempts = 0;
    let releaseStale401: (() => void) | null = null;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mints += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        // 401 once, then accept — this is what advances sessionGeneration.
        return Promise.resolve(new Response('x', { status: bootstrapAttempts === 1 ? 401 : 200 }));
      }
      struckAttempts += 1;
      // Attempts 1-2 strike the route. Attempt 3 hangs, holding a stale 401 open
      // across another caller's refresh. Attempt 4 is the replay, which works.
      if (struckAttempts === 3) {
        return new Promise((resolve) => { releaseStale401 = () => resolve(new Response('stale', { status: 401 })); });
      }
      return Promise.resolve(new Response('x', { status: struckAttempts >= 4 ? 200 : 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(struck);
      assert.equal(struckAttempts, 2, 'the route is struck after its fresh-cookie replay fails');

      const delayed = wrappedFetch(struck);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseStale401, 'the struck route should be awaiting its stale 401');

      // An unrelated caller recovers the session, advancing sessionGeneration.
      const other = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(other.status, 200, 'the unrelated caller recovers normally');

      releaseStale401?.();
      const replayed = await delayed;
      assert.equal(
        replayed.status, 200,
        'a struck route must still take the mint-free newer-cookie replay once the generation advances',
      );
      assert.equal(struckAttempts, 4, 'the stale 401 was replayed rather than handed back');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('trips the global cooldown immediately when the mint itself fails', async () => {
    // mint_failed is session-wide by construction: no cookie exists for ANY
    // route, so corroboration would be pure delay.
    memoryStorage.clear();
    const { captures, crumbs } = collectSentry();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) return Promise.resolve(new Response('mint down', { status: 503 }));
      return Promise.resolve(new Response('denied', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(resp.status, 401);
      assert.equal(mod.isWmSessionDead(), true, 'a failed mint needs no second route');
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.reason, 'mint_failed');
    // The `route` tag must name what FAILED, since grouping WORLDMONITOR-WG by it
    // to find the offending endpoint is the tag's whole purpose. On mint_failed
    // the mint is what failed; the in-flight route is a bystander and tagging it
    // would seed the route census with innocent endpoints.
    assert.equal(dead[0].ctx.tags?.route, '/api/wm-session');
    // The bystander is still useful for triage, so it rides the breadcrumb.
    assert.ok(
      crumbs.some((c) => c.data?.blocked === '/api/infrastructure/v1/list-service-statuses'),
      `the blocked route is preserved on the breadcrumb, got ${JSON.stringify(crumbs.map((c) => c.data))}`,
    );
  });

  it('releases a struck route once its suppression window lapses', async () => {
    // The strike is a time-boxed mint guard, not a permanent verdict. If expiry
    // did not actually release it, a route denied once would never attempt
    // recovery again for the life of the tab.
    memoryStorage.clear();
    collectSentry();
    const url = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);
      assert.deepEqual(mod.getStruckRoutes(), ['/api/intelligence/v1/get-risk-scores'], 'the route is struck');

      const mintsWhileStruck = counters.mints;
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsWhileStruck, 'still struck: no mint');

      // Past the per-route suppression TTL.
      clock += 15 * 60 * 1000 + 1;
      assert.deepEqual(mod.getStruckRoutes(), [], 'the strike lapsed');
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsWhileStruck + 1, 'a lapsed strike lets recovery run again');
    } finally {
      Date.now = realNow;
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — cookie-persistence detection
//
// The failure mode WORLDMONITOR-WG/XP actually describes: the mint succeeds
// (200 + Set-Cookie) but the browser never sends the cookie back, so every
// credentialed route 401s no matter how many times we re-mint. The client
// cannot read the HttpOnly cookie to check, so it used to assume the SERVER
// rejected a good cookie and reported `retry_401` — blaming the API for a
// browser-side storage failure, and spending one mint per route on the way.
//
// The mint response now reports whether the request ARRIVED with a valid
// session cookie. A second mint that still reports `hadSession: false` proves
// the cookie we just set never came back.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layer 4 — a failed mint is not automatically a dead session (WORLDMONITOR-WG).
//
// `fetchNewSession` used to collapse five outcomes into a bare `null`: a non-2xx
// status, a 200 with a malformed body, a network error, a CORS block, and its own
// 10s timeout. `mint_failed` then skipped the route quorum and blacked out every
// anonymous call for 15 minutes, justified by "the mint itself did not hand back
// a cookie, so no route can succeed".
//
// Production disproved that premise. For 5 of the 7 most recent mint_failed
// events, Axiom shows the server handled 121-216 /api/wm-session requests in a
// +/-2.5 minute window around the event with ZERO rejections; the two others saw
// only origin_403 from unrelated clients. The server never refused. The failure
// was in the client's own transport, and one dropped request cost that user a
// 15-minute blackout.
//
// So the verdict now depends on WHICH failure happened: a server refusal is still
// session-wide, a transport failure is retried once and must corroborate across
// two routes before it may black out the tab.
// ---------------------------------------------------------------------------

// Exceptions the module sent via Sentry's captureException, most recent last.
// Reset by every captureSink() call.
let capturedExceptions: unknown[] = [];
// Breadcrumbs the module added, most recent last. Reset by every captureSink()
// call. The breadcrumb carries the same route/reason/mint_cause fields as the
// event and is the only record that survives when the capture itself is
// suppressed, so it needs its own assertions rather than being discarded.
let capturedCrumbs: Array<{ message?: string; data?: Record<string, string> }> = [];

// Shared Sentry sink for the dead-session capture tests.
//
// `onCapture` runs SYNCHRONOUSLY inside markWmSessionDead, after it has already
// pushed sessionDeadUntil out and before it returns. That is the one seam where
// a test can advance the clock between one verdict and the next, which is what
// makes "a second, redundant verdict re-armed the cooldown" observable at all —
// both calls otherwise land on the same millisecond and extend it by zero.
function captureSink(onCapture?: () => void) {
  const captures: Array<{ msg: string; ctx: { level?: string; tags?: Record<string, string> } }> = [];
  capturedExceptions = [];
  capturedCrumbs = [];
  mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
    fn({
      captureMessage: (msg: string, ctx: { level?: string; tags?: Record<string, string> }) => {
        captures.push({ msg, ctx });
        onCapture?.();
      },
      captureException: (err: unknown) => { capturedExceptions.push(err); },
      addBreadcrumb: (crumb: { message?: string; data?: Record<string, string> }) => {
        capturedCrumbs.push(crumb);
      },
    });
  }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);
  return captures;
}

describe('wm-session mint failure cause (WORLDMONITOR-WG)', () => {
  function isDegraded(resp: Response): boolean {
    return resp.status === 503 && resp.headers.get('X-Wm-Session-Degraded') === '1';
  }

  it('does NOT black out the session when a single mint fails at the transport level', async () => {
    // The whole bug in one assertion: one network blip on one route must not
    // suppress every anonymous API call for 15 minutes.
    memoryStorage.clear();
    const captures = captureSink();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    } finally {
      console.warn = originalWarn;
    }

    // Assert on the blackout itself, not on a follow-up route's status: a second
    // route would corroborate and trip the quorum, so its response would be a
    // plain 401 either way and could not tell the two behaviours apart.
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(
      dead.length,
      0,
      'one transport-level mint failure must not start a 15-minute degraded episode',
    );
    // And the session must genuinely still be usable, not merely unreported.
    const publicRead = await wrappedFetch('https://api.worldmonitor.app/api/health?compact=1');
    assert.equal(isDegraded(publicRead), false, 'anonymous calls must not be suppressed yet');
  });

  it('retries the mint once when the failure is transport-level', async () => {
    memoryStorage.clear();
    captureSink();

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    } finally {
      console.warn = originalWarn;
    }

    // preflight mint + recovery mint + ONE transport retry.
    assert.equal(mintCalls, 3, 'a transport failure earns exactly one retry, not zero and not a loop');
  });

  it('still blacks out immediately when the SERVER refuses to mint', async () => {
    // Regression guard for the case the original design was written for: a real
    // server refusal IS session-wide, and must keep skipping the quorum.
    memoryStorage.clear();
    const captures = captureSink();

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
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      const other = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(isDegraded(other), true, 'a server refusal still suppresses anonymous calls');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(mintCalls, 2, 'a refusal is NOT retried — the server answered, it just said no');
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.reason, 'mint_failed');
    assert.equal(dead[0].ctx.tags?.mint_cause, 'refused', 'the discriminator that makes WG diagnosable');
  });

  it('treats a 200 with an unusable body as a SERVER verdict, not a transport failure', async () => {
    // The server answered — it just answered with something we cannot use. That
    // is session-wide like a refusal, so it must skip the quorum AND skip the
    // retry: re-asking an endpoint that just replied nonsense gets more nonsense.
    // Without this test the malformed/network classification is interchangeable.
    memoryStorage.clear();
    const captures = captureSink();

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        // 200, valid JSON, but no usable expiry.
        return Promise.resolve(new Response(JSON.stringify({ hadSession: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      const other = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(isDegraded(other), true, 'an unusable mint body is session-wide');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(mintCalls, 2, 'a malformed body is NOT retried — the server already answered');
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.mint_cause, 'malformed');
  });

  it('classifies an unparseable mint body as malformed, not network', async () => {
    // A body that is not JSON at all throws inside resp.json(). That throw lands
    // in the same catch as a dropped connection, so without an inner guard it
    // would be reported as `network` and wrongly earn a retry.
    memoryStorage.clear();
    const captures = captureSink();

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response('<html>gateway error</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(mintCalls, 2, 'an unparseable body is not a transport failure, so it is not retried');
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'and it is session-wide immediately');
    assert.equal(dead[0].ctx.tags?.mint_cause, 'malformed');
  });

  it('blacks out on a transport failure only once TWO routes corroborate', async () => {
    memoryStorage.clear();
    const captures = captureSink();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      const third = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(isDegraded(third), true, 'two corroborating routes DO justify the blackout');
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one capture per degraded episode');
    assert.equal(dead[0].ctx.tags?.reason, 'mint_failed');
    assert.equal(dead[0].ctx.tags?.mint_cause, 'network');
    assert.equal(dead[0].ctx.tags?.route, '/api/wm-session', 'the mint is implicated, not a bystander route');
  });

  it('distinguishes a timeout from a network error', async () => {
    // These need different remedies — a timeout points at our own budget, a
    // network error points at the user's connectivity — so one tag must not
    // stand for both.
    memoryStorage.clear();
    const captures = captureSink();
    mod.__setWmSessionFetchTimeoutForTests(20);

    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        // Never settles on its own — only the abort signal ends it, which is
        // exactly how a hung mint behaves against the production budget.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.mint_cause, 'timeout', 'an aborted mint is a timeout, not a network error');
  });
});

describe('wm-session cookie-persistence detection (Layer 3)', () => {
  it('mints on browsers that do not implement AbortSignal.timeout', async () => {
    memoryStorage.clear();
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: 'wms_legacy-browser-token',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: undefined,
    });
    try {
      assert.equal(
        await mod.ensureWmSession(),
        true,
        'missing AbortSignal.timeout must not fail before the mint request is dispatched',
      );
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('still aborts a stalled mint without AbortSignal.timeout', async () => {
    memoryStorage.clear();
    mod.__setWmSessionFetchTimeoutForTests(5);
    currentFetchHandler = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, 'the compatible timeout must pass an AbortSignal');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

    assert.equal(await mod.ensureWmSession(), false, 'a stalled mint must fail closed after the timeout');
  });

  it('falls back to the anonymous session header once the cookie proves unstorable', async () => {
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        addBreadcrumb: () => {},
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    let mints = 0;
    const fallbackToken = 'wms_header-fallback-token';
    let premiumFallbackHeader: string | null = null;
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mints += 1;
        // The browser stores nothing, so EVERY mint arrives without a cookie.
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: fallbackToken,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      const headers = new Headers(init?.headers);
      if (url.includes('/api/market/v1/analyze-stock')) {
        premiumFallbackHeader = headers.get('X-WorldMonitor-Key');
        return Promise.resolve(new Response('premium auth remains separate', { status: 401 }));
      }
      if (headers.get('X-WorldMonitor-Key') === 'wm_explicit-user-key') {
        return Promise.resolve(new Response('explicit user key preserved', { status: 200 }));
      }
      return Promise.resolve(headers.get('X-WorldMonitor-Key') === fallbackToken
        ? new Response('header session accepted', { status: 200 })
        : new Response('no cookie presented', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const recovered = await wrappedFetch('https://api.worldmonitor.app/api/conflict/v1/get-humanitarian-summary-batch');
      assert.equal(recovered.status, 200, 'the request that proves cookie loss must recover through the header');
      const afterFirstRoute = mints;
      const next = await wrappedFetch('https://api.worldmonitor.app/api/military/v1/get-aircraft-details-batch');
      assert.equal(next.status, 200, 'later requests must use the in-memory anonymous header token');
      assert.equal(
        mints,
        afterFirstRoute,
        'a cookie proven unstorable must not require another mint for the next route',
      );
      const explicit = await wrappedFetch(
        'https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health',
        { headers: { 'X-WorldMonitor-Key': 'wm_explicit-user-key' } },
      );
      assert.equal(explicit.status, 200, 'an explicit user key must outrank the anonymous fallback');

      const premium = await wrappedFetch('https://api.worldmonitor.app/api/market/v1/analyze-stock');
      assert.equal(premium.status, 401, 'premium auth remains owned by its dedicated injector');
      assert.equal(
        premiumFallbackHeader,
        null,
        'the anonymous fallback must never be injected into a premium route',
      );
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 0, 'a working header fallback is not a dead-session episode');
    assert.equal(mod.isWmSessionDead(), false, 'cookie rejection must not black out anonymous data');
  });

  it('activates the header fallback for concurrent recovery after a reload drops the cookie', async () => {
    memoryStorage.clear();
    memoryStorage.set('wm-session-exp', JSON.stringify({ exp: FAR_FUTURE }));

    let mints = 0;
    const fallbackToken = 'wms_concurrent-reload-token';
    const routeAttempts = new Map<string, number>();
    currentFetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mints += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: false,
          token: fallbackToken,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const attempts = (routeAttempts.get(url) ?? 0) + 1;
      routeAttempts.set(url, attempts);
      const headers = new Headers(init?.headers);
      return headers.get('X-WorldMonitor-Key') === fallbackToken
        ? new Response('header session accepted', { status: 200 })
        : new Response('cookie missing after reload', { status: 401 });
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const [first, second] = await Promise.all([
        wrappedFetch('https://api.worldmonitor.app/api/conflict/v1/get-humanitarian-summary-batch'),
        wrappedFetch('https://api.worldmonitor.app/api/military/v1/get-aircraft-details-batch'),
      ]);

      assert.equal(first.status, 200, 'the recovery leader must replay with the minted fallback token');
      assert.equal(second.status, 200, 'the recovery follower must share the same working fallback');
      assert.equal(mints, 1, 'concurrent recovery must share exactly one mint');
      assert.equal(mod.isWmSessionDead(), false, 'successful fallback recovery must not enter cooldown');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not accuse a brand-new browser whose first mint legitimately carries no cookie', async () => {
    // Every first-time visitor mints without a cookie. Reading that as
    // non-persistence would black out the whole anonymous surface on arrival.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        addBreadcrumb: () => {},
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        // First mint: no cookie yet, which is normal and not evidence of anything.
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE, hadSession: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const resp = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en');
    assert.equal(resp.status, 200, 'a working first-visit session must be untouched');
    assert.equal(
      captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead').length,
      0,
      'a first mint without a cookie must not be reported as a dead session',
    );
    assert.equal(mod.isWmSessionDead(), false, 'a first-time visitor must not be blacked out');
  });
});

describe('wm-session cookie-persistence detection — concurrent mints', () => {
  it('does not accuse the browser when an anonymous mint and a key-session mint overlap', async () => {
    // The real page-boot shape: widget-store.ts and user-identity.ts both fire
    // migrateLegacyKeysToHttpOnlySession() fire-and-forget (`void`) at module
    // init, and establishWmKeySession bypasses ensureWmSession's `inflight`
    // dedupe — so two mints leave before EITHER response installs a cookie.
    // Both then honestly report hadSession:false, and reading the second one as
    // proof of non-persistence would black out a perfectly healthy session.
    memoryStorage.clear();

    const captures: Array<{ ctx: { tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({
        addBreadcrumb: () => {},
        captureMessage: (_m: string, ctx: { tags?: Record<string, string> }) => { captures.push({ ctx }); },
      });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    const release: Array<() => void> = [];
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return new Promise((resolve) => {
          release.push(() => resolve(new Response(
            JSON.stringify({ exp: FAR_FUTURE, hadSession: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const anon = mod.ensureWmSession();
      const keyed = mod.establishWmKeySession({ proKey: 'legacy-pro-key' });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(release.length, 2, 'both mints must be in flight before either resolves');

      // Harmful ordering: the key-session response lands first and marks a
      // cookie as issued, so the anonymous response — sent before that cookie
      // existed — looks like a second mint that came back empty.
      release[1]();
      await keyed;
      release[0]();
      await anon;
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      mod.isWmSessionDead(),
      false,
      'two mints that overlapped in flight are not evidence that the browser dropped a cookie',
    );
    assert.equal(
      captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead').length,
      0,
      'an in-flight overlap must not report a dead session',
    );
  });
});

describe('wm-session mint cause provenance (#6804)', () => {
  // A response the test releases by hand, so a request can still be in flight
  // at the exact moment an unrelated route declares the session dead. That is
  // the only way into recovery while the cooldown is already engaged — every
  // request that STARTS after the blackout is short-circuited far earlier.
  function deferredResponse(): { promise: Promise<Response>; resolve: (r: Response) => void } {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((res) => { resolve = res; });
    return { promise, resolve };
  }

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    return input instanceof URL ? input.href : input.url;
  }

  it('does not re-arm the cooldown from a recovery that attempted no mint', async () => {
    // The session is already suppressed, so ensureWmSession() returns false
    // from its very first line without asking the server for anything. Reading
    // that as `mint_failed` runs markWmSessionDead again, and markWmSessionDead
    // pushes sessionDeadUntil out by a fresh 15 minutes BEFORE its
    // already-dead early return — so every request that happened to be in
    // flight when the blackout landed silently lengthens it.
    memoryStorage.clear();
    const captures = captureSink();
    const gate = deferredResponse();
    let bystanderSent = 0;

    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response('mint unavailable', { status: 503 }));
      }
      if (url.includes('get-vessel-snapshot')) {
        bystanderSent += 1;
        return gate.promise;
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const realNow = Date.now;
    let skewMs = 0;
    Date.now = () => realNow.call(Date) + skewMs;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const bystander = wrappedFetch('https://api.worldmonitor.app/api/maritime/v1/get-vessel-snapshot');
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(bystanderSent, 1, 'the bystander must be in flight before the blackout is declared');

      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(mod.isWmSessionDead(), true, 'a server refusal blacks out immediately');

      // Ten minutes into the 15-minute cooldown, the bystander's answer lands.
      skewMs = 10 * 60 * 1000;
      gate.resolve(new Response('unauthorized', { status: 401 }));
      const resp = await bystander;
      assert.equal(resp.status, 401, "an in-flight request still gets the server's own answer");

      // One minute past the cooldown the blackout actually earned.
      skewMs = 16 * 60 * 1000;
      assert.equal(
        mod.isWmSessionDead(),
        false,
        'a suppressed call attempted no mint, so it must not extend the blackout it was suppressed by',
      );
    } finally {
      console.warn = originalWarn;
      Date.now = realNow;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'one blackout, reported once');
  });

  it('does not strike a bystander route for a mint that was never attempted', async () => {
    // Same suppressed path, transport flavour. `lastMintFailureCause` still
    // holds `network` from the mints that produced the blackout, so the
    // bystander's non-attempt inherits a cause it never earned and is filed as
    // corroborating evidence — suppressing an innocent route for 15 minutes.
    memoryStorage.clear();
    const captures = captureSink();
    const gate = deferredResponse();
    let bystanderSent = 0;

    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) return Promise.reject(new TypeError('Failed to fetch'));
      if (url.includes('get-vessel-snapshot')) {
        bystanderSent += 1;
        return gate.promise;
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const bystander = wrappedFetch('https://api.worldmonitor.app/api/maritime/v1/get-vessel-snapshot');
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(bystanderSent, 1, 'the bystander must be in flight before the blackout is declared');

      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(mod.isWmSessionDead(), true, 'two corroborating transport failures justify the blackout');

      gate.resolve(new Response('unauthorized', { status: 401 }));
      assert.equal((await bystander).status, 401);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      mod.getStruckRoutes(),
      [],
      'a route that merely happened to be in flight must not be struck by a mint nobody attempted',
    );
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'one blackout, reported once');
  });

  it('tags a retry_401 blackout with an explicit mint_cause', async () => {
    // The tag was written conditionally, so "this episode had no mint cause"
    // and "the tag was dropped" produced the same blank bucket in Sentry and
    // could not be told apart. Emit it always.
    memoryStorage.clear();
    const captures = captureSink();

    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({
          exp: FAR_FUTURE,
          hadSession: true,
          token: 'wms_retry-quorum-token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.reason, 'retry_401');
    assert.equal(
      dead[0].ctx.tags?.mint_cause,
      'none',
      'a route denial has no mint cause, and saying so is not the same as saying nothing',
    );
    // The breadcrumb carries the same fields for the same reason, and is what
    // survives when a later capture is suppressed. Locked separately: the tag
    // and the crumb were changed in lockstep, so one assertion cannot hold both.
    const crumb = capturedCrumbs.filter((c) => c.message === 'wm-session recovery failed').at(-1);
    assert.equal(crumb?.data?.mint_cause, 'none', 'the breadcrumb states it too');
  });

  it('keeps cookie_not_persisted as its own verdict rather than a causeless mint_failed', async () => {
    // The mint SUCCEEDED here — the browser then refused to keep the cookie.
    // markWmSessionDead already recorded that verdict, so the recovery caller
    // must not relabel the same episode `mint_failed` on its way out.
    //
    // Asserting the tags alone would NOT prove that: markWmSessionDead's
    // already-dead early return swallows a second capture, and one route cannot
    // reach the corroboration quorum, so every tag assertion stays green with
    // the guard removed. Two observables have teeth here and both are checked
    // below — the cooldown must not be re-armed (the clock is advanced inside
    // the first capture so a second verdict would land 10 minutes later), and
    // the route whose 401 triggered recovery must not be struck by a mint that
    // succeeded.
    memoryStorage.clear();
    const realNow = Date.now;
    let skewMs = 0;
    Date.now = () => realNow.call(Date) + skewMs;
    const captures = captureSink(() => { skewMs = 10 * 60 * 1000; });

    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) {
        // Every mint answers normally and reports no incoming cookie, with no
        // header token to fall back to.
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE, hadSession: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/maritime/v1/get-vessel-snapshot');
      assert.equal(resp.status, 401);

      // One minute past the cooldown the cookie_not_persisted verdict earned.
      // A relabel would have re-armed it from the skewed clock, to t+25min.
      skewMs = 16 * 60 * 1000;
      assert.equal(
        mod.isWmSessionDead(),
        false,
        'a second, redundant verdict for the same episode must not extend the blackout',
      );
    } finally {
      console.warn = originalWarn;
      Date.now = realNow;
    }

    assert.deepEqual(
      mod.getStruckRoutes(),
      [],
      'a mint that SUCCEEDED must not strike the route whose 401 triggered recovery',
    );
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'one episode, one verdict');
    assert.equal(dead[0].ctx.tags?.reason, 'cookie_not_persisted');
    assert.equal(
      dead[0].ctx.tags?.mint_cause,
      'none',
      'a mint that succeeded has no failure cause, and the tag must say so',
    );
  });

  it('reports a thrown attempt as mint_cause unknown, and does not black out on it', async () => {
    // `new AbortController()` and the timeout setTimeout sit OUTSIDE
    // mintSession's try — on the old WebView / Smart-TV engines the
    // AbortSignal.timeout comment names, a throw there rejects the whole
    // attempt. The old code read the stale (usually null) module-scoped cause,
    // failed the transport test, and blacked out every anonymous call for 15
    // minutes over a client-side throw. It must now take the same corroboration
    // route a transport blip does, and say `unknown` rather than nothing.
    memoryStorage.clear();
    const captures = captureSink();
    const realAbortController = globalThis.AbortController;
    const boom = new Error('AbortController is not a constructor');
    // A class, not a function expression: `new AbortController()` needs a
    // constructible, and an arrow would throw the engine's own TypeError
    // instead of the sentinel the exception assertion below looks for.
    (globalThis as unknown as { AbortController: unknown }).AbortController = class {
      constructor() { throw boom; }
    };

    currentFetchHandler = () => Promise.resolve(new Response('unauthorized', { status: 401 }));

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const first = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(first.status, 401, "the server's own answer is handed back");
      assert.equal(
        mod.isWmSessionDead(),
        false,
        'one client-side throw is not a server verdict and must not black out the tab',
      );
      assert.deepEqual(
        mod.getStruckRoutes(),
        ['/api/infrastructure/v1/get-cable-health'],
        'it still counts as evidence against its own route',
      );

      // A second distinct route inside the corroboration window is what earns
      // the blackout — the same rule a transport failure follows.
      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(mod.isWmSessionDead(), true, 'two corroborating routes do justify it');
    } finally {
      console.warn = originalWarn;
      (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = realAbortController;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one capture per degraded episode');
    assert.equal(dead[0].ctx.tags?.reason, 'mint_failed');
    assert.equal(
      dead[0].ctx.tags?.mint_cause,
      'unknown',
      'a throw is a distinct cause, not a blank tag and not a server refusal',
    );
    assert.ok(
      capturedExceptions.includes(boom),
      'the exception itself must be reported — `unknown` alone tells on-call nothing',
    );
  });

  it('leaves session state alone when a key-session mint is refused', async () => {
    // establishWmKeySession moved from the deleted fetchNewSession wrapper to
    // mintSession. Its failure path touches none of the identity/state resets.
    memoryStorage.clear();
    captureSink();
    currentFetchHandler = () => Promise.resolve(new Response('mint unavailable', { status: 503 }));

    assert.equal(await mod.establishWmKeySession({ proKey: 'legacy-pro-key' }), false);
    assert.equal(mod.isWmSessionDead(), false, 'a refused key mint is not a blackout');
    assert.deepEqual(mod.getStruckRoutes(), [], 'and it strikes no route');
  });

  it('does not let a cookie-less follower replay tip a transport-mint blackout', async () => {
    // The modal WORLDMONITOR-WG residual (USNI + vessel-snapshot on 2026-08-18):
    // a dashboard boot burst plus a flaky transport. The leader's mint fails
    // and records strike #1; the follower then replays with NO cookie (none
    // was ever minted), so its 401 is guaranteed rather than evidential.
    // Counting that as retry_401 tipped the quorum and blanked every anonymous
    // panel for 15 minutes over a mint that never issued a session.
    //
    // Two *independent* mint failures still corroborate (the sequential
    // "TWO routes corroborate" test above). A shared recovery plus a
    // cookie-less replay must not.
    memoryStorage.clear();
    const captures = captureSink();

    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await Promise.all([
        wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health'),
        wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series'),
      ]);
      assert.equal(
        mod.isWmSessionDead(),
        false,
        'a guaranteed cookie-less 401 must not corroborate a transport mint failure',
      );
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 0, 'no blackout — the mint never issued a session');
  });

  it('remints after a failed reload remint instead of treating stored exp as success', async () => {
    // Reload leaves sessionStorage `{exp}` and no in-memory wms_ token.
    // Writing that expiry into `cached` *before* the remint meant a
    // transport failure left the next ensureWmSession looking fresh, so
    // every follow-up RPC went cookie-only and 401'd (WORLDMONITOR-XP/WG).
    memoryStorage.set('wm-session-exp', JSON.stringify({ exp: FAR_FUTURE }));
    captureSink();

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = urlOf(input);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/military/v1/get-usni-fleet-report');
      const mintsAfterFirst = mintCalls;
      await wrappedFetch('https://api.worldmonitor.app/api/maritime/v1/get-vessel-snapshot');
      assert.ok(
        mintCalls > mintsAfterFirst,
        'a leftover stored exp must not skip remint on the next route',
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
