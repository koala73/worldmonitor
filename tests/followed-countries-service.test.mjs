/**
 * Tests for src/services/followed-countries.ts (U2 — anonymous-mode only).
 *
 * U3 will add a sibling test file
 * (followed-countries-sign-in-handoff.test.mjs) for the auth-state
 * orchestration; signed-in mutations and the Convex bridge are
 * intentionally NOT tested here.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs (localStorage + window with addEventListener / dispatchEvent)
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
  // CustomEvent is available in Node 19+; ensure presence.
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

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
});

// ---------------------------------------------------------------------------
// Import service (after globals are stubbed)
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  isFollowed,
  subscribe,
  serviceEntitlementState,
  FREE_TIER_FOLLOW_LIMIT,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
  _emitAuthStateForTests,
} = svc;

// ---------------------------------------------------------------------------
// In-memory fake Convex client for signed-in tests
// ---------------------------------------------------------------------------
// Mirrors the relevant behaviour of `convex/followedCountries.ts` mutations
// + listFollowed query so signed-in tests exercise the full Convex code
// path without a real server.

const FAKE_API = {
  followedCountries: {
    followCountry: 'fake:followCountry',
    unfollowCountry: 'fake:unfollowCountry',
    mergeAnonymousLocal: 'fake:mergeAnonymousLocal',
    listFollowed: 'fake:listFollowed',
  },
};

function makeFakeConvex({ tier, capLimit = 3 }) {
  const rows = []; // {country, addedAt}
  let listFollowedCb = null;
  const fireSnapshot = () => {
    if (!listFollowedCb) return;
    const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
    listFollowedCb(sorted);
  };
  const ConvexErrorCtor = class extends Error {
    constructor(data) {
      super(`ConvexError: ${data.kind}`);
      this.data = data;
    }
  };
  const client = {
    async mutation(ref, args) {
      if (ref === FAKE_API.followedCountries.followCountry) {
        const { country } = args;
        if (rows.find((r) => r.country === country)) {
          return { ok: true, idempotent: true };
        }
        if (tier < 1 && rows.length >= capLimit) {
          throw new ConvexErrorCtor({ kind: 'FREE_CAP', currentCount: rows.length, limit: capLimit });
        }
        rows.push({ country, addedAt: Date.now() + rows.length });
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.unfollowCountry) {
        const { country } = args;
        const idx = rows.findIndex((r) => r.country === country);
        if (idx === -1) return { ok: true, idempotent: true };
        rows.splice(idx, 1);
        fireSnapshot();
        return { ok: true, idempotent: false };
      }
      if (ref === FAKE_API.followedCountries.mergeAnonymousLocal) {
        const { countries } = args;
        if (countries.length === 0) {
          throw new ConvexErrorCtor({ kind: 'EMPTY_INPUT' });
        }
        const droppedInvalid = [];
        const validInputs = [];
        const ISO_RE = /^[A-Z]{2}$/;
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
      throw new Error(`unmocked mutation: ${ref}`);
    },
    onUpdate(ref, _args, onResult /* , onError */) {
      if (ref === FAKE_API.followedCountries.listFollowed) {
        listFollowedCb = onResult;
        // Fire the initial snapshot synchronously after a microtask, mimicking Convex.
        Promise.resolve().then(() => {
          const sorted = [...rows].sort((a, b) => a.addedAt - b.addedAt).map((r) => r.country);
          if (listFollowedCb === onResult) onResult(sorted);
        });
        return () => {
          if (listFollowedCb === onResult) listFollowedCb = null;
        };
      }
      throw new Error(`unmocked subscription: ${ref}`);
    },
  };
  return { client, getRows: () => rows };
}

// Default deps for tests: anonymous user (Clerk null), entitlement null.
function setAnonymous() {
  _setDepsForTests({
    getCurrentClerkUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

async function setSignedInPro() {
  const fake = makeFakeConvex({ tier: 1 });
  _setDepsForTests({
    getCurrentClerkUser: () => ({ id: 'user_pro' }),
    getEntitlementState: () => ({ features: { tier: 1 } }),
    hasTier: (n) => n <= 1,
    featureFlagEnabled: true,
    convexClient: fake.client,
    convexApi: FAKE_API,
  });
  // Drive the handoff to 'complete' so legacy tests don't see HANDOFF_PENDING.
  await _emitAuthStateForTests({ id: 'user_pro' });
  // Allow the reactive subscription's initial-snapshot microtask to fire.
  await new Promise((r) => setTimeout(r, 0));
  return fake;
}

async function setSignedInFreeLoaded() {
  const fake = makeFakeConvex({ tier: 0 });
  _setDepsForTests({
    getCurrentClerkUser: () => ({ id: 'user_free' }),
    getEntitlementState: () => ({ features: { tier: 0 } }),
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: fake.client,
    convexApi: FAKE_API,
  });
  await _emitAuthStateForTests({ id: 'user_free' });
  await new Promise((r) => setTimeout(r, 0));
  return fake;
}

function setSignedInLoading() {
  _setDepsForTests({
    getCurrentClerkUser: () => ({ id: 'user_loading' }),
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    convexClient: null,
    convexApi: null,
  });
}

beforeEach(() => {
  _resetStateForTests();
  setAnonymous();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('followed-countries service — constants & key', () => {
  it('exports FREE_TIER_FOLLOW_LIMIT === 3', () => {
    assert.equal(FREE_TIER_FOLLOW_LIMIT, 3);
  });

  it('uses storage key wm-followed-countries-v1', () => {
    assert.equal(FOLLOWED_COUNTRIES_STORAGE_KEY, 'wm-followed-countries-v1');
  });

  it('exports event name wm-followed-countries-changed', () => {
    assert.equal(WM_FOLLOWED_COUNTRIES_CHANGED, 'wm-followed-countries-changed');
  });
});

describe('followed-countries service — happy path (anonymous)', () => {
  it("addCountry('US') → {ok:true}; getFollowed() → ['US']", async () => {
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("addCountry('USA') normalizes alpha-3 to 'US'", async () => {
    const res = await addCountry('USA');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("removeCountry('US') empties the list", async () => {
    await addCountry('US');
    const res = await removeCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), []);
  });

  it('isFollowed reflects state and case-folds', async () => {
    assert.equal(isFollowed('US'), false);
    await addCountry('US');
    assert.equal(isFollowed('US'), true);
    assert.equal(isFollowed('us'), true);
    assert.equal(isFollowed('USA'), true);
  });
});

describe('followed-countries service — subscribe', () => {
  it('handler fires after add and after remove; unsubscribe stops further fires', async () => {
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });

    await addCountry('US');
    assert.equal(count, 1);

    await removeCountry('US');
    assert.equal(count, 2);

    unsub();
    await addCountry('FR');
    assert.equal(count, 2, 'no further fires after unsubscribe');
  });

  it('does not fire on no-op idempotent add', async () => {
    await addCountry('US');
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });
    await addCountry('US'); // idempotent
    assert.equal(count, 0);
    unsub();
  });

  it('does not fire on no-op idempotent remove', async () => {
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });
    await removeCountry('FR'); // not present
    assert.equal(count, 0);
    unsub();
  });
});

describe('followed-countries service — idempotency & invalid input', () => {
  it('addCountry twice → second {ok:true}, single entry', async () => {
    const r1 = await addCountry('US');
    const r2 = await addCountry('US');
    assert.deepEqual(r1, { ok: true });
    assert.deepEqual(r2, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("addCountry('Atlantis') → INVALID_INPUT", async () => {
    const res = await addCountry('Atlantis');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
    assert.deepEqual(getFollowed(), []);
  });

  it("removeCountry('Atlantis') → INVALID_INPUT", async () => {
    const res = await removeCountry('Atlantis');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
  });
});

describe('followed-countries service — STORAGE_FULL', () => {
  it('localStorage quota throw on save → returns STORAGE_FULL, no event fires', async () => {
    let eventFires = 0;
    const unsub = subscribe(() => {
      eventFires += 1;
    });

    _localStorage.throwOnSet = true;
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'STORAGE_FULL' });
    assert.equal(eventFires, 0);
    unsub();
  });
});

describe('followed-countries service — FREE_CAP', () => {
  it('signed-in free user at cap of 3: 4th add returns FREE_CAP, list unchanged', async () => {
    await setSignedInFreeLoaded();
    assert.deepEqual(await addCountry('US'), { ok: true });
    assert.deepEqual(await addCountry('FR'), { ok: true });
    assert.deepEqual(await addCountry('DE'), { ok: true });
    const res = await addCountry('JP');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'FREE_CAP');
    assert.equal(res.currentCount, 3);
    assert.equal(res.limit, 3);
    assert.deepEqual(getFollowed().sort(), ['DE', 'FR', 'US']);
  });
});

describe('followed-countries service — PRO no cap', () => {
  it('PRO user can add 50 countries successfully', async () => {
    await setSignedInPro();
    const codes = [
      'US','GB','FR','DE','IT','ES','PT','NL','BE','CH',
      'AT','SE','NO','DK','FI','IS','IE','PL','CZ','HU',
      'RO','BG','GR','TR','RU','UA','BY','EE','LV','LT',
      'JP','KR','CN','IN','ID','TH','VN','PH','SG','MY',
      'AU','NZ','BR','AR','CL','CO','MX','CA','EG','ZA',
    ];
    assert.equal(codes.length, 50);
    for (const c of codes) {
      assert.deepEqual(await addCountry(c), { ok: true }, `add ${c}`);
    }
    assert.equal(getFollowed().length, 50);
  });
});

describe('followed-countries service — entitlement loading', () => {
  it('signed-in user, entitlement state null → ENTITLEMENT_LOADING', async () => {
    setSignedInLoading();
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'ENTITLEMENT_LOADING' });
    assert.deepEqual(getFollowed(), []);
  });

  it('serviceEntitlementState() reports loading when signed-in + null entitlement', () => {
    setSignedInLoading();
    assert.equal(serviceEntitlementState(), 'loading');
  });
});

describe('followed-countries service — anonymous never blocks on entitlement loading', () => {
  it("Codex round-2 finding #1: anon user with entitlement null treated as 'free' immediately, can add 3, 4th hits FREE_CAP", async () => {
    // Default `setAnonymous()` already gives null entitlement.
    assert.equal(serviceEntitlementState(), 'free');
    assert.deepEqual(await addCountry('US'), { ok: true });
    assert.deepEqual(await addCountry('FR'), { ok: true });
    assert.deepEqual(await addCountry('DE'), { ok: true });
    const res = await addCountry('JP');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'FREE_CAP');
  });
});

describe('followed-countries service — feature flag', () => {
  it('flag off: addCountry/removeCountry return DISABLED, storage unchanged, no event', async () => {
    let eventFires = 0;
    const unsub = subscribe(() => {
      eventFires += 1;
    });

    _setDepsForTests({ featureFlagEnabled: false });

    const a = await addCountry('US');
    assert.deepEqual(a, { ok: false, reason: 'DISABLED' });
    const r = await removeCountry('US');
    assert.deepEqual(r, { ok: false, reason: 'DISABLED' });

    assert.equal(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY), null);
    assert.equal(eventFires, 0);
    unsub();
  });
});

describe('followed-countries service — corrupt / wrong-shape localStorage', () => {
  it('non-JSON value → getFollowed() returns []', () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, 'not-json{');
    assert.deepEqual(getFollowed(), []);
  });

  it('JSON missing countries field → []', () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    assert.deepEqual(getFollowed(), []);
  });

  it("wrong-shape value (e.g. '[{\"symbol\":\"AAPL\"}]') → []", () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify([{ symbol: 'AAPL' }]),
    );
    assert.deepEqual(getFollowed(), []);
  });

  it('countries field is not an array → []', () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: 'US,FR' }),
    );
    assert.deepEqual(getFollowed(), []);
  });

  it('countries field has invalid entries — they are dropped, valid ones returned', () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'Atlantis', 42, 'FR'] }),
    );
    assert.deepEqual(getFollowed(), ['US', 'FR']);
  });
});
