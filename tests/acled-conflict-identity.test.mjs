import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeAcledConflictEvents,
  shouldStopAcledPagination,
} from '../scripts/seed-conflict-intel.mjs';

const BASE_EVENT = {
  event_id_cnty: 'SUD12345',
  event_type: 'Battles',
  event_date: '2026-07-20',
  country: 'Sudan',
  latitude: '15.5',
  longitude: '32.5',
  fatalities: '1',
  actor1: 'RSF',
  actor2: 'SAF',
  source: 'ACLED',
  admin1: 'Khartoum',
};

describe('ACLED conflict event identity', () => {
  it('publishes only events carrying ACLED stable identifiers', () => {
    const events = normalizeAcledConflictEvents([
      BASE_EVENT,
      { ...BASE_EVENT, event_id_cnty: undefined, notes: 'missing id' },
      { ...BASE_EVENT, event_id_cnty: '', notes: 'empty id' },
      { ...BASE_EVENT, event_id_cnty: '   ', notes: 'blank id' },
    ]);

    assert.deepEqual(events.map((event) => event.id), ['acled-SUD12345']);
    assert.ok(events.every((event) => event.id !== 'acled-undefined'));
  });

  it('continues past a full malformed page so later valid events remain reachable', () => {
    assert.equal(shouldStopAcledPagination({
      pageSize: 5000,
      limit: 5000,
      stableEventIdCount: 0,
      addedEventCount: 0,
    }), false);
    assert.equal(shouldStopAcledPagination({
      pageSize: 5000,
      limit: 5000,
      stableEventIdCount: 1,
      addedEventCount: 0,
    }), false);
    assert.equal(shouldStopAcledPagination({
      pageSize: 5000,
      limit: 5000,
      stableEventIdCount: 5000,
      addedEventCount: 0,
    }), true);
    assert.equal(shouldStopAcledPagination({
      pageSize: 4999,
      limit: 5000,
      stableEventIdCount: 4999,
      addedEventCount: 4999,
    }), true);
  });
});
