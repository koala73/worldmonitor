/**
 * Tests for U7 — "Followed only" filter chip integrated with the
 * live `getFollowed()` / `subscribe()` service contract.
 *
 * These tests exercise the real followed-country service and chip.
 * They do not simulate panel rendering.
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
  get length() {
    return this.store.size;
  }
  key(i) {
    return [...this.store.keys()][i] ?? null;
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
  isFollowed,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

const chipMod = await import('../src/utils/followed-only-chip.ts');
const { renderFollowedOnlyChip, _resetAllPersistedStateForTests } = chipMod;

// ---------------------------------------------------------------------------
// Mock host (matches followed-only-chip.test.mjs)
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
    clickChip() {
      const isDisabled = /<button[^>]*\bdisabled\b/.test(_innerHtml);
      const isPresent = _innerHtml.includes('class="wm-followed-only-chip');
      const buttonStub = {
        hasAttribute: (name) => (name === 'disabled' ? isDisabled : false),
        closest: (sel) =>
          sel === '.wm-followed-only-chip' && isPresent ? buttonStub : null,
      };
      const ev = { type: 'click', target: buttonStub, preventDefault: () => {} };
      const set = listeners.get('click');
      if (set) for (const h of set) h(ev);
    },
  };
  return host;
}

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

beforeEach(() => {
  _localStorage.clear();
  _resetStateForTests();
  _resetAllPersistedStateForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('followed-only chip and country service', () => {
  it('activates against the live followed-country state', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'panel-disease' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    assert.equal(handle.isActive(), true);
    assert.equal(isFollowed('US'), true);
    assert.equal(isFollowed('IR'), true);
    assert.equal(isFollowed('CN'), false);
  });

  it('renders disabled for an empty watchlist', () => {
    setupAnonymousFlagOn();
    const handle = renderFollowedOnlyChip({ panelId: 'panel-empty-wl' });
    const host = makeHost();
    handle.attach(host);
    assert.match(host.innerHTML, /\bdisabled\b/);
    assert.match(host.innerHTML, /Follow countries to enable this filter/);
    assert.equal(handle.isActive(), false);
  });
});

describe('followed-country notifications', () => {
  it('external watchlist add notifies subscribers and updates service state', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'panel-rerender' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    let rerenderCount = 0;
    const unsub = subscribe(() => {
      rerenderCount += 1;
    });

    // External add: user follows IR via another tab / surface.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(rerenderCount, 1);
    assert.equal(isFollowed('IR'), true);
    assert.equal(handle.isActive(), true);

    unsub();
  });

  it('keeps an inactive chip off after an external watchlist change', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'panel-toggle-off' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip(); // on
    host.clickChip(); // off

    let notificationCount = 0;
    const unsub = subscribe(() => {
      notificationCount += 1;
    });

    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(notificationCount, 1);
    assert.equal(handle.isActive(), false);
    unsub();
  });
});
