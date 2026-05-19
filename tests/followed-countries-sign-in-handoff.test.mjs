/**
 * Tests for src/services/followed-countries.ts U3 — sign-in handoff,
 * auth-generation guard, reactive subscription, sign-out cleanup,
 * handoffPending UX, visibilitychange retry.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.throwOnSet = false;
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    if (this.throwOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
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
class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
  }
}

let _localStorage;
let _window;
let _document;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  _document = new FakeDocument();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: _document,
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
  delete globalThis.document;
});

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
});

// ---------------------------------------------------------------------------
// Import service
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  WM_FOLLOWED_COUNTRIES_CAP_DROP,
  _setDepsForTests,
  _resetStateForTests,
  _emitAuthStateForTests,
  _getInternalStateForTests,
  _pushSubscriptionSnapshotForTests,
  _setHandoffBackoffForTests,
  _clearFailedHandoffForTests,
  _installCrossTabStorageListenerForTests,
} = svc;

// ---------------------------------------------------------------------------
// Fake Convex client
// ---------------------------------------------------------------------------

const FAKE_API = {
  followedCountries: {
    followCountry: 'fake:followCountry',
    unfollowCountry: 'fake:unfollowCountry',
    mergeAnonymousLocal: 'fake:mergeAnonymousLocal',
    listFollowed: 'fake:listFollowed',
  },
};

const ISO_RE = /^[A-Z]{2}$/;

function makeFakeConvex({
  tier = 1,
  capLimit = 3,
  initialRows = [],
  mergeRejection = null, // optional Error to throw from mergeAnonymousLocal
  mergeDelayMs = 0,
} = {}) {
  let rows = initialRows.map((c, i) => ({ country: c, addedAt: 1000 + i }));
  let listFollowedCb = null;
  const calls = { follow: [], unfollow: [], merge: [] };

  const ConvexErrorCtor = class extends Error {
    constructor(data) {
      super(`ConvexError: ${data.kind}`);
      this.data = data;
    }
  };

  const fireSnapshot = () => {
    if (!listFollowedCb) return;
    const sorted = [...rows]
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((r) => r.country);
    listFollowedCb(sorted);
  };

  const client = {
    async mutation(ref, args) {
      if (ref === FAKE_API.followedCountries.followCountry) {
        calls.follow.push(args);
        const { country } = args;
        if (rows.find((r) => r.country === country)) return { ok: true, idempotent: true };
        if (tier < 1 && rows.length >= capLimit) {
          throw new ConvexErrorCtor({ kind: 'FREE_CAP', currentCount: rows.length, limit: capLimit });
        }
        rows.push({ country, addedAt: Date.now() + rows.length });
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.unfollowCountry) {
        calls.unfollow.push(args);
        const { country } = args;
        const idx = rows.findIndex((r) => r.country === country);
        if (idx === -1) return { ok: true, idempotent: true };
        rows.splice(idx, 1);
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
        calls.merge.push(args);
        if (mergeDelayMs > 0) await new Promise((r) => setTimeout(r, mergeDelayMs));
        if (mergeRejection) throw mergeRejection;
        const { countries } = args;
        if (countries.length === 0) throw new ConvexErrorCtor({ kind: 'EMPTY_INPUT' });
        const droppedInvalid = [];
        const validInputs = [];
        for (const c of countries) {
          if (typeof c === 'string' && ISO_RE.test(c)) validInputs.push(c);
          else droppedInvalid.push(c);
        }
        const seen = new Set();
        const canonical = [];
        for (const c of validInputs) if (!seen.has(c)) { seen.add(c); canonical.push(c); }
        const existingSet = new Set(rows.map((r) => r.country));
        const newCandidates = canonical.filter((c) => !existingSet.has(c));
        let accepted, droppedDueToCap;
        if (tier < 1) {
          const remaining = Math.max(0, capLimit - rows.length);
          accepted = newCandidates.slice(0, remaining);
          droppedDueToCap = newCandidates.slice(remaining);
        } else {
          accepted = newCandidates;
          droppedDueToCap = [];
        }
        for (const country of accepted) {
          rows.push({ country, addedAt: Date.now() + rows.length });
        }
        if (accepted.length > 0) fireSnapshot();
        return {
          totalCount: rows.length,
          accepted,
          droppedInvalid,
          droppedDueToCap,
        };
      }
      throw new Error(`unmocked mutation ref: ${ref}`);
    },
    onUpdate(ref, _args, onResult /* , onError */) {
      if (ref === FAKE_API.followedCountries.listFollowed) {
        listFollowedCb = onResult;
        Promise.resolve().then(() => {
          const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
          if (listFollowedCb === onResult) onResult(sorted);
        });
        return () => { if (listFollowedCb === onResult) listFollowedCb = null; };
      }
      throw new Error(`unmocked subscription ref: ${ref}`);
    },
    _calls: calls,
    _getRows: () => rows.map((r) => r.country),
    _push: fireSnapshot,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLocalStorageList(list) {
  _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: list }));
}

function getLocalStorageRaw() {
  return _localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
}

async function flushMicrotasks() {
  // Flush a few rounds — fake onUpdate fires its initial snapshot via
  // queueMicrotask, and getFollowed() relies on the subscription state.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function setupAnonymous() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

function setupSignedIn(userId, { tier = 1, fakeClient }) {
  _setDepsForTests({
    getCurrentClerkUser: () => ({ id: userId }),
    getEntitlementState: () => ({ features: { tier } }),
    hasTier: (n) => n <= tier,
    featureFlagEnabled: true,
    convexClient: fakeClient,
    convexApi: FAKE_API,
  });
}

beforeEach(() => {
  _resetStateForTests();
  // Collapse retry backoff to 0 so visibility-driven retries fire on the
  // next microtask. Production uses 1s/2s/4s/8s/16s. (P1 #4 test seam.)
  _setHandoffBackoffForTests([0, 0, 0, 0, 0]);
  setupAnonymous();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('U3 — happy: anon localStorage merged, table union, event fires', () => {
  it("anon ['US','GB'] + table ['US','JP'] → final ['US','JP','GB']; localStorage cleared; event fires", async () => {
    setLocalStorageList(['US', 'GB']);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'JP'] });
    setupSignedIn('user_1', { tier: 1, fakeClient: fake });

    let events = 0;
    const unsub = subscribe(() => events++);

    await _emitAuthStateForTests({ id: 'user_1' });
    await flushMicrotasks();

    assert.deepEqual(fake._getRows(), ['US', 'JP', 'GB']);
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.deepEqual(getFollowed().sort(), ['GB', 'JP', 'US']);
    assert.ok(events >= 1, 'change event fires');

    unsub();
  });
});

describe('U3 — happy: empty localStorage skips merge', () => {
  it('anon empty localStorage; signs in; mergeAnonymousLocal NOT called', async () => {
    // Empty array stored:
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_e', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_e' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0, 'merge NOT called');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it('no localStorage entry at all → mergeAnonymousLocal NOT called', async () => {
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_z', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_z' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });
});

describe('U3 — edge: corrupt localStorage cleared unconditionally', () => {
  it("'not-valid-json' → mergeAnonymousLocal NOT called; localStorage cleared", async () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, 'not-valid-json');
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_c', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_c' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null, 'corrupt localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it("wrong shape '[{symbol:AAPL}]' → mergeAnonymousLocal NOT called; localStorage cleared", async () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify([{ symbol: 'AAPL' }]),
    );
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_w', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_w' });
    await flushMicrotasks();

    assert.equal(fake._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('U3 — edge: free user cap-bounded merge', () => {
  it("anon ['US','GB'], table ['JP','CN'] → accepts 'US' only, drops 'GB'; cap-drop event fires", async () => {
    setLocalStorageList(['US', 'GB']);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: ['JP', 'CN'] });
    setupSignedIn('user_f', { tier: 0, fakeClient: fake });

    let capDropDetail = null;
    const handler = (ev) => { capDropDetail = ev.detail; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);

    await _emitAuthStateForTests({ id: 'user_f' });
    await flushMicrotasks();

    assert.deepEqual(fake._getRows().sort(), ['CN', 'JP', 'US']);
    assert.deepEqual(capDropDetail, { kept: 1, dropped: 1 });

    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);
  });
});

describe('U3 — edge: mutation returns multi-cap drops', () => {
  it("anon ['US','GB','JP','CN'], no rows → kept 3, dropped 1; toast detail kept=3 dropped=1", async () => {
    setLocalStorageList(['US', 'GB', 'JP', 'CN']);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: [] });
    setupSignedIn('user_m', { tier: 0, fakeClient: fake });

    let detail = null;
    const handler = (ev) => { detail = ev.detail; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);

    await _emitAuthStateForTests({ id: 'user_m' });
    await flushMicrotasks();

    assert.deepEqual(detail, { kept: 3, dropped: 1 });

    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, handler);
  });
});

describe('U3 — edge: network failure → handoffState=failed, localStorage retained', () => {
  it('mergeAnonymousLocal rejects → state=failed, localStorage intact, visibility retry scheduled', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({
      tier: 1,
      mergeRejection: new Error('NetworkError'),
    });
    setupSignedIn('user_n', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_n' });
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'failed');
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, true);
  });

  it('visibilitychange retry succeeds after fix', async () => {
    setLocalStorageList(['US']);
    let shouldFail = true;
    const ConvexErrorCtor = class extends Error {
      constructor(data) {
        super(`ConvexError: ${data.kind}`);
        this.data = data;
      }
    };
    void ConvexErrorCtor;
    const rows = [];
    let listCb = null;
    const fake = {
      async mutation(ref, args) {
        if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
          if (shouldFail) throw new Error('NetworkError');
          for (const c of args.countries) rows.push(c);
          if (listCb) listCb(rows.slice());
          return { totalCount: rows.length, accepted: args.countries, droppedInvalid: [], droppedDueToCap: [] };
        }
        throw new Error(`unmocked: ${ref}`);
      },
      onUpdate(ref, _a, onResult) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          listCb = onResult;
          Promise.resolve().then(() => onResult(rows.slice()));
          return () => { if (listCb === onResult) listCb = null; };
        }
        throw new Error(`unmocked: ${ref}`);
      },
    };
    setupSignedIn('user_r', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_r' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Now flip the failure switch and trigger visibilitychange.
    shouldFail = false;
    _document.dispatchEvent(new Event('visibilitychange'));
    // The handler kicks off async _runHandoff. Wait for it.
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('U3 — critical: in-flight auth race, sign-out', () => {
  it('user-1 signs in → handoff in-flight → user-1 signs out → result dropped, localStorage NOT cleared', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 20 });

    setupSignedIn('user_1', { tier: 1, fakeClient: fake });

    // Kick off handoff but don't await it.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Mid-await, sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // Now let the merge resolve.
    await handoffPromise;
    await flushMicrotasks();

    // localStorage should be intact (handoff dropped its result).
    const raw = getLocalStorageRaw();
    assert.notEqual(raw, null);
    assert.deepEqual(JSON.parse(raw).countries, ['US']);
    // No subscription should be active.
    assert.equal(_getInternalStateForTests().hasReactiveSubscription, false);
    // State back to idle (sign-out resets it).
    assert.equal(_getInternalStateForTests().handoffState, 'idle');
  });
});

describe('U3 — critical: in-flight auth race, user swap', () => {
  it("user-1's handoff → user-1 out, user-2 in → user-1's result dropped via userIdAtStart guard", async () => {
    setLocalStorageList(['US']);
    const fake1 = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_1', { tier: 1, fakeClient: fake1 });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Sign out user-1 then sign in user-2.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    const fake2 = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_2', { tier: 1, fakeClient: fake2 });
    const handoff2 = _emitAuthStateForTests({ id: 'user_2' });

    await handoffPromise;
    await handoff2;
    await flushMicrotasks();

    // user-1's merge happened on their fake, but the result was DROPPED.
    // What matters is that we are now in user-2's complete state with
    // user-2's snapshot, NOT user-1's.
    const internal = _getInternalStateForTests();
    assert.equal(internal.handoffState, 'complete');
    if (internal.lastKnownSubscriptionSnapshot) {
      assert.equal(internal.lastKnownSubscriptionSnapshot.userId, 'user_2');
    }
    // _handoffGeneration should have advanced multiple steps. Each
    // listener-emit increments by 1; user-swap branch adds a 2nd bump.
    // Initial setup + sign-in (1) → sign-out (1, no second since prev=null after reset) →
    // sign-in user_2 (1+1 user-swap branch). At least 3 increments observed.
    assert.ok(internal.handoffGeneration >= 3, `gen advanced (>=3): got ${internal.handoffGeneration}`);
  });
});

describe('U3 — handoffPending blocks writes', () => {
  it('addCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_p', { tier: 1, fakeClient: fake });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_p' });

    // Mid-handoff, attempt addCountry.
    const result = await addCountry('FR');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    // Let handoff complete.
    await handoffPromise;
    await flushMicrotasks();

    // Now addCountry should succeed.
    const r2 = await addCountry('FR');
    assert.deepEqual(r2, { ok: true });
  });

  it('removeCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeDelayMs: 30 });
    setupSignedIn('user_r2', { tier: 1, fakeClient: fake });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_r2' });
    const result = await removeCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    await handoffPromise;
    await flushMicrotasks();
  });
});

describe('U3 — handoffPending getFollowed', () => {
  it('returns union of localStorage + user-scoped snapshot during handoff', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['JP'], mergeDelayMs: 30 });
    setupSignedIn('user_g', { tier: 1, fakeClient: fake });

    // Kick off handoff first; auth-state emit clears any prior snapshot.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_g' });

    // Now push a user-scoped snapshot DURING pending — represents a
    // cross-tab subscription update arriving before this tab's merge
    // completes.
    _pushSubscriptionSnapshotForTests('user_g', ['JP']);

    const mid = getFollowed();
    // Pending phase — union of localStorage ['US'] and snapshot ['JP'].
    assert.deepEqual(mid.sort(), ['JP', 'US']);

    await handoffPromise;
    await flushMicrotasks();

    // Post-complete: snapshot from server wins.
    const after = getFollowed();
    assert.ok(after.includes('US') && after.includes('JP'));
  });

  it('snapshot from a DIFFERENT user is ignored (cross-user-leak guard)', async () => {
    // Sign in as user_curr, push their snapshot.
    const fake = makeFakeConvex({ tier: 1, initialRows: ['JP'] });
    setupSignedIn('user_curr', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_curr' });
    await flushMicrotasks();

    // Snapshot is now { userId: 'user_curr', countries: ['JP'] }.
    const before = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(before?.userId, 'user_curr');

    // Now switch to anonymous WITHOUT clearing the snapshot first
    // (tests the cross-user-leak guard in `getFollowed`).
    // The way to do this: keep the deps as user_curr but pretend
    // getCurrentClerkUser flipped to a different user_other identity
    // (simulates a Clerk-listener-vs-getCurrentClerkUser race window).
    _setDepsForTests({
      getCurrentClerkUser: () => ({ id: 'user_other' }),
    });
    // Now getFollowed should NOT include 'JP' (snapshot belongs to
    // user_curr, not user_other).
    const list = getFollowed();
    assert.equal(list.includes('JP'), false, 'cross-user snapshot ignored');
  });
});

describe('U3 — sign-out clears subscription snapshot (cross-user-leak fix)', () => {
  it('user-1 signs in, gets snapshot, signs out → snapshot cleared, getFollowed returns []', async () => {
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'JP'] });
    setupSignedIn('user_clean', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_clean' });
    await flushMicrotasks();

    // Snapshot present.
    const snap = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(snap?.userId, 'user_clean');
    assert.deepEqual(snap.countries.sort(), ['JP', 'US']);

    // Now sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    assert.equal(_getInternalStateForTests().lastKnownSubscriptionSnapshot, null);
    assert.deepEqual(getFollowed(), [], 'anonymous follow list reset');
  });
});

describe('U3 — sign-in → sign-out → different user merges anew', () => {
  it("user-1 signs in (no localStorage), signs out, user-2 signs in with their own anon localStorage", async () => {
    // user-1 path
    setLocalStorageList([]);
    const fake1 = makeFakeConvex({ tier: 1, initialRows: ['DE'] });
    setupSignedIn('user_a', { tier: 1, fakeClient: fake1 });
    await _emitAuthStateForTests({ id: 'user_a' });
    await flushMicrotasks();

    // sign out (preserves localStorage per design)
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // user-2 — anon list ['FR'] left on device; user-2 signs in
    setLocalStorageList(['FR']);
    const fake2 = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_b', { tier: 1, fakeClient: fake2 });
    await _emitAuthStateForTests({ id: 'user_b' });
    await flushMicrotasks();

    // user-2's table should have FR (merged from anon).
    assert.deepEqual(fake2._getRows(), ['FR']);
    // user-1's fake was untouched after sign-out.
    assert.deepEqual(fake1._getRows(), ['DE']);
  });
});

describe('U3 — reactive query updates dispatch change events', () => {
  it('cross-tab follow → snapshot pushed → WM_FOLLOWED_COUNTRIES_CHANGED fires', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US'] });
    setupSignedIn('user_react', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_react' });
    await flushMicrotasks();

    let events = 0;
    const unsub = subscribe(() => events++);

    // Simulate another tab adding 'FR' — push a fresh snapshot.
    _pushSubscriptionSnapshotForTests('user_react', ['US', 'FR']);

    assert.ok(events >= 1, 'change event fires on snapshot update');
    assert.deepEqual(getFollowed().sort(), ['FR', 'US']);

    unsub();
  });
});

describe('U3 — concurrent two-tab sign-in merge dedupes via OCC', () => {
  it('two emitters with overlapping lists end with deduped union', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1 });
    setupSignedIn('user_2t', { tier: 1, fakeClient: fake });

    // Simulate two sign-ins back-to-back (the second auth-state emit is a
    // duplicate event for the same user — should NOT re-run the handoff,
    // since prevUserId === nextUserId).
    await _emitAuthStateForTests({ id: 'user_2t' });
    await _emitAuthStateForTests({ id: 'user_2t' });
    await flushMicrotasks();

    // One merge call for the device (the second emit is deduped).
    assert.equal(fake._calls.merge.length, 1);
    assert.deepEqual(fake._getRows(), ['US']);
  });
});

describe('U3 — followCountry post-handoff: wire-level Convex error mapping', () => {
  it("followCountry returns FREE_CAP with currentCount/limit when Convex throws ConvexError({kind:'FREE_CAP'})", async () => {
    setLocalStorageList([]);
    const fake = makeFakeConvex({ tier: 0, capLimit: 3, initialRows: ['JP', 'CN', 'DE'] });
    setupSignedIn('user_cap', { tier: 0, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_cap' });
    await flushMicrotasks();

    const res = await addCountry('FR');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'FREE_CAP');
    assert.equal(res.currentCount, 3);
    assert.equal(res.limit, 3);
  });

  it("followCountry returns INVALID_INPUT for ConvexError({kind:'INVALID_COUNTRY'})", async () => {
    // Build a fake that throws INVALID_COUNTRY for any add.
    const fake = {
      async mutation(ref) {
        if (ref === FAKE_API.followedCountries.followCountry) {
          const e = new Error('ConvexError: INVALID_COUNTRY');
          e.data = { kind: 'INVALID_COUNTRY', country: 'XX' };
          throw e;
        }
        throw new Error('unmocked');
      },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          Promise.resolve().then(() => cb([]));
          return () => {};
        }
        throw new Error('unmocked');
      },
    };
    setupSignedIn('user_iv', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_iv' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
  });

  it("followCountry returns HANDOFF_PENDING for ConvexError({kind:'UNAUTHENTICATED'})", async () => {
    const fake = {
      async mutation(ref) {
        if (ref === FAKE_API.followedCountries.followCountry) {
          const e = new Error('ConvexError: UNAUTHENTICATED');
          e.data = { kind: 'UNAUTHENTICATED' };
          throw e;
        }
        throw new Error('unmocked');
      },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          Promise.resolve().then(() => cb([]));
          return () => {};
        }
        throw new Error('unmocked');
      },
    };
    setupSignedIn('user_un', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_un' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'HANDOFF_PENDING' });
  });
});

describe('U3 — unfollowCountry post-handoff', () => {
  it('removes existing country via Convex', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US', 'FR'] });
    setupSignedIn('user_unf', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_unf' });
    await flushMicrotasks();

    const r = await removeCountry('US');
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(fake._getRows(), ['FR']);
  });

  it('removing a not-followed country is idempotent', async () => {
    const fake = makeFakeConvex({ tier: 1, initialRows: ['US'] });
    setupSignedIn('user_idem', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_idem' });
    await flushMicrotasks();

    const r = await removeCountry('FR');
    assert.deepEqual(r, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// Phase 2 fixes — coverage for P1 #3, #4, #5, #6, #10, #11 and P2 #20.
// ---------------------------------------------------------------------------

describe('Phase2 — P1 #3 permanent ConvexError kinds skip retry, transition to failed-permanent', () => {
  it("INPUT_TOO_LARGE → 'failed-permanent'; localStorage cleared; no visibility-retry listener", async () => {
    setLocalStorageList(['US']);
    const e = new Error('ConvexError: INPUT_TOO_LARGE');
    e.data = { kind: 'INPUT_TOO_LARGE' };
    const fake = makeFakeConvex({ tier: 1, mergeRejection: e });
    setupSignedIn('user_itl', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_itl' });
    await flushMicrotasks();

    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed-permanent');
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared on permanent kind');
    assert.equal(state.hasVisibilityRetryListener, false, 'no visibility retry scheduled');
  });

  it("EMPTY_INPUT → 'failed-permanent'; no retry", async () => {
    setLocalStorageList(['US']);
    const e = new Error('ConvexError: EMPTY_INPUT');
    e.data = { kind: 'EMPTY_INPUT' };
    const fake = makeFakeConvex({ tier: 1, mergeRejection: e });
    setupSignedIn('user_ei', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_ei' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, false);
  });

  it("UNAUTHENTICATED is TRANSIENT (Codex round-4 P1) → 'failed' + retry, NOT 'failed-permanent'; localStorage retained", async () => {
    // Previously UNAUTHENTICATED was classified as permanent, which
    // cleared localStorage on every transient auth lag (Clerk emits
    // signed-in state IMMEDIATELY but Convex's setAuth callback runs
    // on the next tick). This test pins the new behavior: UNAUTHENTICATED
    // is treated as transient, the visibilitychange retry stays armed,
    // and localStorage is retained so the retry can succeed.
    setLocalStorageList(['US']);
    const e = new Error('ConvexError: UNAUTHENTICATED');
    e.data = { kind: 'UNAUTHENTICATED' };
    const fake = makeFakeConvex({ tier: 1, mergeRejection: e });
    setupSignedIn('user_un', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_un' });
    await flushMicrotasks();
    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed', 'UNAUTHENTICATED is transient');
    assert.equal(state.hasVisibilityRetryListener, true, 'retry stays armed');
    assert.notEqual(
      getLocalStorageRaw(),
      null,
      'localStorage retained for retry',
    );
  });

  it('plain network error (no ConvexError data) → still transient: failed + retry scheduled', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeRejection: new Error('NetworkError') });
    setupSignedIn('user_net', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_net' });
    await flushMicrotasks();

    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed');
    assert.equal(state.hasVisibilityRetryListener, true);
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained on transient');
  });
});

describe('Phase2 — P1 #4 max-retry exhaustion → failed-permanent; recovery via _clearFailedHandoffForTests', () => {
  it('after MAX_HANDOFF_RETRIES (5) visibility events, state flips to failed-permanent', async () => {
    setLocalStorageList(['US']);
    const fake = makeFakeConvex({ tier: 1, mergeRejection: new Error('NetworkError') });
    setupSignedIn('user_max', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_max' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Fire visibilitychange MAX_HANDOFF_RETRIES (5) times. Each attempt
    // re-fails (mergeRejection persists). On the 6th failure we expect
    // failed-permanent since attempt counter has reached the budget.
    for (let i = 0; i < 5; i++) {
      _document.dispatchEvent(new Event('visibilitychange'));
      // backoff override is 0, so the retry runs on next microtask.
      await flushMicrotasks();
      await flushMicrotasks();
    }
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, false);
  });

  it('_clearFailedHandoffForTests resets failed-permanent → idle', async () => {
    setLocalStorageList(['US']);
    const e = new Error('ConvexError: INPUT_TOO_LARGE');
    e.data = { kind: 'INPUT_TOO_LARGE' };
    const fake = makeFakeConvex({ tier: 1, mergeRejection: e });
    setupSignedIn('user_clr', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_clr' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');

    _clearFailedHandoffForTests();
    assert.equal(_getInternalStateForTests().handoffState, 'idle');
  });
});

describe('Phase2 — P1 #5 signed-in addCountry/removeCountry returns HANDOFF_PENDING when client is null', () => {
  it('addCountry: client null → HANDOFF_PENDING; localStorage NOT written', async () => {
    // User is signed in but the convex client returns null (Convex is
    // misconfigured for this env, e.g., missing VITE_CONVEX_URL). Use
    // 'force-null' to make the test getter return null directly without
    // falling through to the production import that would crash on
    // import.meta.env.
    _setDepsForTests({
      getCurrentClerkUser: () => ({ id: 'user_nullc' }),
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: (n) => n <= 1,
      featureFlagEnabled: true,
      convexClient: 'force-null',
      convexApi: 'force-null',
    });
    await _emitAuthStateForTests({ id: 'user_nullc' });
    await flushMicrotasks();

    const result = await addCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });
    assert.equal(getLocalStorageRaw(), null, 'localStorage NOT written in signed-in mode');
  });

  it('removeCountry: client null → HANDOFF_PENDING; localStorage NOT written', async () => {
    _setDepsForTests({
      getCurrentClerkUser: () => ({ id: 'user_nullc2' }),
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: (n) => n <= 1,
      featureFlagEnabled: true,
      convexClient: 'force-null',
      convexApi: 'force-null',
    });
    await _emitAuthStateForTests({ id: 'user_nullc2' });
    await flushMicrotasks();

    const result = await removeCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('Phase2 — P1 #6 stale-snapshot does NOT short-circuit signed-in mutation', () => {
  it('snapshot says US already followed BUT actual table doesnt → addCountry still calls Convex', async () => {
    // Set up a stale snapshot via _pushSubscriptionSnapshotForTests
    // BEFORE Convex confirms it. The previous behaviour would have
    // short-circuited; now we expect the Convex mutation to be called.
    const fake = makeFakeConvex({ tier: 1, initialRows: [] });
    setupSignedIn('user_stale', { tier: 1, fakeClient: fake });
    await _emitAuthStateForTests({ id: 'user_stale' });
    await flushMicrotasks();

    // Force-push a stale snapshot claiming 'US' is followed.
    _pushSubscriptionSnapshotForTests('user_stale', ['US']);

    const callsBefore = fake._calls.follow.length;
    const result = await addCountry('US');
    const callsAfter = fake._calls.follow.length;

    // P1 #6 — must have called Convex (no client-side short-circuit).
    assert.equal(result.ok, true);
    assert.equal(callsAfter, callsBefore + 1, 'Convex follow mutation called despite stale snapshot');
  });
});

describe('Phase2 — P1 #10 cross-tab storage event re-dispatches as WM_FOLLOWED_COUNTRIES_CHANGED', () => {
  it('window storage event for our key fires the watchlist change event', () => {
    _installCrossTabStorageListenerForTests();
    let fired = 0;
    const handler = () => { fired += 1; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);

    // StorageEvent shape varies; node 22 supports `new Event(...)` with key prop on synthetic.
    const ev = new Event('storage');
    Object.defineProperty(ev, 'key', { value: FOLLOWED_COUNTRIES_STORAGE_KEY });
    _window.dispatchEvent(ev);

    assert.equal(fired, 1, 'cross-tab storage event re-dispatched');
    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  });

  it('window storage event for an unrelated key does NOT fire', () => {
    _installCrossTabStorageListenerForTests();
    let fired = 0;
    const handler = () => { fired += 1; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);

    const ev = new Event('storage');
    Object.defineProperty(ev, 'key', { value: 'unrelated-key' });
    _window.dispatchEvent(ev);

    assert.equal(fired, 0);
    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  });
});

describe('Phase2 — P1 #11 post-await auth re-check returns HANDOFF_PENDING', () => {
  it('addCountry: user signs out mid-await → HANDOFF_PENDING; mutation not committed in convex view', async () => {
    // We use a delayed mutation. Mid-await, we flip Clerk to null
    // (sign-out). The post-await re-check should detect the gen change
    // and return HANDOFF_PENDING.
    let _user = { id: 'user_au' };
    let mutationStarted = null;
    const fake = {
      async mutation(ref, args) {
        if (ref === FAKE_API.followedCountries.followCountry) {
          mutationStarted = args;
          await new Promise((r) => setTimeout(r, 30));
          return { ok: true, idempotent: false };
        }
        throw new Error(`unmocked: ${ref}`);
      },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          Promise.resolve().then(() => cb([]));
          return () => {};
        }
        throw new Error(`unmocked: ${ref}`);
      },
    };
    _setDepsForTests({
      getCurrentClerkUser: () => _user,
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: (n) => n <= 1,
      featureFlagEnabled: true,
      convexClient: fake,
      convexApi: FAKE_API,
    });
    await _emitAuthStateForTests({ id: 'user_au' });
    await flushMicrotasks();

    // Kick off addCountry; while the mutation is in flight, sign out.
    const addPromise = addCountry('US');
    // Wait a tick so the mutation actually starts.
    await new Promise((r) => setTimeout(r, 5));
    _user = null;
    setupAnonymous();
    await _emitAuthStateForTests(null);

    const result = await addPromise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HANDOFF_PENDING');
    // The mutation MAY have started before sign-out (we don't undo the
    // call), but the result is dropped — addCountry returned PENDING.
    void mutationStarted;
  });
});

describe('Phase2 — P2 #20 empty-handoff path does not dispatch change before snapshot', () => {
  it('empty localStorage → handoff complete fires change ONLY after first snapshot lands', async () => {
    setLocalStorageList([]);
    let listCb = null;
    const fake = {
      async mutation() { throw new Error('not used'); },
      onUpdate(ref, _a, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          listCb = cb;
          // DELIBERATELY do NOT push the snapshot synchronously.
          return () => { if (listCb === cb) listCb = null; };
        }
        throw new Error(`unmocked: ${ref}`);
      },
    };
    setupSignedIn('user_p20', { tier: 1, fakeClient: fake });

    let events = 0;
    const unsub = subscribe(() => { events += 1; });

    await _emitAuthStateForTests({ id: 'user_p20' });
    await flushMicrotasks();

    // Handoff is 'complete' but no snapshot has arrived yet.
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.equal(_getInternalStateForTests().initialSnapshotReceived, false);
    // Empty-handoff path defers dispatchChanged → no events yet.
    assert.equal(events, 0, 'no change event before first snapshot');

    // Now push the first snapshot.
    if (listCb) listCb([]);
    assert.equal(_getInternalStateForTests().initialSnapshotReceived, true);
    assert.equal(events, 1, 'change event fires after first snapshot');

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Codex round-4 P1 — UNAUTHENTICATED is transient: handoff retries once
// Convex auth lands; localStorage is NEVER cleared on UNAUTHENTICATED.
//
// `subscribeAuthState` emits the current signed-in state IMMEDIATELY on
// subscribe, but Convex auth is not yet ready (the JWT hasn't been
// attached to the Convex client). `mergeAnonymousLocal` fires before
// Convex sees the auth and throws ConvexError({kind:'UNAUTHENTICATED'}).
// The previous classification cleared localStorage on every transient
// auth lag → anonymous follows lost on every sign-in.
// ---------------------------------------------------------------------------

describe('Codex round-4 P1 — UNAUTHENTICATED transient retry path', () => {
  it('first call throws UNAUTHENTICATED, visibility retry succeeds → final state has merged data, localStorage cleared, no follows lost', async () => {
    setLocalStorageList(['US', 'GB']);

    // Inline fake: throws UNAUTHENTICATED on the FIRST mergeAnonymousLocal
    // call, then succeeds (no rejection) on subsequent calls. This
    // simulates the exact production race: Clerk fires "signed in" first
    // tick, Convex setAuth resolves on a later tick, the visibility
    // retry then succeeds.
    let rows = [];
    let listCb = null;
    let mergeCalls = 0;
    const ConvexErrorCtor = class extends Error {
      constructor(data) {
        super(`ConvexError: ${data.kind}`);
        this.data = data;
      }
    };
    const fake = {
      async mutation(ref, args) {
        if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
          mergeCalls += 1;
          if (mergeCalls === 1) {
            throw new ConvexErrorCtor({ kind: 'UNAUTHENTICATED' });
          }
          // Second call: succeed (Convex auth has now landed).
          const accepted = [];
          for (const c of args.countries) {
            if (!rows.find((r) => r.country === c)) {
              rows.push({ country: c, addedAt: Date.now() + accepted.length });
              accepted.push(c);
            }
          }
          if (listCb) {
            const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
            listCb(sorted);
          }
          return { totalCount: rows.length, accepted, droppedInvalid: [], droppedDueToCap: [] };
        }
        throw new Error(`unmocked: ${String(ref)}`);
      },
      onUpdate(ref, _args, cb) {
        if (ref === FAKE_API.followedCountries.listFollowed) {
          listCb = cb;
          Promise.resolve().then(() => {
            const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
            if (listCb === cb) cb(sorted);
          });
          return () => { if (listCb === cb) listCb = null; };
        }
        throw new Error(`unmocked subscription: ${String(ref)}`);
      },
    };
    setupSignedIn('user_un_retry', { tier: 1, fakeClient: fake });

    // First handoff fails with UNAUTHENTICATED → state goes to 'failed'
    // (transient), not 'failed-permanent'. localStorage is RETAINED.
    await _emitAuthStateForTests({ id: 'user_un_retry' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');
    assert.equal(
      _getInternalStateForTests().hasVisibilityRetryListener,
      true,
      'visibility retry armed',
    );
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained');

    // Trigger the visibilitychange retry. The fake's second call succeeds.
    _document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Final state: merged data lives in the fake server, localStorage
    // is cleared, handoff completed.
    assert.equal(
      _getInternalStateForTests().handoffState,
      'complete',
      'retry completes the handoff',
    );
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared on success');
    assert.deepEqual(
      rows.map((r) => r.country).sort(),
      ['GB', 'US'],
      'merged data reaches the server',
    );
    assert.equal(mergeCalls, 2, 'merge attempted exactly twice');
  });

  it('UNAUTHENTICATED IS counted toward MAX_HANDOFF_RETRIES — 5 consecutive UNAUTHENTICATED throws → failed-permanent', async () => {
    // A genuinely-stuck auth mismatch (e.g., Clerk says signed-in but
    // Convex never sees the JWT for some real reason) MUST eventually
    // transition to failed-permanent rather than retry forever. The
    // budget MUST be the same MAX_HANDOFF_RETRIES used by the network-
    // failure path.
    setLocalStorageList(['US']);
    const e = new Error('ConvexError: UNAUTHENTICATED');
    e.data = { kind: 'UNAUTHENTICATED' };
    const fake = makeFakeConvex({ tier: 1, mergeRejection: e });
    setupSignedIn('user_un_max', { tier: 1, fakeClient: fake });

    await _emitAuthStateForTests({ id: 'user_un_max' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Fire visibilitychange MAX_HANDOFF_RETRIES (5) times. Each retry
    // throws UNAUTHENTICATED again. After exhausting the budget, the
    // state flips to failed-permanent.
    for (let i = 0; i < 5; i++) {
      _document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
      await flushMicrotasks();
    }
    assert.equal(
      _getInternalStateForTests().handoffState,
      'failed-permanent',
      'auth-permanent after retry budget exhausted',
    );
    assert.equal(
      _getInternalStateForTests().hasVisibilityRetryListener,
      false,
    );
  });

  it('waitForConvexAuth is awaited BEFORE the merge call, so the typical UNAUTHENTICATED race never fires', async () => {
    // Drive the deferred-by-auth flow: waitForConvexAuth resolves only
    // after a small delay; the fake captures whether mergeAnonymousLocal
    // fired BEFORE or AFTER the waitForConvexAuth resolution.
    setLocalStorageList(['US']);
    let authResolved = false;
    let mergeCalledWhileAuthPending = false;
    const fake = makeFakeConvex({ tier: 1 });
    // Wrap the fake's mutation to observe call ordering vs. auth-resolved.
    const innerMutation = fake.mutation.bind(fake);
    fake.mutation = async function (ref, args) {
      if (ref === FAKE_API.followedCountries.mergeAnonymousLocal && !authResolved) {
        mergeCalledWhileAuthPending = true;
      }
      return innerMutation(ref, args);
    };
    _setDepsForTests({
      getCurrentClerkUser: () => ({ id: 'user_wait' }),
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: (n) => n <= 1,
      featureFlagEnabled: true,
      convexClient: fake,
      convexApi: FAKE_API,
      waitForConvexAuth: async () => {
        await new Promise((r) => setTimeout(r, 0));
        authResolved = true;
        return true;
      },
    });

    await _emitAuthStateForTests({ id: 'user_wait' });
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.equal(
      mergeCalledWhileAuthPending,
      false,
      'merge fires only AFTER waitForConvexAuth resolves',
    );
    assert.equal(authResolved, true);
  });
});
