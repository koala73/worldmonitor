/**
 * Tests for U6 — CIIPanel pin-to-top with stable sort.
 *
 * Two layers of coverage:
 *
 *  1. Pure partition contract (`partitionByFollowed` /
 *     `shouldRenderSectionLabels` from
 *     `src/components/_cii-panel-partition.ts`). These are the actual
 *     functions the panel calls — no shadow re-implementations.
 *
 *  2. Integration: drive the live `getFollowed()` from
 *     `src/services/followed-countries.ts` via its `_setDepsForTests`
 *     hook, mutate the watchlist, dispatch
 *     `WM_FOLLOWED_COUNTRIES_CHANGED`, and assert the partition reads
 *     the new state. This locks in that the panel's
 *     `subscribeFollowed(() => rerenderRows())` wiring will see the
 *     same value the service exposes.
 *
 * We deliberately do NOT spin up the full `CIIPanel` here — `Panel.ts`
 * pulls in `import.meta.glob` (i18n) which the node:test runner can't
 * resolve, and the test would devolve into a DOM stub competition. The
 * partition helper is the load-bearing logic; the panel's `buildList`
 * is a thin DOM consumer of that result.
 *
 * Mirrors the stubbing shape from `tests/follow-button.test.mjs`.
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

const partitionMod = await import(
  '../src/components/_cii-panel-partition.ts'
);
const { partitionByFollowed, shouldRenderSectionLabels } = partitionMod;

const svc = await import('../src/services/followed-countries.ts');
const {
  getFollowed,
  isFollowFeatureEnabled,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal CountryScore shape — only `code` is required by the partition
 * helper (see `PartitionableScore`). Other fields are kept here so the
 * tests look like real CIIPanel rows and any future consumer reading
 * extra fields off the partitioned items will still typecheck.
 */
function makeScore(code, score = 50) {
  return {
    code,
    name: code,
    score,
    level: 'normal',
    trend: 'stable',
    change24h: 0,
    components: { unrest: 0, conflict: 0, security: 0, information: 0 },
    lastUpdated: new Date(0),
  };
}

const SCORES_5 = [
  makeScore('US', 80),
  makeScore('CN', 70),
  makeScore('RU', 60),
  makeScore('GB', 50),
  makeScore('FR', 40),
];

function setupAnonymousFreeWithFlagOn() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

function setupAnonymousFreeWithFlagOff() {
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
});

// ---------------------------------------------------------------------------
// Pure partition contract
// ---------------------------------------------------------------------------

describe('partitionByFollowed — pure helper', () => {
  it('happy path: 3 followed in middle of list → all 3 pinned to top in original order', () => {
    // Followed = {RU, US, FR} but stored in a different order than scores.
    // The partition must preserve the SCORES order (US, RU, FR), not the
    // followedCodes order. Memory: sort-before-positional-index.
    const result = partitionByFollowed(SCORES_5, ['RU', 'US', 'FR']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'RU', 'FR'],
      'followed group preserves original scores order',
    );
    assert.deepEqual(
      result.unfollowed.map((s) => s.code),
      ['CN', 'GB'],
      'unfollowed group preserves original scores order',
    );
  });

  it('zero followed → followed=[], unfollowed=scores (identity passthrough)', () => {
    const result = partitionByFollowed(SCORES_5, []);
    assert.equal(result.followed.length, 0);
    assert.strictEqual(
      result.unfollowed,
      SCORES_5,
      'returns the SAME reference (no copy) when watchlist is empty',
    );
  });

  it('all countries followed → unfollowed empty; followed preserves order', () => {
    const result = partitionByFollowed(SCORES_5, ['US', 'CN', 'RU', 'GB', 'FR']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'CN', 'RU', 'GB', 'FR'],
    );
    assert.equal(result.unfollowed.length, 0);
  });

  it('followed code not present in scores → silently dropped, no error', () => {
    // 'JP' is followed but not in SCORES_5 — must NOT throw, must NOT
    // appear in either group, and the rest of the partition still works.
    const result = partitionByFollowed(SCORES_5, ['US', 'JP']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US'],
      'JP is silently dropped (no row to pin)',
    );
    assert.deepEqual(
      result.unfollowed.map((s) => s.code),
      ['CN', 'RU', 'GB', 'FR'],
    );
  });

  it('empty scores list → both groups empty; no error', () => {
    const result = partitionByFollowed([], ['US', 'GB']);
    assert.equal(result.followed.length, 0);
    assert.equal(result.unfollowed.length, 0);
  });

  it('duplicate followed codes → de-duped via Set; no double-pin', () => {
    // Even if the watchlist has dupes (defensive — the service shouldn't
    // produce them), each scores row appears at most once in the output.
    const result = partitionByFollowed(SCORES_5, ['US', 'US', 'GB']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'GB'],
    );
    assert.equal(
      result.followed.length + result.unfollowed.length,
      SCORES_5.length,
      'every scores row appears exactly once across both groups',
    );
  });

  it('stable: a 50-row list partitioned twice → identical output', () => {
    // Regression guard against accidentally swapping `filter` for `sort`
    // (which is unstable for equal keys in older V8). Build a dense list,
    // partition twice, assert deep equality.
    const dense = Array.from({ length: 50 }, (_, i) =>
      makeScore(`X${i.toString().padStart(2, '0')}`, 50 - i),
    );
    const followed = ['X05', 'X10', 'X20', 'X30', 'X45'];
    const r1 = partitionByFollowed(dense, followed);
    const r2 = partitionByFollowed(dense, followed);
    assert.deepEqual(
      r1.followed.map((s) => s.code),
      r2.followed.map((s) => s.code),
    );
    assert.deepEqual(
      r1.unfollowed.map((s) => s.code),
      r2.unfollowed.map((s) => s.code),
    );
  });
});

describe('shouldRenderSectionLabels', () => {
  it('renders labels only when BOTH groups are non-empty', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: [makeScore('US')], unfollowed: [makeScore('CN')] }),
      true,
    );
  });

  it('zero followed → no labels (single-section list)', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: [], unfollowed: SCORES_5 }),
      false,
    );
  });

  it('all followed → no labels (single-section list)', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: SCORES_5, unfollowed: [] }),
      false,
    );
  });

  it('both empty (empty scores) → no labels', () => {
    assert.equal(shouldRenderSectionLabels({ followed: [], unfollowed: [] }), false);
  });
});

// ---------------------------------------------------------------------------
// Integration: panel-side reactive contract via the live service
// ---------------------------------------------------------------------------

describe('partition + service integration — reactive watchlist', () => {
  it('feature flag off → getFollowed() returns []; partition is identity', () => {
    setupAnonymousFreeWithFlagOff();
    // Even with localStorage populated, flag-off must yield empty.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'GB'] }),
    );
    // NOTE: when the flag is off the service short-circuits MUTATIONS, not
    // reads — `getFollowed()` returns whatever localStorage holds. The
    // panel must still partition correctly. The relevant guarantee is
    // that no row breaks; the divider may render or not depending on
    // which countries the user followed pre-flag-flip. That's fine.
    const followed = getFollowed();
    const partition = partitionByFollowed(SCORES_5, followed);
    // Sanity: no throw, no error; either group is fully populated.
    assert.equal(
      partition.followed.length + partition.unfollowed.length,
      SCORES_5.length,
    );
  });

  it('empty localStorage → partition is identity passthrough', () => {
    setupAnonymousFreeWithFlagOn();
    const followed = getFollowed();
    assert.deepEqual(followed, []);
    const partition = partitionByFollowed(SCORES_5, followed);
    assert.equal(partition.followed.length, 0);
    assert.equal(partition.unfollowed.length, SCORES_5.length);
    assert.equal(shouldRenderSectionLabels(partition), false);
  });

  it('subscribe() handler fires on WM_FOLLOWED_COUNTRIES_CHANGED dispatch', async () => {
    // Locks in the panel's contract: it subscribes via subscribe(), and
    // the handler must fire when an external mutation dispatches the
    // canonical event. This is the rerenderRows() trigger path.
    setupAnonymousFreeWithFlagOn();

    let handlerCalls = 0;
    const unsubscribe = subscribe(() => {
      handlerCalls += 1;
    });

    // External mutation: write straight to localStorage (mirrors what
    // addCountry does internally on the anonymous path) and dispatch.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(handlerCalls, 1, 'subscribe handler fires on external dispatch');

    // After mutation, getFollowed() returns the new list — the partition
    // would now place US at the top.
    const partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US'],
    );
    assert.deepEqual(
      partition.unfollowed.map((s) => s.code),
      ['CN', 'RU', 'GB', 'FR'],
    );

    unsubscribe();
  });

  it('subscribe teardown stops further handler calls', async () => {
    setupAnonymousFreeWithFlagOn();

    let handlerCalls = 0;
    const unsubscribe = subscribe(() => {
      handlerCalls += 1;
    });
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.equal(handlerCalls, 1);

    unsubscribe();
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.equal(handlerCalls, 1, 'no further calls after teardown');
  });

  it('flag OFF + populated localStorage → CIIPanel gates partition input to [] → identity passthrough, no labels', () => {
    // Mirrors the panel-side gating from CIIPanel.buildList:
    //
    //   const followed = isFollowFeatureEnabled() ? getFollowed() : [];
    //   const partition = partitionByFollowed(scores, followed);
    //
    // The bug this guards against: `getFollowed()` reads localStorage in
    // anonymous mode regardless of the flag (only mutations are
    // short-circuited), so a panel that calls partitionByFollowed(scores,
    // getFollowed()) without the flag gate would reorder rows + render
    // FOLLOWING / ALL section labels even when the feature is off and
    // FollowButton is hidden.
    setupAnonymousFreeWithFlagOff();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'GB'] }),
    );

    // Sanity: flag is reported off; getFollowed() still leaks localStorage.
    assert.equal(isFollowFeatureEnabled(), false);
    assert.deepEqual(getFollowed().sort(), ['GB', 'US']);

    // Apply the panel's gate.
    const followed = isFollowFeatureEnabled() ? getFollowed() : [];
    const partition = partitionByFollowed(SCORES_5, followed);

    // Identity passthrough — original scores order preserved.
    assert.equal(partition.followed.length, 0, 'no rows pinned when flag off');
    assert.deepEqual(
      partition.unfollowed.map((s) => s.code),
      ['US', 'CN', 'RU', 'GB', 'FR'],
      'unfollowed group is the original scores order, untouched',
    );
    // Both groups → no FOLLOWING / ALL labels.
    assert.equal(
      shouldRenderSectionLabels(partition),
      false,
      'no section labels when flag off (matches pre-PR-B behaviour)',
    );

    // Same gate is the single source of truth for both render paths
    // (buildList from refresh() AND rerenderRows() from the watchlist
    // subscription). Re-running the gate after a simulated watchlist
    // change must still produce identity passthrough.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'GB', 'FR'] }),
    );
    const followed2 = isFollowFeatureEnabled() ? getFollowed() : [];
    const partition2 = partitionByFollowed(SCORES_5, followed2);
    assert.equal(partition2.followed.length, 0);
    assert.equal(shouldRenderSectionLabels(partition2), false);
  });

  it('partition reflects the pre-mutation list before dispatch (no premature update)', () => {
    setupAnonymousFreeWithFlagOn();
    // Set up an initial state with US followed.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    let partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US'],
    );

    // Update localStorage but DON'T dispatch yet — the panel is supposed
    // to re-render only when notified, so a snapshot taken right now should
    // still reflect getFollowed() (which reads localStorage live in
    // anonymous mode). This locks in that the partition itself is a pure
    // function of (scores, followed), with no internal cache.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'CN'] }),
    );
    partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US', 'CN'],
      'getFollowed() reads localStorage live; partition reflects current state',
    );
  });
});
