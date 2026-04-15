import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGING_MULTIPLIER,
  FRESH_MULTIPLIER,
  cadenceUnitMs,
  classifyStaleness,
  type ResilienceCadence,
} from '../server/_shared/resilience-freshness.ts';

// T1.5 Phase 1 of the country-resilience reference-grade upgrade plan.
//
// Foundation-only slice: these tests pin the staleness classifier so
// T1.6 (widget dimension confidence bar) and the later T1.5 scorer
// propagation pass can consume the classifier with confidence.

describe('resilience freshness classifier (T1.5)', () => {
  const NOW = 1_700_000_000_000; // fixed anchor: any arbitrary ms timestamp

  const CADENCES: ResilienceCadence[] = ['realtime', 'daily', 'weekly', 'monthly', 'annual'];

  it('cadenceUnitMs returns a positive duration for every cadence', () => {
    for (const cadence of CADENCES) {
      const unit = cadenceUnitMs(cadence);
      assert.ok(unit > 0, `${cadence} should have a positive cadence unit`);
    }
  });

  it('cadence units are ordered strictly: realtime < daily < weekly < monthly < annual', () => {
    const units = CADENCES.map((c) => cadenceUnitMs(c));
    for (let i = 1; i < units.length; i += 1) {
      assert.ok(
        units[i] > units[i - 1],
        `${CADENCES[i]} cadence unit (${units[i]}) should be strictly greater than ${CADENCES[i - 1]} (${units[i - 1]})`,
      );
    }
  });

  it('fresh when age is well below FRESH_MULTIPLIER * cadence unit', () => {
    for (const cadence of CADENCES) {
      const unit = cadenceUnitMs(cadence);
      // Age = 0.5 * unit, well under FRESH_MULTIPLIER = 1.5
      const result = classifyStaleness({
        lastObservedAtMs: NOW - unit * 0.5,
        cadence,
        nowMs: NOW,
      });
      assert.equal(result.staleness, 'fresh', `${cadence} at 0.5x should be fresh`);
      assert.ok(result.ageInCadenceUnits >= 0 && result.ageInCadenceUnits < FRESH_MULTIPLIER);
    }
  });

  it('aging when age sits between FRESH_MULTIPLIER and AGING_MULTIPLIER', () => {
    for (const cadence of CADENCES) {
      const unit = cadenceUnitMs(cadence);
      // Age = 2 * unit, between FRESH_MULTIPLIER (1.5) and AGING_MULTIPLIER (3)
      const result = classifyStaleness({
        lastObservedAtMs: NOW - unit * 2,
        cadence,
        nowMs: NOW,
      });
      assert.equal(result.staleness, 'aging', `${cadence} at 2x should be aging`);
      assert.ok(result.ageInCadenceUnits >= FRESH_MULTIPLIER && result.ageInCadenceUnits < AGING_MULTIPLIER);
    }
  });

  it('stale when age is at or beyond AGING_MULTIPLIER * cadence unit', () => {
    for (const cadence of CADENCES) {
      const unit = cadenceUnitMs(cadence);
      // Age = 5 * unit, well beyond AGING_MULTIPLIER
      const result = classifyStaleness({
        lastObservedAtMs: NOW - unit * 5,
        cadence,
        nowMs: NOW,
      });
      assert.equal(result.staleness, 'stale', `${cadence} at 5x should be stale`);
      assert.ok(result.ageInCadenceUnits >= AGING_MULTIPLIER);
    }
  });

  it('stale when lastObservedAtMs is null, undefined, NaN, or in the future', () => {
    // Raised in PR #2947 review: pin `ageMs` AND `ageInCadenceUnits` as
    // POSITIVE_INFINITY on every defensive branch so a future regression
    // that accidentally omits one field from the defensive return is
    // caught immediately. The earlier version only checked `ageMs` on
    // the null branch and staleness on the rest.
    for (const cadence of CADENCES) {
      const missingNull = classifyStaleness({ lastObservedAtMs: null, cadence, nowMs: NOW });
      assert.equal(missingNull.staleness, 'stale', `${cadence} null should be stale`);
      assert.equal(missingNull.ageMs, Number.POSITIVE_INFINITY, `${cadence} null ageMs should be Infinity`);
      assert.equal(missingNull.ageInCadenceUnits, Number.POSITIVE_INFINITY, `${cadence} null ageInCadenceUnits should be Infinity`);

      const missingUndefined = classifyStaleness({ lastObservedAtMs: undefined, cadence, nowMs: NOW });
      assert.equal(missingUndefined.staleness, 'stale', `${cadence} undefined should be stale`);
      assert.equal(missingUndefined.ageMs, Number.POSITIVE_INFINITY, `${cadence} undefined ageMs should be Infinity`);
      assert.equal(missingUndefined.ageInCadenceUnits, Number.POSITIVE_INFINITY, `${cadence} undefined ageInCadenceUnits should be Infinity`);

      const nanResult = classifyStaleness({ lastObservedAtMs: Number.NaN, cadence, nowMs: NOW });
      assert.equal(nanResult.staleness, 'stale', `${cadence} NaN should be stale`);
      assert.equal(nanResult.ageMs, Number.POSITIVE_INFINITY, `${cadence} NaN ageMs should be Infinity`);
      assert.equal(nanResult.ageInCadenceUnits, Number.POSITIVE_INFINITY, `${cadence} NaN ageInCadenceUnits should be Infinity`);

      // A timestamp 10 minutes in the future is nonsensical and treated as stale.
      const futureResult = classifyStaleness({
        lastObservedAtMs: NOW + 10 * 60 * 1000,
        cadence,
        nowMs: NOW,
      });
      assert.equal(futureResult.staleness, 'stale', `${cadence} future timestamp should be stale`);
      assert.equal(futureResult.ageMs, Number.POSITIVE_INFINITY, `${cadence} future ageMs should be Infinity`);
      assert.equal(futureResult.ageInCadenceUnits, Number.POSITIVE_INFINITY, `${cadence} future ageInCadenceUnits should be Infinity`);
    }
  });

  it('defaults to Date.now() when nowMs is omitted', () => {
    const now = Date.now();
    // A recent observation should always be fresh against real Date.now()
    // without specifying nowMs explicitly. Small tolerance for clock drift.
    const result = classifyStaleness({
      lastObservedAtMs: now - 60_000, // 60 seconds ago
      cadence: 'daily',
    });
    assert.equal(result.staleness, 'fresh');
    assert.ok(result.ageMs >= 60_000 && result.ageMs < 120_000);
  });

  it('exact threshold boundaries (FRESH and AGING multipliers are strict upper bounds for their class)', () => {
    const unit = cadenceUnitMs('daily');

    // age = FRESH_MULTIPLIER * unit (exactly at boundary) should be aging,
    // not fresh, because the comparison is strict `<`.
    const atFreshBoundary = classifyStaleness({
      lastObservedAtMs: NOW - unit * FRESH_MULTIPLIER,
      cadence: 'daily',
      nowMs: NOW,
    });
    assert.equal(atFreshBoundary.staleness, 'aging', 'exact FRESH_MULTIPLIER boundary is aging');

    // age = AGING_MULTIPLIER * unit (exactly at boundary) should be stale,
    // not aging, because the comparison is strict `<`.
    const atAgingBoundary = classifyStaleness({
      lastObservedAtMs: NOW - unit * AGING_MULTIPLIER,
      cadence: 'daily',
      nowMs: NOW,
    });
    assert.equal(atAgingBoundary.staleness, 'stale', 'exact AGING_MULTIPLIER boundary is stale');

    // age = 0 should be fresh.
    const atZero = classifyStaleness({
      lastObservedAtMs: NOW,
      cadence: 'daily',
      nowMs: NOW,
    });
    assert.equal(atZero.staleness, 'fresh', 'zero age is fresh');
  });

  it('ageMs and ageInCadenceUnits are internally consistent', () => {
    const result = classifyStaleness({
      lastObservedAtMs: NOW - 36 * 60 * 60 * 1000, // 36 hours ago
      cadence: 'daily',
      nowMs: NOW,
    });
    assert.equal(result.ageMs, 36 * 60 * 60 * 1000);
    assert.equal(result.ageInCadenceUnits, 1.5);
    // 36 hours at daily cadence is exactly FRESH_MULTIPLIER, so aging.
    assert.equal(result.staleness, 'aging');
  });

  it('classifier is pure: same inputs produce same outputs', () => {
    const args = {
      lastObservedAtMs: NOW - 12 * 60 * 60 * 1000,
      cadence: 'daily' as const,
      nowMs: NOW,
    };
    const a = classifyStaleness(args);
    const b = classifyStaleness(args);
    const c = classifyStaleness({ ...args });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });
});
