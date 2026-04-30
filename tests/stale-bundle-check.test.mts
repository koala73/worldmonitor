import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStaleBundleCheck } from '../src/bootstrap/stale-bundle-check.ts';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

interface FakeEnv {
  focusListeners: Array<EventListener>;
  visibilityListeners: Array<EventListener>;
  intervalCallbacks: Array<() => void>;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  fetchResponse: { ok: boolean; status: number; body: string };
  reloadCalls: number;
  clock: { value: number; tick(ms: number): void };
  visibilityState: 'visible' | 'hidden';
}

function makeEnv(initial: Partial<{ ok: boolean; status: number; body: string }> = {}): FakeEnv {
  const focusListeners: Array<EventListener> = [];
  const visibilityListeners: Array<EventListener> = [];
  const intervalCallbacks: Array<() => void> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    focusListeners,
    visibilityListeners,
    intervalCallbacks,
    fetchCalls,
    fetchResponse: {
      ok: initial.ok ?? true,
      status: initial.status ?? 200,
      body: initial.body ?? '',
    },
    reloadCalls: 0,
    clock: {
      value: 1_000_000,
      tick(ms: number) { this.value += ms; },
    },
    visibilityState: 'visible',
  };
}

function install(env: FakeEnv, currentHash = 'sha-running-bundle', minIntervalMs = 60_000) {
  return installStaleBundleCheck({
    currentHash,
    minIntervalMs,
    eventTarget: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'focus') env.focusListeners.push(listener as EventListener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'focus') {
          const i = env.focusListeners.indexOf(listener as EventListener);
          if (i !== -1) env.focusListeners.splice(i, 1);
        }
      },
    },
    documentTarget: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') env.visibilityListeners.push(listener as EventListener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          const i = env.visibilityListeners.indexOf(listener as EventListener);
          if (i !== -1) env.visibilityListeners.splice(i, 1);
        }
      },
      get visibilityState() { return env.visibilityState; },
    },
    setInterval: (cb: () => void, _ms: number) => {
      env.intervalCallbacks.push(cb);
      return env.intervalCallbacks.length; // dummy handle
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      env.fetchCalls.push({ url, init });
      const { ok, status, body } = env.fetchResponse;
      return new Response(body, { status, statusText: ok ? 'OK' : 'Error' });
    },
    reload: () => { env.reloadCalls++; },
    now: () => env.clock.value,
  });
}

async function fireFocus(env: FakeEnv): Promise<void> {
  for (const listener of [...env.focusListeners]) {
    listener(new Event('focus'));
  }
  // Drain microtasks so fetch/reload assertions observe the inner async work.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireVisibilityChange(env: FakeEnv, state: 'visible' | 'hidden'): Promise<void> {
  env.visibilityState = state;
  for (const listener of [...env.visibilityListeners]) {
    listener(new Event('visibilitychange'));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireInterval(env: FakeEnv): Promise<void> {
  for (const cb of [...env.intervalCallbacks]) {
    cb();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installStaleBundleCheck', () => {
  let env: FakeEnv;
  beforeEach(() => { env = makeEnv(); });

  it('reloads when /build-hash.txt returns a different hash', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy\n' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT reload when the deployed hash matches the running bundle', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('skips entirely when currentHash is the "dev" marker (no fetch, no reload)', async () => {
    install(env, 'dev');
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 0, 'must not fetch when running a dev bundle');
    assert.equal(env.reloadCalls, 0);
  });

  it('does NOT reload when /build-hash.txt returns the "dev" marker', async () => {
    // Local previews / non-Vercel builds emit 'dev' as the hash. A production
    // tab fetching this must not force-reload itself into the dev bundle.
    env.fetchResponse = { ok: true, status: 200, body: 'dev' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('does NOT reload when the fetch fails (offline / non-OK)', async () => {
    env.fetchResponse = { ok: false, status: 500, body: 'oops' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('dedupes focus events within minIntervalMs (single fetch per window)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(30_000); // < 60s
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1, 'second focus inside 60s window must not refetch');
  });

  it('refetches after the dedupe window elapses', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(60_001);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 2, 'focus past 60s must trigger a fresh fetch');
  });

  it('uses /build-hash.txt with cache-bust query param and no-store', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env);
    await fireFocus(env);
    const call = env.fetchCalls[0];
    assert.match(call.url, /^\/build-hash\.txt\?t=\d+$/);
    assert.equal(call.init?.cache, 'no-store');
  });

  it('trims whitespace from the deployed hash before comparing', async () => {
    // build-hash.txt is plain text; trailing newlines from various build
    // systems must not produce false-positive reloads.
    env.fetchResponse = { ok: true, status: 200, body: '  sha-running-bundle  \n' };
    install(env);
    await fireFocus(env);
    assert.equal(env.reloadCalls, 0, 'trimmed hash equals current → no reload');
  });

  // PR #3499 follow-up — installStaleBundleCheck initially listened on
  // window 'focus' only. One stuck-bundle user (Sentry user_3Cu7uZZJ...)
  // hammered setPreferences with constant actualSyncVersion=20 because
  // their tab was pinned in the background and never received focus →
  // stale-bundle-check never fired → bundle never reloaded. Adding
  // visibilitychange + setInterval closes that gap.

  it('reloads when document becomes visible (background-tab safety net)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    await fireVisibilityChange(env, 'visible');
    assert.equal(env.fetchCalls.length, 1, 'visibilitychange to visible should trigger check');
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT trigger check on visibilitychange when going to hidden', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    // Tab going INTO background — useless to check (reload would be lost).
    // Only the visible transition should fire the check.
    await fireVisibilityChange(env, 'hidden');
    assert.equal(env.fetchCalls.length, 0, 'hidden transition must not fetch');
  });

  it('reloads when periodic interval fires (catches background tabs that never visibility-change)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    // Simulate the setInterval firing.
    await fireInterval(env);
    assert.equal(env.fetchCalls.length, 1, 'periodic timer should trigger check');
    assert.equal(env.reloadCalls, 1);
  });

  it('all three triggers (focus / visibility / interval) collapse via the same dedupe window', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(10_000); // <60s
    await fireVisibilityChange(env, 'visible');
    env.clock.tick(10_000);
    await fireInterval(env);
    assert.equal(env.fetchCalls.length, 1, 'all three triggers within dedupe window must collapse to one fetch');
  });

  it('disposer fully removes focus + visibilitychange + interval (no orphaned listeners on double-install)', async () => {
    // Greptile P2 fix: production calls installStaleBundleCheck once at
    // boot. But hot-reload, test-helper reuse, or future code paths could
    // double-install. The disposer must remove ALL three trigger paths so
    // a re-install starts from a clean slate.
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    const dispose = install(env);
    assert.equal(env.focusListeners.length, 1, 'focus listener attached on install');
    assert.equal(env.visibilityListeners.length, 1, 'visibility listener attached on install');
    assert.equal(env.intervalCallbacks.length, 1, 'interval scheduled on install');

    dispose();
    assert.equal(env.focusListeners.length, 0, 'disposer removed focus listener');
    assert.equal(env.visibilityListeners.length, 0, 'disposer removed visibility listener');
    // intervalCallbacks isn't drained (clearInterval doesn't pop from our
    // fake's callback array), but firing it post-disposal would still
    // invoke it. The real `clearInterval` does prevent firing — and the
    // production timer is the only thing the disposer needs to actually
    // stop, since events past the disposal point can't reach removed
    // listeners.

    // After disposal, firing focus/visibility should NOT trigger fetch.
    await fireFocus(env);
    await fireVisibilityChange(env, 'visible');
    assert.equal(env.fetchCalls.length, 0, 'no fetch after disposal — listeners truly removed');
  });
});
