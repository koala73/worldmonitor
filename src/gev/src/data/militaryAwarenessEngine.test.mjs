import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AWARENESS_RELATIONSHIP,
  findByDoublingRadius,
  getAwarenessNavigationTargets,
  formatAwarenessDistance,
  formatAwarenessLabel,
  summarizeAwarenessCohort,
} from './militaryAwarenessEngine.js';

test('awareness formatters preserve valid zeroes and replace missing or invalid values', () => {
  assert.equal(formatAwarenessDistance(0), '0 m');
  assert.equal(formatAwarenessDistance(950), '950 m');
  assert.equal(formatAwarenessDistance(Number.NaN), '—');
  assert.equal(formatAwarenessDistance(-1), '—');
  assert.equal(formatAwarenessLabel(' UAL649 '), 'UAL649');
  assert.equal(formatAwarenessLabel(0), '0');
  assert.equal(formatAwarenessLabel({ callsign: ' UAL649 ', id: 'fallback' }), 'UAL649');
  assert.equal(formatAwarenessLabel({ name: '', label: 'Mapped site' }), 'Mapped site');
  assert.equal(formatAwarenessLabel({ id: 0 }), '0');
  assert.equal(formatAwarenessLabel(''), '—');
  assert.equal(formatAwarenessLabel({}), '—');
  assert.equal(formatAwarenessLabel(undefined), '—');
});

test('awareness cohorts sort nearest-first and do not turn empty data into out of range', () => {
  const result = summarizeAwarenessCohort([{ id: 'far', distance: 9000 }, { id: 'near', distanceM: 1000 }]);
  assert.equal(result.relationship, 'NEARBY');
  assert.deepEqual(result.nearest.map((item) => item.id), ['near', 'far']);
  assert.equal(summarizeAwarenessCohort([]).relationship, 'UNKNOWN');
});

test('awareness cohorts reject negative and non-finite distances as unavailable data', () => {
  const result = summarizeAwarenessCohort([
    { id: 'negative', distanceM: -1 },
    { id: 'nan', distanceM: Number.NaN },
    { id: 'valid-zero', distanceM: 0 },
  ]);
  assert.equal(result.relationship, 'NEARBY');
  assert.deepEqual(result.nearest.map((item) => item.id), ['valid-zero']);
});

test('unavailable and stale feeds remain unknown', () => {
  assert.equal(AWARENESS_RELATIONSHIP.OUTSIDE_RANGE, 'OUTSIDE_RANGE');
  assert.equal(summarizeAwarenessCohort([], { available: false }).reason, 'feed unavailable');
  assert.equal(summarizeAwarenessCohort([], { stale: true }).reason, 'feed stale');
});

test('navigation prioritizes nearby targets from the selected cohort', () => {
  const cohorts = [
    { id: 'flights', summary: { nearest: [{ icao24: 'a1', distanceM: 1000 }, { icao24: 'a2', distanceM: 2000 }] } },
    { id: 'military', summary: { nearest: [{ icao24: 'm1', distanceM: 500 }] } },
  ];
  const targets = getAwarenessNavigationTargets(cohorts, { layerId: 'flights', id: 'subject' }, ['flights:a1']);
  // Cohort affinity still wins among UNVISITED targets: a2 leads at 2000 m even
  // though military m1 sits at 500 m.
  //
  // Visited state now outranks that affinity, which is the corrected half of
  // this ordering. Ranking the subject's own layer first unconditionally put
  // the already-visited a1 ahead of the unvisited m1, so NEXT cycled inside the
  // subject's layer and never reached military, vessels, or installations.
  assert.deepEqual(targets.map((target) => `${target.layerId}:${target.id}`), ['flights:a2', 'military:m1', 'flights:a1']);
});

test('awareness cycling excludes satellites, which retain independent tracking', () => {
  const cohorts = [
    { id: 'satellites', summary: { nearest: [{ id: 'iss', distanceM: 100 }] } },
    { id: 'ais-live-vessels', summary: { nearest: [{ mmsi: 'v1', distanceM: 1000 }] } },
  ];
  const targets = getAwarenessNavigationTargets(cohorts);
  assert.deepEqual(targets.map((target) => `${target.layerId}:${target.id}`), ['ais-live-vessels:v1']);
});

test('empty proximity searches double their radius until an aircraft is found', () => {
  const searched = [];
  const result = findByDoublingRadius((radiusM) => {
    searched.push(radiusM);
    return radiusM >= 1000000 ? { id: 'closest-flight' } : null;
  });
  assert.deepEqual(searched, [250000, 500000, 1000000]);
  assert.deepEqual(result, {
    candidate: { id: 'closest-flight' },
    radiusM: 1000000,
  });
});

test('expanding proximity search stops at its global bound when feeds are empty', () => {
  const searched = [];
  const result = findByDoublingRadius((radiusM) => {
    searched.push(radiusM);
    return null;
  }, { initialRadiusM: 250000, maxRadiusM: 1000000 });
  assert.equal(result, null);
  assert.deepEqual(searched, [250000, 500000, 1000000]);
});
