import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStaleBundleCheck } from '../src/bootstrap/stale-bundle-check.ts';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

interface FakeEnv {
  focusListeners: Array<EventListener>;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  fetchResponse: { ok: boolean; status: number; body: string };
  reloadCalls: number;
  clock: { value: number; tick(ms: number): void };
}

function makeEnv(initial: Partial<{ ok: boolean; status: number; body: string }> = {}): FakeEnv {
  const focusListeners: Array<EventListener> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    focusListeners,
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
  };
}

function install(env: FakeEnv, currentHash = 'sha-running-bundle', minIntervalMs = 60_000) {
  return installStaleBundleCheck({
    currentHash,
    minIntervalMs,
    eventTarget: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'focus') {
          // Normalize to EventListener for our test (object-form unused)
          env.focusListeners.push(listener as EventListener);
        }
      },
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
  // The handler awaits an inner async fn but we triggered it synchronously;
  // give the microtask queue a turn to drain so fetch/reload assertions
  // observe their calls.
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Plus an extra tick because the fetch promise + .text() chain.
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
});
