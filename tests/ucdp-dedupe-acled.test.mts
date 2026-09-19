import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDuplicatedByAcled,
  toUcdpAcledComparisons,
} from '../src/services/conflict/ucdp-dedupe.ts';

const NOW = Date.parse('2026-09-01T00:00:00.000Z');

const nearby = (deathsBest: number, offsetDays = 0) => ({
  latitude: 48.85,
  longitude: 2.35,
  dateMs: NOW + offsetDays * 86_400_000,
  deathsBest,
});

test('GDELT unrest does not suppress a nearby zero-death UCDP event', () => {
  const duplicated = isDuplicatedByAcled(nearby(0), [{
    latitude: 48.85,
    longitude: 2.35,
    event_date: new Date(NOW).toISOString(),
    fatalities: 0,
    source: 'gdelt',
    eventType: 'protest',
  }]);
  assert.equal(duplicated, false);
});

test('an ACLED battle still matches a nearby zero-death UCDP event', () => {
  const duplicated = isDuplicatedByAcled(nearby(0), [{
    latitude: 48.85,
    longitude: 2.35,
    event_date: new Date(NOW).toISOString(),
    fatalities: 0,
    source: 'ACLED',
    eventType: 'battle',
  }]);
  assert.equal(duplicated, true);
});

test('protest rows are not ACLED conflict comparisons', () => {
  const comparisons = toUcdpAcledComparisons([
    {
      lat: 33.3,
      lon: 44.4,
      time: new Date(NOW),
      fatalities: 4,
      source: 'ACLED',
      eventType: 'explosion',
    },
    {
      lat: 33.3,
      lon: 44.4,
      time: new Date(NOW),
      fatalities: 0,
      source: 'gdelt',
      eventType: 'protest',
    },
  ]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0]?.eventType, 'explosion');
  assert.equal(comparisons[0]?.fatalities, 4);
});
