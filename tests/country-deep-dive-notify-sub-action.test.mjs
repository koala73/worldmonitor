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
