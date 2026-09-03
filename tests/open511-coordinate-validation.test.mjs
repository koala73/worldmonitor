import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryFromOpen511, normalizeOpen511Event } from '../scripts/lib/open511.mjs';

const empty = { lat: null, lon: null, centroid: null, path: null };

test('Open511 rejects coerced coordinate values in either axis', () => {
  for (const invalid of [null, '', '  ', false, true, {}, NaN, Infinity]) {
    for (const coordinates of [[invalid, 49], [-123, invalid]]) {
      assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates }), empty);
    }
  }
  assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates: [-123, []] }), empty);
});

test('Open511 rejects coordinates outside longitude and latitude ranges', () => {
  for (const coordinates of [[181, 49], [-181, 49], [-123, 91], [-123, -91]]) {
    assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates }), empty);
  }
});

test('Open511 preserves zero, boundary coordinates and supported numeric strings', () => {
  for (const coordinates of [[0, 0], [180, 90], [-180, -90], ['-123.5', '49.5']]) {
    const point = geometryFromOpen511({ type: 'Point', coordinates });
    assert.deepEqual(point.centroid, coordinates.map(Number));
  }
});

test('malformed line vertices cannot distort the normalized event location', () => {
  const record = normalizeOpen511Event({ id: 'example', geography: {
    type: 'LineString', coordinates: [[-124, 48], [false, ' '], [-122, 50], [1000, 49]],
  } });
  assert.deepEqual(record.centroid, [-123, 49]);
  assert.equal(record.lon, -123);
  assert.equal(record.lat, 49);
});
