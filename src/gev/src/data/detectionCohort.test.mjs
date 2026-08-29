import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedCohort,
  cohortCapForQuota,
  stableIdentityHash,
} from './detectionCohort.js';

function observation(index, priority = 25, band = 8) {
  return {
    _cohortSourceId: index,
    _cohortPriority: priority,
    _cohortBand: band,
    _cohortHash: stableIdentityHash('satellites', index),
  };
}

test('cohort cap follows min(256, max(64, 4 × quota))', () => {
  assert.equal(cohortCapForQuota(0), 64);
  assert.equal(cohortCapForQuota(10), 64);
  assert.equal(cohortCapForQuota(20), 80);
  assert.equal(cohortCapForQuota(90), 256);
});

test('12k contender population stays bounded and registration-order independent', () => {
  const items = Array.from({ length: 12000 }, (_, index) => observation(index));
  const forward = new BoundedCohort();
  const reverse = new BoundedCohort();
  for (const item of items) forward.consider(item);
  for (let i = items.length - 1; i >= 0; i--) reverse.consider(items[i]);
  const a = forward.values(256).map((item) => item._cohortSourceId);
  const b = reverse.values(256).map((item) => item._cohortSourceId);
  assert.equal(a.length, 256);
  assert.deepEqual(a, b);
});

test('incumbents are admitted before stronger new contenders', () => {
  const cohort = new BoundedCohort();
  cohort.consider(observation('incumbent', 1, 1), true);
  for (let i = 0; i < 100; i++) cohort.consider(observation(i, 120, 8));
  const selected = cohort.values(64);
  assert.equal(selected[0]._cohortSourceId, 'incumbent');
  assert.equal(selected.length, 64);
});
