// Aviation server-side handler counters.
//
// Tests the in-memory provider counter module used by AviationStack, NOTAM,
// and aviation news handlers on the Vercel side.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  incrementProviderCounter,
  getProviderCounters,
  resetProviderCounters,
} from '../server/worldmonitor/aviation/v1/_counters.ts';

test('incrementProviderCounter: increments the specified field', () => {
  resetProviderCounters();
  incrementProviderCounter('aviationStackSuccess');
  const counts = getProviderCounters();
  assert.equal(counts.aviationStackSuccess, 1);
  assert.equal(counts.aviationStackTimeout, 0);
});

test('incrementProviderCounter: successive increments accumulate', () => {
  resetProviderCounters();
  incrementProviderCounter('aviationStackTimeout', 3);
  incrementProviderCounter('aviationStackSuccess', 2);
  const counts = getProviderCounters();
  assert.equal(counts.aviationStackTimeout, 3);
  assert.equal(counts.aviationStackSuccess, 2);
});

test('getProviderCounters: returns a snapshot, not a reference', () => {
  resetProviderCounters();
  const snapshot = getProviderCounters();
  incrementProviderCounter('notamSuccess');
  assert.equal(snapshot.notamSuccess, 0);
  assert.equal(getProviderCounters().notamSuccess, 1);
});

test('resetProviderCounters: resets all counters to zero', () => {
  incrementProviderCounter('aviationStackSuccess', 5);
  incrementProviderCounter('notamTimeout', 2);
  incrementProviderCounter('aviationNewsAuthRejection', 1);
  resetProviderCounters();
  const counts = getProviderCounters();
  for (const key of Object.keys(counts)) {
    assert.equal(counts[key], 0, `${key} should be 0 after reset`);
  }
});