// A chunk that fails on every load must cost at most one reload per
// build, never a reload loop. Each "page load" below imports a fresh instance of
// the guard module, because a real reload discards the JS heap: only what the
// browser storage kept survives.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { claimSentryPreloadErrors } from '../src/bootstrap/sentry-defer';

type GuardModule = typeof import('../src/bootstrap/chunk-reload');

interface FakeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

let loadCounter = 0;
async function freshGuardModule(): Promise<GuardModule> {
  loadCounter += 1;
  return import(`../src/bootstrap/chunk-reload.ts?page-load=${loadCounter}`) as Promise<GuardModule>;
}

/** Let the guard's post-dispatch microtask run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
}
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/**
 * One page load of `version` on which a chunk fails, with the guard reading
 * browser storage from `window` the way main.ts installs it. Returns whether
 * the page reloaded.
 */
async function pageLoadWithChunkFailure(version: string): Promise<boolean> {
  const { installChunkReloadGuard } = await freshGuardModule();
  const target = new EventTarget();
  let reloaded = false;
  installChunkReloadGuard(version, { eventTarget: target, reload: () => { reloaded = true; } });
  target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  return reloaded;
}

async function countReloads(loads: number, version = 'build-A'): Promise<number> {
  let reloads = 0;
  for (let i = 0; i < loads; i += 1) {
    if (await pageLoadWithChunkFailure(version)) reloads += 1;
  }
  return reloads;
}

describe('chunk reload guard across page loads', () => {
  it('reloads once per build when the chunk fails on every load', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('gives a new build its own single reload', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    assert.equal(await countReloads(3, 'build-A'), 1);
    assert.equal(await countReloads(3, 'build-B'), 1);
  });

  it('falls back to localStorage when sessionStorage is null (Android WebView)', async () => {
    setWindow({ sessionStorage: null, localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('never reloads when no storage can keep the record across the reload', async () => {
    setWindow({ sessionStorage: null, localStorage: null });
    assert.equal(await countReloads(5), 0);
  });

  it('falls back when sessionStorage rejects writes', async () => {
    const readOnly: FakeStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => {},
    };
    setWindow({ sessionStorage: readOnly, localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('stands down when another listener claims the failure with preventDefault', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const { installChunkReloadGuard } = await freshGuardModule();
    const target = new EventTarget();
    let reloads = 0;
    // Registered first, as main.ts registers it before any lazy loader runs.
    installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
    target.addEventListener('vite:preloadError', (event) => event.preventDefault());
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    await settle();
    assert.equal(reloads, 0);
  });
});

describe('deferred Sentry loader claims its own chunk failures', () => {
  /** What Vite's __vitePreload does when the wrapped import() rejects. */
  function vitePreloadFailure(target: EventTarget, error: Error): Promise<undefined> {
    const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: error });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) return Promise.reject(error);
    return Promise.resolve(undefined);
  }

  async function sentryLoadAttempt(target: EventTarget, error: Error): Promise<unknown> {
    try {
      await claimSentryPreloadErrors(async () => {
        const mod = await vitePreloadFailure(target, error);
        // The destructure in defaultSentryLoader hits `undefined` here.
        return (mod as unknown as { loadAndInitSentry: () => unknown }).loadAndInitSentry();
      }, target);
    } catch (thrown) {
      return thrown;
    }
    return null;
  }

  it('a blocked Sentry chunk never reloads the page, on any load', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const blocked = new TypeError(
      'Failed to fetch dynamically imported module: https://www.worldmonitor.app/assets/sentry-init-AbC12345.js',
    );
    let reloads = 0;
    for (let i = 0; i < 3; i += 1) {
      const { installChunkReloadGuard } = await freshGuardModule();
      const target = new EventTarget();
      installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
      const thrown = await sentryLoadAttempt(target, blocked);
      assert.equal(thrown, blocked, 'the loader rethrows the original import error');
      await settle();
    }
    assert.equal(reloads, 0);
  });

  it('leaves a URL-less failure (Safari) to the guard, which reloads once', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const safari = new TypeError('Importing a module script failed.');
    let reloads = 0;
    for (let i = 0; i < 3; i += 1) {
      const { installChunkReloadGuard } = await freshGuardModule();
      const target = new EventTarget();
      installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
      // Unclaimed, so Vite rejects with the original error.
      assert.equal(await sentryLoadAttempt(target, safari), safari);
      await settle();
    }
    assert.equal(reloads, 1, 'it may be an unrelated chunk such as App, so it keeps its one reload');
  });

  it('leaves another chunk failure during the Sentry load to the guard', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const { installChunkReloadGuard } = await freshGuardModule();
    const target = new EventTarget();
    let reloads = 0;
    installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
    const stale = new TypeError(
      'Failed to fetch dynamically imported module: https://www.worldmonitor.app/assets/MarketPanel-Xy98765.js',
    );
    assert.equal(await sentryLoadAttempt(target, stale), stale);
    await settle();
    assert.equal(reloads, 1);
  });

  it('stops claiming once the Sentry load settles', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const { installChunkReloadGuard } = await freshGuardModule();
    const target = new EventTarget();
    let reloads = 0;
    installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
    await claimSentryPreloadErrors(async () => 'loaded', target);
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    await settle();
    assert.equal(reloads, 1);
  });
});
