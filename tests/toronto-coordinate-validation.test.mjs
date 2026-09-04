import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTorontoRoadRecord, parseGeoPolyline } from '../scripts/lib/toronto-road-restrictions.mjs';

test('Toronto array polylines reject missing or coerced positions', () => {
  for (const invalid of [null, '', ' ', false, true, [], [1], {}, NaN, Infinity]) {
    assert.deepEqual(parseGeoPolyline([[invalid, 43], [-79, invalid]]), []);
  }
});

test('Toronto rejects out-of-range coordinates in array and string polylines', () => {
  const invalid = [[181, 43], [-181, 43], [-79, 91], [-79, -91]];
  assert.deepEqual(parseGeoPolyline(invalid), []);
  assert.deepEqual(parseGeoPolyline(JSON.stringify(invalid)), []);
});

test('Toronto preserves genuine zeros, boundary values and numeric strings', () => {
  assert.deepEqual(parseGeoPolyline([[0, 0], [180, 90], [-180, -90], ['-79.5', '43.5']]),
    [[0, 0], [180, 90], [-180, -90], [-79.5, 43.5]]);
});

test('invalid direct Toronto coordinates cannot override a valid road path', () => {
  for (const invalid of [false, true, ' ', [], 999]) {
    const record = normalizeTorontoRoadRecord({ latitude: invalid, longitude: invalid,
      geoPolyline: [[-80, 43], [-79, 44]] });
    assert.deepEqual(record.centroid, [-79.5, 43.5]);
    assert.equal(record.lat, null);
    assert.equal(record.lon, null);
  }
});
