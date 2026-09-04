import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize511Record } from '../scripts/lib/provincial-511.mjs';

const normalize = (Latitude, Longitude, extra = {}) => normalize511Record(
  { Id: 'coordinate-test', Latitude, Longitude, ...extra },
  { kind: 'event', jurisdiction: 'ON' },
);

for (const value of [null, '', '  ', false, true, [], [43], {}, NaN, Infinity, 'invalid']) {
  test(`rejects invalid direct coordinate ${JSON.stringify(value)} (${typeof value})`, () => {
    assert.equal(normalize(value, -79).lat, null);
    assert.equal(normalize(43, value).lon, null);
    assert.equal(normalize(value, value).centroid, null);
  });
}

test('rejects coordinates outside geographic bounds', () => {
  for (const lat of [-90.1, 90.1, '91']) assert.equal(normalize(lat, 0).centroid, null);
  for (const lon of [-180.1, 180.1, '181']) assert.equal(normalize(0, lon).centroid, null);
});

test('preserves zero, numeric strings, and geographic boundaries', () => {
  for (const [lat, lon] of [[0, 0], ['43.5', '-79.5'], [' 0 ', '0'], [-90, -180], [90, 180]]) {
    assert.deepEqual(normalize(lat, lon).centroid, [Number(lon), Number(lat)]);
  }
});

test('invalid direct coordinates fall back to the encoded path', () => {
  const record = normalize(false, [], { EncodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' });
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
  assert.ok(Math.abs(record.centroid[0] - (-122.53433333333334)) < 1e-8);
  assert.ok(Math.abs(record.centroid[1] - 40.81733333333333) < 1e-8);
});
