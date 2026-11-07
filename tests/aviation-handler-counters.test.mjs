// Aviation server-side handler counters.
//
// Tests the in-memory provider counter module used by the NOTAM and aviation
// news handlers on the Vercel side. The aviationStack* fields left with the
// edge collector they counted (#8093); the seeder owns that provider now.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  incrementProviderCounter,
  getProviderCounters,
  resetProviderCounters,
} from '../server/worldmonitor/aviation/v1/_counters.ts';

test('incrementProviderCounter: increments the specified field', () => {
  resetProviderCounters();
  incrementProviderCounter('notamSuccess');
  const counts = getProviderCounters();
  assert.equal(counts.notamSuccess, 1);
  assert.equal(counts.notamTimeout, 0);
});

test('incrementProviderCounter: successive increments accumulate', () => {
  resetProviderCounters();
  incrementProviderCounter('notamTimeout', 3);
  incrementProviderCounter('notamSuccess', 2);
  const counts = getProviderCounters();
  assert.equal(counts.notamTimeout, 3);
  assert.equal(counts.notamSuccess, 2);
});

test('getProviderCounters: returns a snapshot, not a reference', () => {
  resetProviderCounters();
  const snapshot = getProviderCounters();
  incrementProviderCounter('notamSuccess');
  assert.equal(snapshot.notamSuccess, 0);
  assert.equal(getProviderCounters().notamSuccess, 1);
});

test('the counter set carries no provider without an edge incrementer', () => {
  // #8093 deleted the edge AviationStack collector; a counter nothing
  // increments reads as a permanently healthy zero, which is worse than no
  // counter at all.
  for (const key of Object.keys(getProviderCounters())) {
    assert.doesNotMatch(key, /^aviationStack/, `${key} has no incrementer left`);
  }
});

test('resetProviderCounters: resets all counters to zero', () => {
  incrementProviderCounter('notamSuccess', 5);
  incrementProviderCounter('notamTimeout', 2);
  incrementProviderCounter('aviationNewsAuthRejection', 1);
  resetProviderCounters();
  const counts = getProviderCounters();
  for (const key of Object.keys(counts)) {
    assert.equal(counts[key], 0, `${key} should be 0 after reset`);
  }
});