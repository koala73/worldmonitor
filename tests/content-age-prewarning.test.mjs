// Boundary tests for the CONTENT_AGE_PREWARNING derivation.
//
// The pre-warning is reader policy: at >= 80% of budget but not yet stale,
// assessContentAge() exposes a preWarning block; hard-stale paths never do.
// Proves: threshold boundaries (inclusive at 80%, inclusive at 100% because
// hard stale is strict >), breach instant derivation that agrees with the
// Math.round age math, and fail-closed behavior for undatable/future/invalid
// metadata.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessContentAge, CONTENT_AGE_PREWARNING_RATIO } from '../api/_content-age.js';

const NOW = 1_700_000_000_000;
const ONE_MIN_MS = 60_000;
const DAY_MIN = 1440;

function metaFor({ ageMin, budgetMin, overrides = {} }) {
  return {
    newestItemAt: NOW - ageMin * ONE_MIN_MS,
    oldestItemAt: NOW - (ageMin + 10 * DAY_MIN) * ONE_MIN_MS,
    maxContentAgeMin: budgetMin,
    ...overrides,
  };
}

test('CONTENT_AGE_PREWARNING_RATIO is the fleet-wide 0.8 policy', () => {
  assert.equal(CONTENT_AGE_PREWARNING_RATIO, 0.8);
});

test('below threshold: no preWarning, not stale', () => {
  // 79.99% of 1000m budget: age 799
  const a = assessContentAge(metaFor({ ageMin: 799, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, false);
  assert.equal(a.preWarning, null);
});

test('exact threshold: preWarning active (inclusive at 80%)', () => {
  const a = assessContentAge(metaFor({ ageMin: 800, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, false);
  assert.ok(a.preWarning, 'preWarning present at exactly 80%');
  assert.equal(a.preWarning.warnAtContentAgeMin, 800);
  assert.equal(a.preWarning.remainingContentAgeMin, 200);
  assert.equal(typeof a.preWarning.breachAt, 'string');
});

test('just under hard budget: preWarning still active', () => {
  const a = assessContentAge(metaFor({ ageMin: 999, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, false);
  assert.ok(a.preWarning);
  assert.equal(a.preWarning.remainingContentAgeMin, 1);
});

test('exact hard budget: preWarning active (stale rule is strict >)', () => {
  const a = assessContentAge(metaFor({ ageMin: 1000, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, false);
  assert.ok(a.preWarning);
  assert.equal(a.preWarning.remainingContentAgeMin, 0);
});

test('one minute past budget: contentStale, preWarning null', () => {
  const a = assessContentAge(metaFor({ ageMin: 1001, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, true);
  assert.equal(a.preWarning, null);
});

test('breachAt agrees with the Math.round age derivation', () => {
  // budget 1000m, newestItemAt N. breachAt must be the first instant whose
  // rounded age strictly exceeds 1000.
  const budgetMin = 1000;
  const newestItemAt = NOW;
  // Age the check inside the pre-warning window so the block is present.
  const a = assessContentAge(
    { newestItemAt, oldestItemAt: newestItemAt, maxContentAgeMin: budgetMin },
    NOW + 900 * 60_000,
  );
  const breachMs = Date.parse(a.preWarning.breachAt);
  assert.ok(Number.isFinite(breachMs));
  // Exactly at breachAt - 1ms: rounded age == budget -> not stale.
  const ageAtBoundary = Math.round((breachMs - 1 - newestItemAt) / ONE_MIN_MS);
  assert.ok(ageAtBoundary <= budgetMin, 'age just before breachAt is within budget');
  // Exactly at breachAt: rounded age > budget -> stale.
  const ageAtBreach = Math.round((breachMs - newestItemAt) / ONE_MIN_MS);
  assert.ok(ageAtBreach > budgetMin, 'age at breachAt is strictly past budget');
});

test('warnAtContentAgeMin is ceil(0.8 * budget) for non-round budgets', () => {
  // 10 * 0.8 = 8 exactly; 7 * 0.8 = 5.6 -> ceil = 6
  const seven = assessContentAge(metaFor({ ageMin: 6, budgetMin: 7 }), NOW);
  assert.equal(seven.preWarning.warnAtContentAgeMin, 6);
  const under = assessContentAge(metaFor({ ageMin: 5, budgetMin: 7 }), NOW);
  assert.equal(under.preWarning, null);
});

test('undatable newestItemAt: stale, no preWarning (fail closed)', () => {
  const a = assessContentAge({
    newestItemAt: null,
    oldestItemAt: null,
    maxContentAgeMin: 1000,
  }, NOW);
  assert.equal(a.contentStale, true);
  assert.equal(a.preWarning, null);
});

test('future-dated newestItemAt: stale, no preWarning', () => {
  const a = assessContentAge(metaFor({ ageMin: -50, budgetMin: 1000 }), NOW);
  assert.equal(a.contentStale, true);
  assert.equal(a.preWarning, null);
});

test('non-positive budget: stale, no preWarning (division guard)', () => {
  for (const budget of [0, -5]) {
    const a = assessContentAge(metaFor({ ageMin: 5, budgetMin: budget }), NOW);
    assert.equal(a.contentStale, true, `budget ${budget} must be stale`);
    assert.equal(a.preWarning, null);
  }
});

test('legacy seeders (no budget) still get null from the assessor', () => {
  assert.equal(assessContentAge({ newestItemAt: NOW }, NOW), null);
  assert.equal(assessContentAge(null, NOW), null);
});

test('preWarning never coexists with contentStale across the boundary sweep', () => {
  for (let ageMin = 700; ageMin <= 1100; ageMin += 1) {
    const a = assessContentAge(metaFor({ ageMin, budgetMin: 1000 }), NOW);
    if (a.contentStale) {
      assert.equal(a.preWarning, null, `stale at ${ageMin} must have no preWarning`);
    }
  }
});
