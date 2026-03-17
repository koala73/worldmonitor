import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTagPlan,
  bumpVersion,
} from '../scripts/release-prepare.mjs';

test('release prepare calculates semver bumps', () => {
  assert.equal(bumpVersion('2.7.1', 'patch'), '2.7.2');
  assert.equal(bumpVersion('2.7.1', 'minor'), '2.8.0');
  assert.equal(bumpVersion('2.7.1', 'major'), '3.0.0');
});

test('release prepare creates the expected tag plan for multi-variant releases', () => {
  assert.deepEqual(
    buildTagPlan('2.7.2', ['full', 'tech', 'finance']),
    ['v2.7.2', 'v2.7.2-tech', 'v2.7.2-finance'],
  );
});
