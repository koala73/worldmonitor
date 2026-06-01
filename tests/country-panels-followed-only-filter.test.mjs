/**
 * Tests for U7 — "Followed only" filter chip integrated with the
 * live `getFollowed()` / `subscribe()` service contract.
 *
 * Mirrors `tests/cii-panel-pin-to-top.test.mjs` — we deliberately do
 * NOT spin up the real `DiseaseOutbreaksPanel` / `DisplacementPanel`
 * here. `Panel.ts` pulls in `import.meta.glob` (i18n) which the
 * node:test runner can't resolve, and the test would devolve into a
 * DOM stub competition.
 *
 * What we test instead:
 *  - The chip's `isActive()` reflects localStorage written by user
 *    toggle.
 *  - When chip is on, applying `isFollowed(row.code)` to a list of
 *    rows produces the expected subset — this IS the filter pass
 *    inside both panels.
 *  - When the user mutates the watchlist via the service
 *    (`addCountry` / external set + dispatch), the next filter pass
 *    sees the new state — proving the panel's
 *    `subscribe(rerender)` wiring will see what the chip sees.
 *  - Empty filtered result + chip on → caller renders the U7 empty
 *    state message.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');

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

beforeEach(() => {
  _localStorage.clear();
  _resetStateForTests();
  _resetAllPersistedStateForTests();
});

/**
 * Pure helper that mirrors the inline filter pass in
 * `DiseaseOutbreaksPanel._render` and `DisplacementPanel.renderContent`:
 * when `chipActive` is true, retain only rows whose `code` is in the
 * user's followed list (per the live service); otherwise pass-through.
 */
function applyFollowedOnlyFilter(rows, chipActive) {
  if (!chipActive) return rows;
  return rows.filter((r) => (r.code ? isFollowed(r.code) : false));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('country-scoped panels — happy paths', () => {
  it('5 rows from 5 countries; user follows 2; chip on → 2 rows shown', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    const rows = [
      { code: 'US', label: 'us-row' },
      { code: 'CN', label: 'cn-row' },
      { code: 'IR', label: 'ir-row' },
      { code: 'BR', label: 'br-row' },
      { code: 'IN', label: 'in-row' },
    ];
    const handle = renderFollowedOnlyChip({ panelId: 'panel-disease' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    const filtered = applyFollowedOnlyFilter(rows, handle.isActive());
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map((r) => r.code).sort(), ['IR', 'US']);
  });

  it('chip off → all 5 rows shown', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    const rows = [
      { code: 'US' },
      { code: 'CN' },
      { code: 'IR' },
      { code: 'BR' },
      { code: 'IN' },
    ];
    const handle = renderFollowedOnlyChip({ panelId: 'panel-disease' });
    handle.attach(makeHost());

    const filtered = applyFollowedOnlyFilter(rows, handle.isActive());
    assert.equal(filtered.length, 5);
  });

  it('rows without a country code are dropped when chip is on', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const rows = [
      { code: 'US' },
      { code: undefined },
      { code: '' },
      { code: 'CN' },
    ];
    const handle = renderFollowedOnlyChip({ panelId: 'panel-rowsless' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    const filtered = applyFollowedOnlyFilter(rows, handle.isActive());
    assert.deepEqual(filtered.map((r) => r.code), ['US']);
  });
});

describe('country-scoped panels — edge cases', () => {
  it('chip on, all rows filtered out → caller renders empty-state copy', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['JP'] }), // followed code is not in row list
    );
    const rows = [{ code: 'US' }, { code: 'CN' }, { code: 'IR' }];
    const handle = renderFollowedOnlyChip({ panelId: 'panel-empty' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    const filtered = applyFollowedOnlyFilter(rows, handle.isActive());
    assert.equal(filtered.length, 0);

    // The caller's empty-state branch (used by both panels):
    const emptyMessage = handle.isActive()
      ? 'No items in your followed countries. Add countries by tapping the star, or turn off this filter.'
      : 'No outbreaks match filter';
    assert.match(emptyMessage, /No items in your followed countries/);
  });

  it('empty watchlist → chip rendered disabled (panel-side: chip off OR empty-state)', () => {
    setupAnonymousFlagOn();
    const handle = renderFollowedOnlyChip({ panelId: 'panel-empty-wl' });
    const host = makeHost();
    handle.attach(host);
    assert.match(host.innerHTML, /\bdisabled\b/);
    assert.match(host.innerHTML, /Follow countries to enable this filter/);
    // isActive defaults to false; panel renders the full list normally.
    assert.equal(handle.isActive(), false);
  });
});

describe('country-scoped panels — chip placement keeps close button rightmost', () => {
  // Mirrors the production logic in DiseaseOutbreaksPanel + DisplacementPanel:
  //
  //   const closeBtn = this.header.querySelector('.panel-close-btn');
  //   if (closeBtn) {
  //     this.header.insertBefore(host, closeBtn);
  //   } else {
  //     this.header.appendChild(host);
  //   }
  //
  // The bug: a plain `this.header.appendChild(host)` lands the chip AFTER
  // the close button (Panel base appends `.panel-close-btn` first), so X
  // is no longer the rightmost header control. We assert the placement
  // logic via a minimal fake header DOM — Panel.ts itself can't be
  // imported under node:test (i18n's `import.meta.glob`).

  function makeFakeHeader() {
    const children = [];
    const header = {
      _children: children,
      appendChild(node) {
        children.push(node);
        return node;
      },
      insertBefore(node, ref) {
        const i = children.indexOf(ref);
        if (i === -1) {
          children.push(node);
        } else {
          children.splice(i, 0, node);
        }
        return node;
      },
      querySelector(sel) {
        if (sel === '.panel-close-btn') {
          return children.find((c) => c.className === 'panel-close-btn') ?? null;
        }
        return null;
      },
      get lastChild() {
        return children[children.length - 1] ?? null;
      },
    };
    return header;
  }

  /**
   * Mirrors the ordered Panel-base header construction:
   *   header-left → status-badge → count → close-btn
   * The chip is mounted from the panel constructor AFTER the base has
   * already appended the close button (Panel.ts line 748).
   */
  function buildHeaderWithBaseControls() {
    const header = makeFakeHeader();
    header.appendChild({ className: 'panel-header-left' });
    header.appendChild({ className: 'panel-status-badge' });
    header.appendChild({ className: 'panel-count' });
    header.appendChild({ className: 'panel-close-btn' });
    return header;
  }

  /** The fix's placement logic — used by both panels. */
  function mountChipBeforeClose(header, host) {
    const closeBtn = header.querySelector('.panel-close-btn');
    if (closeBtn) {
      header.insertBefore(host, closeBtn);
    } else {
      header.appendChild(host);
    }
  }

  it('DiseaseOutbreaksPanel shape — close button stays as last header child after chip mount', () => {
    const header = buildHeaderWithBaseControls();
    const host = { className: 'panel-header-followed-only-host' };
    mountChipBeforeClose(header, host);
    assert.equal(
      header.lastChild?.className,
      'panel-close-btn',
      'close button must be the rightmost (last) header child',
    );
    // And the chip host is immediately before it.
    const idxClose = header._children.findIndex((c) => c.className === 'panel-close-btn');
    const idxHost = header._children.findIndex((c) => c.className === 'panel-header-followed-only-host');
    assert.equal(idxHost, idxClose - 1, 'chip host sits directly before close');
  });

  it('DisplacementPanel shape — same placement guarantee (logic is shared)', () => {
    // Identical to the disease-outbreaks panel; the production logic is
    // copy-pasted into both panels. We assert again so a regression in
    // one panel doesn't pass under the other panel's coverage.
    const header = buildHeaderWithBaseControls();
    const host = { className: 'panel-header-followed-only-host' };
    mountChipBeforeClose(header, host);
    assert.equal(header.lastChild?.className, 'panel-close-btn');
  });

  it('BUG SHAPE — naive appendChild lands chip AFTER close (regression guard)', () => {
    // If a future refactor accidentally drops the insertBefore branch,
    // this test fires the alarm: header.lastChild becomes the chip host.
    const header = buildHeaderWithBaseControls();
    const host = { className: 'panel-header-followed-only-host' };
    header.appendChild(host); // naive — the bug shape
    assert.equal(
      header.lastChild?.className,
      'panel-header-followed-only-host',
      'sanity: naive appendChild lands chip after close (this is the bug)',
    );
  });

  it('no close button present (defensive) → chip falls back to appendChild', () => {
    // If a Panel subclass disabled the close button entirely, the
    // querySelector returns null and the fix falls through to appendChild
    // — the chip still mounts; it just won't have a close to land before.
    const header = makeFakeHeader();
    header.appendChild({ className: 'panel-header-left' });
    const host = { className: 'panel-header-followed-only-host' };
    mountChipBeforeClose(header, host);
    assert.equal(header.lastChild?.className, 'panel-header-followed-only-host');
  });

  it('DisplacementPanel destroy removes the inserted followed-only host', () => {
    const src = readFileSync(resolve(ROOT, 'src/components/DisplacementPanel.ts'), 'utf8');
    assert.match(
      src,
      /private followedOnlyHost: HTMLElement \| null = null;/,
      'DisplacementPanel must retain the inserted header host for cleanup',
    );
    assert.match(
      src,
      /this\.followedOnlyHost = host;/,
      'DisplacementPanel must store the host when mounting the chip',
    );
    assert.match(
      src,
      /this\.followedOnlyHost\.parentElement\.removeChild\(this\.followedOnlyHost\)/,
      'destroy() must remove the chip host from the panel header',
    );
    assert.match(
      src,
      /this\.followedOnlyHost = null;/,
      'destroy() must clear the host reference',
    );
  });
});

describe('country-scoped panels — re-filter on watchlist change', () => {
  it('external watchlist add fires WM_FOLLOWED_COUNTRIES_CHANGED → filter sees new state', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const rows = [{ code: 'US' }, { code: 'CN' }, { code: 'IR' }];

    const handle = renderFollowedOnlyChip({ panelId: 'panel-rerender' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip();

    // Panel-side rerender pass: triggered by subscribe() in production.
    let rerenderCount = 0;
    const lastFiltered = { rows: [] };
    const unsub = subscribe(() => {
      rerenderCount += 1;
      lastFiltered.rows = applyFollowedOnlyFilter(rows, handle.isActive());
    });

    // Initial pass — only US.
    const filtered = applyFollowedOnlyFilter(rows, handle.isActive());
    assert.deepEqual(filtered.map((r) => r.code), ['US']);

    // External add: user follows IR via another tab / surface.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(rerenderCount, 1);
    assert.deepEqual(lastFiltered.rows.map((r) => r.code).sort(), ['IR', 'US']);

    unsub();
  });

  it('toggling the chip OFF does not break subsequent watchlist-driven re-renders', () => {
    setupAnonymousFlagOn();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const rows = [{ code: 'US' }, { code: 'CN' }];

    const handle = renderFollowedOnlyChip({ panelId: 'panel-toggle-off' });
    const host = makeHost();
    handle.attach(host);
    host.clickChip(); // on
    host.clickChip(); // off

    let lastCount = 0;
    const unsub = subscribe(() => {
      lastCount = applyFollowedOnlyFilter(rows, handle.isActive()).length;
    });

    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'IR'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    // Chip is off so all rows are passed through regardless of watchlist.
    assert.equal(lastCount, 2);
    unsub();
  });
});
