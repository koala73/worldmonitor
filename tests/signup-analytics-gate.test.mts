import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';

// Stub window.localStorage before importing the module under test —
// the signup dedupe uses localStorage (cross-tab scope) and node:test
// runs without a DOM.
const _store = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => _store.get(k) ?? null,
        setItem: (k: string, v: string) => { _store.set(k, v); },
        removeItem: (k: string) => { _store.delete(k); },
      },
    },
  });
});

const {
  isLikelyFreshSignup,
  FRESH_SIGNUP_WINDOW_MS,
  hasTrackedSignupInSession,
  markSignupTrackedInSession,
} = await import('../src/services/analytics.ts');

const NOW = 1_700_000_000_000;

describe('isLikelyFreshSignup', () => {
  it('returns true on null→non-null transition with createdAt within window', () => {
    assert.equal(isLikelyFreshSignup(null, 'user_new', NOW - 1_000, NOW), true);
  });

  it('returns true at exactly the window boundary', () => {
    assert.equal(isLikelyFreshSignup(null, 'user_new', NOW - FRESH_SIGNUP_WINDOW_MS, NOW), true);
  });

  it('returns false when createdAt is older than the fresh window', () => {
    assert.equal(
      isLikelyFreshSignup(null, 'user_returning', NOW - FRESH_SIGNUP_WINDOW_MS - 1, NOW),
      false,
    );
  });

  it('returns false when there was a prior user (sign-in, not sign-up)', () => {
    assert.equal(isLikelyFreshSignup('user_prev', 'user_next', NOW - 500, NOW), false);
  });

  it('returns false on sign-out transitions', () => {
    assert.equal(isLikelyFreshSignup('user_prev', null, null, NOW), false);
  });

  it('returns false when createdAt is unavailable', () => {
    assert.equal(isLikelyFreshSignup(null, 'user_new', null, NOW), false);
  });

  it('returns false when no transition occurred (same id)', () => {
    assert.equal(isLikelyFreshSignup('user_x', 'user_x', NOW - 500, NOW), false);
  });

  it('accepts tiny forward clock skew (createdAt slightly ahead of now)', () => {
    // Clerk's server clock can be up to a few seconds ahead of a
    // client clock. A createdAt 500ms in the future is a real-world
    // clock-skew case and should count as fresh.
    assert.equal(isLikelyFreshSignup(null, 'user_new', NOW + 500, NOW), true);
  });

  it('rejects createdAt unrealistically far in the future (malformed)', () => {
    // 10 minutes in the future is not clock skew — it's a bug or a
    // malicious client-side clock. Must not fire trackSignUp.
    assert.equal(isLikelyFreshSignup(null, 'user_new', NOW + 10 * 60 * 1000, NOW), false);
  });
});

describe('signup tracking session marker', () => {
  beforeEach(() => {
    _store.clear();
  });

  it('starts as not tracked', () => {
    assert.equal(hasTrackedSignupInSession('user_X'), false);
  });

  it('mark → has returns true for same user', () => {
    markSignupTrackedInSession('user_X');
    assert.equal(hasTrackedSignupInSession('user_X'), true);
  });

  it('tracked state is keyed per user (account switch re-counts)', () => {
    markSignupTrackedInSession('user_X');
    assert.equal(hasTrackedSignupInSession('user_Y'), false);
  });

  it('tracked marker persists across multiple reads (idempotent)', () => {
    markSignupTrackedInSession('user_X');
    assert.equal(hasTrackedSignupInSession('user_X'), true);
    assert.equal(hasTrackedSignupInSession('user_X'), true);
  });
});
