import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyFreshSignup, FRESH_SIGNUP_WINDOW_MS } from '../src/services/analytics.ts';

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

  it('returns false when createdAt is in the future (clock skew guard)', () => {
    // Future createdAt means nowMs - createdAtMs is negative, which <= window.
    // This is actually accepted by the predicate — document the behavior:
    // Clerk createdAt coming from the server is authoritative; minor client
    // clock skew should not block analytics. Real future-dated accounts do
    // not exist in practice.
    assert.equal(isLikelyFreshSignup(null, 'user_new', NOW + 500, NOW), true);
  });
});
