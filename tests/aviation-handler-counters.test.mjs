// Aviation server-side handler counters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  incrementProviderCounter,
  getProviderCounters,
  resetProviderCounters,
} from '../server/worldmonitor/aviation/v1/_counters.ts';

test('incrementProviderCounter: increments the specified field', () => {
  resetProviderCounters();
  incrementProviderCounter('aviationNewsSuccess');
  const counts = getProviderCounters();
  assert.equal(counts.aviationNewsSuccess, 1);
  assert.equal(counts.aviationNewsTimeout, 0);
});

test('incrementProviderCounter: successive increments accumulate', () => {
  resetProviderCounters();
  incrementProviderCounter('aviationNewsTimeout', 3);
  incrementProviderCounter('aviationNewsSuccess', 2);
  const counts = getProviderCounters();
  assert.equal(counts.aviationNewsTimeout, 3);
  assert.equal(counts.aviationNewsSuccess, 2);
});

test('getProviderCounters: returns a snapshot, not a reference', () => {
  resetProviderCounters();
  const snapshot = getProviderCounters();
  incrementProviderCounter('aviationNewsSuccess');
  assert.equal(snapshot.aviationNewsSuccess, 0);
  assert.equal(getProviderCounters().aviationNewsSuccess, 1);
});

test('the counter set carries no provider without an edge incrementer', () => {
  // #8093 deleted the edge AviationStack collector; a counter nothing
  // increments reads as a permanently healthy zero, which is worse than no
  // counter at all.
  for (const key of Object.keys(getProviderCounters())) {
    assert.doesNotMatch(key, /^aviationStack|^notam/, `${key} has no incrementer left`);
  }
});

test('resetProviderCounters: resets all counters to zero', () => {
  incrementProviderCounter('aviationNewsSuccess', 5);
  incrementProviderCounter('aviationNewsTimeout', 2);
  incrementProviderCounter('aviationNewsAuthRejection', 1);
  resetProviderCounters();
  const counts = getProviderCounters();
  for (const key of Object.keys(counts)) {
    assert.equal(counts[key], 0, `${key} should be 0 after reset`);
  }
});