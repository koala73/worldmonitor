import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { aggregateStates, binStart, BIN_MS } = require('../scripts/shared/air-traffic-aggregate.cjs');
const { US_HUBS, CONUS_BOX, EUROPE_BOX } = require('../scripts/shared/air-traffic-regions.cjs');

// OpenSky /states/all row: [icao24, callsign, country, t_pos, t_contact, lon, lat, baro_alt, on_ground, velocity, track, vertical_rate, sensors, geo_alt]
const row = ({ lat, lon, alt = 10000, ground = false, vr = 0, geo = null }) =>
  ['abc123', 'TEST1   ', 'US', 0, 0, lon, lat, alt, ground, 200, 90, vr, null, geo];
const T = Date.UTC(2026, 10, 13, 20, 50, 0);
const ATL = US_HUBS.find(h => h.iata === 'ATL');

test('the bin is the 5-minute floor of the fetch time', () => {
  assert.equal(BIN_MS, 300_000);
  assert.equal(binStart(T + 299_999), T);
  assert.equal(aggregateStates([], T + 61_000).t, T);
});

test('CONUS and Europe box edges are inclusive and exclusive just outside', () => {
  const inside = [
    row({ lat: CONUS_BOX.south, lon: CONUS_BOX.west }),
    row({ lat: CONUS_BOX.north, lon: CONUS_BOX.east }),
    row({ lat: EUROPE_BOX.south, lon: EUROPE_BOX.west }),
  ];
  const outside = [
    row({ lat: CONUS_BOX.south - 0.01, lon: -90 }),
    row({ lat: 40, lon: CONUS_BOX.west - 0.01 }),
    row({ lat: EUROPE_BOX.north + 0.01, lon: 10 }),
  ];
  const p = aggregateStates([...inside, ...outside], T);
  assert.equal(p.status, 'ok');
  assert.equal(p.usSeen, 2);
  assert.equal(p.usAirborne, 2);
  assert.equal(p.euAirborne, 1);
});

test('rows without a position are not counted anywhere', () => {
  const p = aggregateStates([row({ lat: null, lon: -84 }), row({ lat: 33, lon: null }), ['x']], T);
  assert.deepEqual([p.usSeen, p.usAirborne, p.euAirborne], [0, 0, 0]);
});

test('on-ground rows count as seen and at the hub on the ground, never airborne', () => {
  const p = aggregateStates([row({ lat: ATL.lat, lon: ATL.lon, ground: true, alt: null })], T);
  assert.equal(p.usSeen, 1);
  assert.equal(p.usAirborne, 0);
  assert.equal(p.usLowClimbing, 0);
  assert.deepEqual(p.hubs.ATL, { air: 0, ground: 1 });
});

test('low and climbing needs airborne, altitude under 3,000 m and a positive vertical rate', () => {
  const p = aggregateStates([
    row({ lat: 35, lon: -90, alt: 1500, vr: 5 }),
    row({ lat: 35, lon: -90, alt: null, geo: 1200, vr: 3 }),
    row({ lat: 35, lon: -90, alt: 3500, vr: 5 }),
    row({ lat: 35, lon: -90, alt: 1500, vr: -4 }),
    row({ lat: 35, lon: -90, alt: 1500, vr: null }),
    row({ lat: 35, lon: -90, alt: null, geo: null, vr: 5 }),
  ], T);
  assert.equal(p.usAirborne, 6);
  assert.equal(p.usLowClimbing, 2, 'baro 1500 and geo-only 1200 count; high, descending, null rate and no altitude do not');
});

test('the hub radius is 48 km', () => {
  const degLat = 1 / 111.2;
  const p = aggregateStates([
    row({ lat: ATL.lat + 47 * degLat, lon: ATL.lon }),
    row({ lat: ATL.lat + 49 * degLat, lon: ATL.lon }),
  ], T);
  assert.equal(p.hubs.ATL.air, 1);
  assert.equal(Object.keys(p.hubs).length, 20);
});

test('a snapshot without a states array is not a point with zero counts', () => {
  assert.throws(() => aggregateStates(null, T), /states must be an array/);
});
