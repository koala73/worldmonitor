import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { finiteLat, finiteLon, lonLatPair } from '../scripts/lib/geo-coord.mjs';
import { geometryFromOpen511 } from '../scripts/lib/open511.mjs';
import { normalize511Record } from '../scripts/lib/provincial-511.mjs';
import { normalizeTorontoRoadRecord, parseGeoPolyline } from '../scripts/lib/toronto-road-restrictions.mjs';
import { weatherAlertNotifyLocation } from '../scripts/_weather-alert-select.mjs';

// Every one of these is Number()-coercible to 0, and 0,0 is the Gulf of Guinea.
const MISSING = [null, undefined, '', '   ', false, true, [], [12], {}, NaN, Infinity, -Infinity];

test('missing values never become the coordinate zero', () => {
  for (const value of MISSING) {
    assert.equal(finiteLat(value), null, `lat accepted ${String(value)}`);
    assert.equal(finiteLon(value), null, `lon accepted ${String(value)}`);
  }
});

test('a genuine zero and quoted numeric strings survive', () => {
  for (const [input, expected] of [[0, 0], ['0', 0], [' 43.5 ', 43.5], [-43.5, -43.5]]) {
    assert.equal(finiteLat(input), expected);
  }
});

test('each axis carries its own bound', () => {
  assert.equal(finiteLat(90), 90);
  assert.equal(finiteLat(-90), -90);
  assert.equal(finiteLat(90.1), null);
  assert.equal(finiteLat(181), null);
  // 181 is out of range for a longitude but 100 is a valid one and an
  // invalid latitude, which is why the axis is part of the function name.
  assert.equal(finiteLon(180), 180);
  assert.equal(finiteLon(181), null);
  assert.equal(finiteLon(100), 100);
  assert.equal(finiteLat(100), null);
});

test('a pair is rejected when either axis is unusable', () => {
  assert.deepEqual(lonLatPair([-79.5, 43.5]), [-79.5, 43.5]);
  assert.equal(lonLatPair([-79.5]), null);
  assert.equal(lonLatPair('nope'), null);
  for (const value of MISSING) {
    assert.equal(lonLatPair([value, 43.5]), null);
    assert.equal(lonLatPair([-79.5, value]), null);
  }
});

test('Open511 drops unplaceable points rather than mapping them to zero', () => {
  const empty = { lat: null, lon: null, centroid: null, path: null };
  for (const value of MISSING) {
    assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates: [value, 49] }), empty);
    assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates: [-123, value] }), empty);
  }
  assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates: [181, 49] }), empty);
  assert.deepEqual(geometryFromOpen511({ type: 'Point', coordinates: ['-123.5', '49.5'] }).centroid,
    [-123.5, 49.5]);
});

test('a malformed LineString vertex cannot drag the Open511 centroid', () => {
  const line = geometryFromOpen511({
    type: 'LineString',
    coordinates: [[-124, 48], [false, '  '], [-122, 50], [1000, 49]],
  });
  assert.deepEqual(line.centroid, [-123, 49]);
});

test('provincial 511 falls back to the encoded path when direct coordinates are junk', () => {
  for (const value of MISSING) {
    const record = normalize511Record(
      { Id: 'coord', Latitude: value, Longitude: value },
      { kind: 'event', jurisdiction: 'ON' },
    );
    assert.equal(record.lat, null);
    assert.equal(record.lon, null);
    assert.equal(record.centroid, null);
  }
  const zero = normalize511Record(
    { Id: 'coord', Latitude: 0, Longitude: 0 },
    { kind: 'event', jurisdiction: 'ON' },
  );
  assert.deepEqual(zero.centroid, [0, 0]);
});

test('Toronto polylines reject junk vertices in array, JSON and encoded forms', () => {
  for (const value of MISSING) {
    assert.deepEqual(parseGeoPolyline([[value, 43], [-79, value]]), []);
  }
  const outOfRange = [[181, 43], [-79, 91]];
  assert.deepEqual(parseGeoPolyline(outOfRange), []);
  assert.deepEqual(parseGeoPolyline(JSON.stringify(outOfRange)), []);
  assert.deepEqual(parseGeoPolyline([[0, 0], [180, 90], ['-79.5', '43.5']]),
    [[0, 0], [180, 90], [-79.5, 43.5]]);
});

test('invalid direct Toronto coordinates do not override a valid road path', () => {
  const record = normalizeTorontoRoadRecord({
    latitude: false, longitude: false, geoPolyline: [[-80, 43], [-79, 44]],
  });
  assert.deepEqual(record.centroid, [-79.5, 43.5]);
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
});

test('a webhook ring with a null vertex is withheld from the geometry payload', () => {
  const ring = [[-100, 40], [-99, 40], [null, 41], [-100, 41], [-100, 40]];
  assert.deepEqual(
    weatherAlertNotifyLocation({ centroid: [-99.5, 40.5], coordinates: ring }),
    { lat: 40.5, lon: -99.5 },
  );
});

// The lever. Four near-identical finiteCoord helpers is what let the same
// coercion bug live in four adapters at once, so re-declaring one is a
// test failure rather than something a reviewer has to notice by eye.
test('coordinate parsing has exactly one definition under scripts/', () => {
  const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
  const shared = join(scriptsDir, 'lib', 'geo-coord.mjs');
  const declaration = /function\s+(finiteCoord|finiteLat|finiteLon|lonLatPair)\b/;
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(mjs|cjs|js)$/.test(entry.name) && full !== shared) {
        if (declaration.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    }
  };
  walk(scriptsDir);

  assert.deepEqual(offenders, [],
    `import { finiteLat, finiteLon } from 'scripts/lib/geo-coord.mjs' instead of re-declaring it`);
});
