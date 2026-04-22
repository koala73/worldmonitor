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
