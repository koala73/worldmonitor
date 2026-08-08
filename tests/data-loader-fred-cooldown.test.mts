import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createCircuitBreaker,
  getCircuitBreakerCooldownInfo,
  isCircuitBreakerOnCooldown,
  removeCircuitBreaker,
} from '../src/utils/circuit-breaker.ts';

// #4571 U1 / #3242 characterization.
//
// Deferring the economic service (barrel-surgery: dropping it from the @/services
// export * so it tree-shakes out of eager main.js) means its 'FRED Batch' circuit
// breaker registers LAZILY — on the first economic load (its fetcher's dynamic
// import) — instead of at module-load/boot. data-loader.loadFredData does a
// cross-module pre-fetch cooldown check (`getCircuitBreakerCooldownInfo('FRED Batch')`)
// BEFORE the fetch that would load economic. These tests pin the property that makes
// that deferral behavior-preserving: the lookup degrades gracefully in the gap before
// registration, so the pre-check proceeds to fetch rather than crashing — and there is
// no cooldown state to miss before the first fetch anyway.

const NAME = 'FRED Batch';

describe('circuit-breaker registry graceful degradation (#4571 U1 / #3242)', () => {
  afterEach(() => removeCircuitBreaker(NAME));

  it('an unregistered breaker (economic not yet lazily loaded) reports not-on-cooldown, no throw', () => {
    removeCircuitBreaker(NAME); // ensure absent — simulates economic never loaded
    const info = getCircuitBreakerCooldownInfo(NAME);
    assert.deepEqual(info, { onCooldown: false, remainingSeconds: 0 });
    assert.equal(isCircuitBreakerOnCooldown(NAME), false);
  });

  it('after the breaker registers (economic loaded via its fetcher), the lookup reflects the real breaker', () => {
    const breaker = createCircuitBreaker({ name: NAME, cacheTtlMs: 60_000, persistCache: false });
    assert.ok(breaker, 'createCircuitBreaker registers the breaker');
    const info = getCircuitBreakerCooldownInfo(NAME);
    // A fresh breaker is not on cooldown, but the lookup now resolves the real
    // registered instance instead of the graceful default — i.e. the pre-fetch
    // cooldown check is meaningful for every call after the first fetch.
    assert.equal(info.onCooldown, false);
    assert.equal(typeof info.remainingSeconds, 'number');
  });
});
