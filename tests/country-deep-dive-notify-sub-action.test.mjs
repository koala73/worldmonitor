/**
 * Tests for src/utils/notify-country-link.ts (U8, degraded path).
 *
 * The Country Deep Dive panel mounts this helper alongside the
 * FollowButton. It's visible only when the user is currently following
 * the country, hidden otherwise. Click → calls the open-helper which
 * (in production) dispatches a window CustomEvent the App listens for
 * and forwards to `unifiedSettings.open('notifications')`.
 *
 * This PR is the degraded path — no alertRules schema field exists yet,
 * so there is no pre-fill. We test the visibility / click / event
 * contract; the future PR will assert the pre-fill payload.
 *
 * Mirrors the host-stub shape from `tests/follow-button.test.mjs` and
 * `tests/followed-only-chip.test.mjs` so we exercise the helper under
 * the project's `node:test` runner without jsdom.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {}

let _localStorage;
let _window;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    };
  }
});

after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

const linkMod = await import('../src/utils/notify-country-link.ts');
const {
  renderNotifyCountryLink,
  WM_OPEN_NOTIFICATIONS_FOR_COUNTRY,
  _setOpenNotificationsForCountryForTests,
} = linkMod;

// ---------------------------------------------------------------------------
// Mock host
// ---------------------------------------------------------------------------

function makeHost() {
  const listeners = new Map();
  let _innerHtml = '';
  const host = {
    set innerHTML(v) {
      _innerHtml = String(v);
    },
    get innerHTML() {
      return _innerHtml;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    /**
     * Fire a synthetic click on the rendered link. The handler resolves
     * the link via `target.closest('.cdp-notify-link')`.
     */
    clickLink() {
      const isPresent = _innerHtml.includes('class="cdp-notify-link');
      const buttonStub = {
        closest: (sel) =>
          sel === '.cdp-notify-link' && isPresent ? buttonStub : null,
      };
      const ev = {
        type: 'click',
        target: buttonStub,
        preventDefault: () => {},
      };
      const set = listeners.get('click');
      if (set) for (const h of set) h(ev);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupAnonymousFlagOn() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

function setupAnonymousFlagOff() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: false,
    convexClient: null,
    convexApi: null,
  });
}

function seedFollowed(countries) {
  _localStorage.setItem(
    FOLLOWED_COUNTRIES_STORAGE_KEY,
    JSON.stringify({ countries }),
  );
}

beforeEach(() => {
  _localStorage.clear();
  _resetStateForTests();
  _setOpenNotificationsForCountryForTests(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderNotifyCountryLink — visibility', () => {
  it('not following → empty html, no link rendered', () => {
    setupAnonymousFlagOn();
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    assert.equal(handle.html, '');
  });

  it('following → renders the inline link with bell icon and label', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    assert.match(handle.html, /class="cdp-notify-link"/);
    assert.match(handle.html, /Notify me about US/);
    // Bell icon SVG present.
    assert.match(handle.html, /class="cdp-notify-link-icon"/);
  });

  it('following with countryName → uses display name in label / aria', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const handle = renderNotifyCountryLink({
      countryCode: 'US',
      countryName: 'United States',
    });
    assert.match(handle.html, /Notify me about United States/);
    assert.match(handle.html, /aria-label="Notify me about United States"/);
  });

  it('feature flag off → empty html, attach is a no-op', () => {
    setupAnonymousFlagOff();
    seedFollowed(['US']); // even when followed
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    assert.equal(handle.html, '');
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.equal(host.listenerCount('click'), 0);
    teardown();
    teardown(); // idempotent
  });
});

describe('renderNotifyCountryLink — reactivity to follow state', () => {
  it('host renders empty when not following, then re-renders when followed', () => {
    setupAnonymousFlagOn();
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    // Initial: not following → empty.
    assert.equal(host.innerHTML, '');

    // External actor follows US + dispatches the change event.
    seedFollowed(['US']);
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.match(host.innerHTML, /class="cdp-notify-link"/);
    teardown();
  });

  it('host renders link when following, then clears when unfollowed', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.match(host.innerHTML, /class="cdp-notify-link"/);

    // External actor unfollows + dispatches.
    seedFollowed([]);
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(host.innerHTML, '');
    teardown();
  });

  it('only this country drives visibility — unrelated change is no-op visual', () => {
    setupAnonymousFlagOn();
    seedFollowed(['FR']); // user follows FR, NOT US
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.equal(host.innerHTML, ''); // not following US → hidden

    // User adds GB; still not US.
    seedFollowed(['FR', 'GB']);
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(host.innerHTML, ''); // still hidden
    teardown();
  });
});

describe('renderNotifyCountryLink — click invokes open-helper', () => {
  it('click → calls the open-helper with the country code', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const calls = [];
    _setOpenNotificationsForCountryForTests((code) => calls.push(code));

    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickLink();

    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'US');
    teardown();
  });

  it('production path → click dispatches WM_OPEN_NOTIFICATIONS_FOR_COUNTRY with detail.country', () => {
    setupAnonymousFlagOn();
    seedFollowed(['GB']);
    // Use the default (production) open helper — listen for the real event.
    _setOpenNotificationsForCountryForTests(null);
    const events = [];
    const listener = (ev) => events.push(ev.detail);
    _window.addEventListener(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, listener);

    const handle = renderNotifyCountryLink({ countryCode: 'GB' });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickLink();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { country: 'GB' });

    _window.removeEventListener(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, listener);
    teardown();
  });

  it('click while not following → no-op (link is not even rendered)', () => {
    setupAnonymousFlagOn();
    // not following — handle.html is empty, host has nothing to click on.
    const calls = [];
    _setOpenNotificationsForCountryForTests((code) => calls.push(code));

    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickLink();

    // closest('.cdp-notify-link') returns null → handler short-circuits.
    assert.equal(calls.length, 0);
    teardown();
  });
});

describe('event-handlers — WM_OPEN_NOTIFICATIONS_FOR_COUNTRY listener teardown', () => {
  // Guards against a listener-leak bug: `setupUnifiedSettings` adds an
  // inline anonymous handler with `window.addEventListener(...)` that the
  // old EventHandlerManager.destroy() didn't remove. Same-document reinit
  // (HMR / test harnesses / multiple App instances) accumulated listeners
  // that retained the stale AppContext closure — every dispatched event
  // fired ALL accumulated listeners against stale state.
  //
  // We don't spin up the real EventHandlerManager (it transitively pulls
  // i18n's `import.meta.glob` which the node:test runner can't resolve).
  // Instead we simulate the install/destroy contract: a bound handler
  // field that's added in install and removed in destroy. The test asserts
  // the bug shape (N installs → N fires) on a naive setup AND that the
  // matched-pair shape (install → destroy → re-install) leaves exactly
  // ONE active listener.

  function makeFakeWindow() {
    const target = new EventTarget();
    return {
      addEventListener: (...args) => target.addEventListener(...args),
      removeEventListener: (...args) => target.removeEventListener(...args),
      dispatchEvent: (ev) => target.dispatchEvent(ev),
    };
  }

  /**
   * Mirrors EventHandlerManager's bound-field pattern.
   * Returns the (install, destroy) pair so tests can drive lifecycle.
   */
  function makeInstaller(fakeWindow, ctxLabel, fires) {
    let bound = null;
    return {
      install() {
        bound = (ev) => {
          fires.push({ ctxLabel, detail: ev?.detail ?? null });
        };
        fakeWindow.addEventListener(
          WM_OPEN_NOTIFICATIONS_FOR_COUNTRY,
          bound,
        );
      },
      destroy() {
        if (bound) {
          fakeWindow.removeEventListener(
            WM_OPEN_NOTIFICATIONS_FOR_COUNTRY,
            bound,
          );
          bound = null;
        }
      },
    };
  }

  it('BUG SHAPE: anonymous-handler installs without destroy → N installs fire N times', () => {
    // Reproduces the pre-fix behaviour: the listener added with an inline
    // anonymous function and never removed. Two sequential installs leak.
    const fakeWindow = makeFakeWindow();
    const fires = [];
    const handlerA = (ev) => fires.push({ ctxLabel: 'A', detail: ev.detail });
    const handlerB = (ev) => fires.push({ ctxLabel: 'B', detail: ev.detail });
    fakeWindow.addEventListener(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, handlerA);
    fakeWindow.addEventListener(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, handlerB);

    fakeWindow.dispatchEvent(
      new CustomEvent(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, {
        detail: { country: 'US' },
      }),
    );

    // Both listeners fire — this is the bug.
    assert.equal(fires.length, 2);
    assert.deepEqual(fires.map((f) => f.ctxLabel).sort(), ['A', 'B']);
  });

  it('FIX: install → destroy → install leaves exactly one active listener', () => {
    const fakeWindow = makeFakeWindow();
    const fires = [];
    const inst1 = makeInstaller(fakeWindow, 'ctx1', fires);
    inst1.install();
    inst1.destroy();

    const inst2 = makeInstaller(fakeWindow, 'ctx2', fires);
    inst2.install();

    fakeWindow.dispatchEvent(
      new CustomEvent(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, {
        detail: { country: 'GB' },
      }),
    );

    // Only the live ctx2 handler fires — the destroyed ctx1 is gone.
    assert.equal(fires.length, 1);
    assert.equal(fires[0].ctxLabel, 'ctx2');
    assert.deepEqual(fires[0].detail, { country: 'GB' });

    inst2.destroy();
  });

  it('FIX: destroy() is idempotent — calling twice does not throw and does not re-fire', () => {
    const fakeWindow = makeFakeWindow();
    const fires = [];
    const inst = makeInstaller(fakeWindow, 'once', fires);
    inst.install();
    inst.destroy();
    inst.destroy(); // must not throw

    fakeWindow.dispatchEvent(
      new CustomEvent(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, {
        detail: { country: 'FR' },
      }),
    );
    assert.equal(fires.length, 0, 'no listener active after destroy');
  });

  it('FIX: HMR shape — N install/destroy cycles + one live → exactly one fire', () => {
    const fakeWindow = makeFakeWindow();
    const fires = [];
    // Simulate 5 HMR-driven re-mounts.
    for (let i = 0; i < 5; i += 1) {
      const inst = makeInstaller(fakeWindow, `gen${i}`, fires);
      inst.install();
      inst.destroy();
    }
    const live = makeInstaller(fakeWindow, 'live', fires);
    live.install();

    fakeWindow.dispatchEvent(
      new CustomEvent(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, {
        detail: { country: 'JP' },
      }),
    );

    assert.equal(fires.length, 1);
    assert.equal(fires[0].ctxLabel, 'live');
    live.destroy();
  });
});

describe('renderNotifyCountryLink — teardown', () => {
  it('teardown removes click listener and unsubscribes from watchlist', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.equal(host.listenerCount('click'), 1);

    teardown();

    assert.equal(host.listenerCount('click'), 0);

    // After teardown, watchlist changes do NOT re-render the host.
    const beforeHtml = host.innerHTML;
    seedFollowed([]);
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.equal(host.innerHTML, beforeHtml);
  });

  it('teardown is idempotent', () => {
    setupAnonymousFlagOn();
    seedFollowed(['US']);
    const handle = renderNotifyCountryLink({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    teardown();
    teardown(); // does not throw
  });
});
