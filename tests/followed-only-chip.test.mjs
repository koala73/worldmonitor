/**
 * Tests for src/utils/followed-only-chip.ts (U7).
 *
 * Mirrors the host-stub shape from `tests/follow-button.test.mjs` so
 * the chip can be exercised under the project's `node:test` runner
 * without jsdom. Covers:
 *
 *  - Default off (no localStorage entry on construct).
 *  - Toggle persists to localStorage (`wm-followed-only-filter-${panelId}`).
 *  - Disabled state when `getFollowed()` is empty + tooltip wording.
 *  - Re-render on `WM_FOLLOWED_COUNTRIES_CHANGED` flips disabled state.
 *  - Hidden when feature flag off → empty html, no-op attach.
 *  - onChange fires with the new active state.
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
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

const chipMod = await import('../src/utils/followed-only-chip.ts');
const { renderFollowedOnlyChip, _resetAllPersistedStateForTests } = chipMod;

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
     * Fire a synthetic click on the rendered chip. The handler resolves
     * the chip via `target.closest('.wm-followed-only-chip')`. We mirror
     * the rendered html — so when the chip is disabled the stub also
     * carries `disabled` on the resolved button.
     */
    clickChip() {
      const isDisabled = /<button[^>]*\bdisabled\b/.test(_innerHtml);
      const isPresent = _innerHtml.includes('class="wm-followed-only-chip');
      const buttonStub = {
        hasAttribute: (name) => (name === 'disabled' ? isDisabled : false),
        closest: (sel) =>
          sel === '.wm-followed-only-chip' && isPresent ? buttonStub : null,
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

beforeEach(() => {
  _localStorage.clear();
  _resetStateForTests();
  _resetAllPersistedStateForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderFollowedOnlyChip — default + persistence', () => {
  it('default off when no localStorage entry — html shows data-state="inactive"', () => {
    setupAnonymousFlagOn();
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.match(handle.html, /data-state="inactive"/);
    assert.match(handle.html, /aria-pressed="false"/);
    assert.equal(handle.isActive(), false);
  });

  it('reads persisted "1" → renders active', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    _localStorage.setItem('wm-followed-only-filter-p1', '1');
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.match(handle.html, /data-state="active"/);
    assert.match(handle.html, /aria-pressed="true"/);
    assert.equal(handle.isActive(), true);
  });

  it('toggle on persists "1" to wm-followed-only-filter-${panelId}', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.match(host.innerHTML, /data-state="inactive"/);

    host.clickChip();

    assert.equal(_localStorage.getItem('wm-followed-only-filter-p1'), '1');
    assert.match(host.innerHTML, /data-state="active"/);
    assert.equal(handle.isActive(), true);
    teardown();
  });

  it('toggle off removes the key (default-off semantics preserved)', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    _localStorage.setItem('wm-followed-only-filter-p1', '1');
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickChip(); // active → inactive

    assert.equal(_localStorage.getItem('wm-followed-only-filter-p1'), null);
    assert.match(host.innerHTML, /data-state="inactive"/);
    teardown();
  });

  it('per-panel scoping — toggling p1 does NOT affect p2', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const h1 = renderFollowedOnlyChip({ panelId: 'p1' });
    const h2 = renderFollowedOnlyChip({ panelId: 'p2' });
    const host1 = makeHost();
    const host2 = makeHost();
    h1.attach(host1);
    h2.attach(host2);

    host1.clickChip();

    assert.equal(_localStorage.getItem('wm-followed-only-filter-p1'), '1');
    assert.equal(_localStorage.getItem('wm-followed-only-filter-p2'), null);
    assert.equal(h1.isActive(), true);
    assert.equal(h2.isActive(), false);
  });
});

describe('renderFollowedOnlyChip — disabled state (empty watchlist)', () => {
  it('empty watchlist → chip rendered disabled with the tooltip', () => {
    setupAnonymousFlagOn();
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.match(handle.html, /\bdisabled\b/);
    assert.match(handle.html, /Follow countries to enable this filter/);
  });

  it('non-empty watchlist → chip enabled', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.doesNotMatch(handle.html, /\bdisabled\b/);
  });

  it('re-renders disabled state when WM_FOLLOWED_COUNTRIES_CHANGED fires', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    const host = makeHost();
    const teardown = handle.attach(host);
    // Initially enabled.
    assert.doesNotMatch(host.innerHTML, /\bdisabled\b/);

    // External actor empties the watchlist + dispatches the change event.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: [] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.match(host.innerHTML, /\bdisabled\b/);
    teardown();
  });

  it('clickChip on disabled host is a no-op (does not flip state)', () => {
    setupAnonymousFlagOn();
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.match(host.innerHTML, /\bdisabled\b/);

    host.clickChip();

    // Still off, still disabled.
    assert.equal(_localStorage.getItem('wm-followed-only-filter-p1'), null);
    assert.equal(handle.isActive(), false);
    teardown();
  });
});

describe('renderFollowedOnlyChip — feature flag off', () => {
  it('empty html, no-op attach', () => {
    setupAnonymousFlagOff();
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.equal(handle.html, '');
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.equal(host.listenerCount('click'), 0);
    teardown();
    teardown(); // idempotent
  });

  it('isActive() returns false even if a stale "1" is persisted', () => {
    setupAnonymousFlagOff();
    _localStorage.setItem('wm-followed-only-filter-p1', '1');
    const handle = renderFollowedOnlyChip({ panelId: 'p1' });
    assert.equal(handle.isActive(), false);
  });
});

describe('renderFollowedOnlyChip — onChange callback', () => {
  it('fires with new active state on each toggle', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const calls = [];
    const handle = renderFollowedOnlyChip({
      panelId: 'p1',
      onChange: (active) => calls.push(active),
    });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickChip(); // off → on
    host.clickChip(); // on → off
    host.clickChip(); // off → on

    assert.deepEqual(calls, [true, false, true]);
    teardown();
  });

  it('does NOT fire onChange on watchlist change (only on user toggle)', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const calls = [];
    const handle = renderFollowedOnlyChip({
      panelId: 'p1',
      onChange: (a) => calls.push(a),
    });
    const host = makeHost();
    const teardown = handle.attach(host);

    // External watchlist change.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.deepEqual(calls, []);
    teardown();
  });

  it('teardown stops onChange firing on subsequent clicks', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const calls = [];
    const handle = renderFollowedOnlyChip({
      panelId: 'p1',
      onChange: (a) => calls.push(a),
    });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickChip();
    teardown();
    host.clickChip(); // post-teardown click should not fire onChange

    assert.deepEqual(calls, [true]);
  });
});

describe('renderFollowedOnlyChip — integration: filter pass against a country-scoped row list', () => {
  /**
   * Thin-but-meaningful integration test that mirrors what
   * DiseaseOutbreaksPanel / DisplacementPanel actually do: build a list
   * of items each carrying a `code` (ISO-2), then filter to only those
   * codes the user follows when the chip's `isActive()` is true.
   *
   * We deliberately avoid spinning up the real `Panel` (which pulls in
   * `import.meta.glob` for i18n). The behaviour under test is the
   * *contract* between the chip's `isActive()` and the panel's filter
   * pass — not the DOM-tree of the panel.
   */
  it('chip on + watchlist=[US,IR]; 5-row list; filter yields 2 rows', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    const items = [
      { code: 'US', label: 'a' },
      { code: 'CN', label: 'b' },
      { code: 'IR', label: 'c' },
      { code: 'BR', label: 'd' },
      { code: 'IN', label: 'e' },
    ];

    const handle = renderFollowedOnlyChip({ panelId: 'integ-1' });
    const host = makeHost();
    const teardown = handle.attach(host);
    host.clickChip(); // turn on

    const followed = JSON.parse(
      _localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY),
    ).countries;
    const filtered = handle.isActive()
      ? items.filter((it) => followed.includes(it.code))
      : items;

    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map((i) => i.code).sort(), ['IR', 'US']);
    teardown();
  });

  it('chip off → returns full 5-row list', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    const items = [
      { code: 'US' },
      { code: 'CN' },
      { code: 'IR' },
      { code: 'BR' },
      { code: 'IN' },
    ];

    const handle = renderFollowedOnlyChip({ panelId: 'integ-2' });
    handle.attach(makeHost());

    const followed = JSON.parse(
      _localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY),
    ).countries;
    const filtered = handle.isActive()
      ? items.filter((it) => followed.includes(it.code))
      : items;

    assert.equal(filtered.length, 5);
  });

  it('stale active + empty watchlist → clears persisted state and does not filter', () => {
    setupAnonymousFlagOn();
    // Persist "1" as if the user toggled on previously, then unfollowed everything.
    _localStorage.setItem('wm-followed-only-filter-integ-3', '1');
    const items = [{ code: 'US' }, { code: 'CN' }, { code: 'IR' }];

    const handle = renderFollowedOnlyChip({ panelId: 'integ-3' });
    const host = makeHost();
    handle.attach(host);

    // The chip is rendered disabled because watchlist is empty.
    assert.match(host.innerHTML, /\bdisabled\b/);
    // The stale active bit is cleared so panel filter passes do not get
    // trapped in an empty state the disabled chip cannot turn off.
    assert.equal(handle.isActive(), false);
    assert.equal(_localStorage.getItem('wm-followed-only-filter-integ-3'), null);

    const followed = []; // empty watchlist
    const filtered = handle.isActive()
      ? items.filter((it) => followed.includes(it.code))
      : items;
    assert.equal(filtered.length, 3);
  });
});
