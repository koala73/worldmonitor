import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { aggregateStates, binStart, BIN_MS } = require('../scripts/shared/air-traffic-aggregate.cjs');
const { US_HUBS, CONUS_BOX, EUROPE_BOX, EUROPE_MARKETS } = require('../scripts/shared/air-traffic-regions.cjs');

// OpenSky /states/all row: [icao24, callsign, country, t_pos, t_contact, lon, lat, baro_alt, on_ground, velocity, track, vertical_rate, sensors, geo_alt]
const row = ({ lat, lon, alt = 10000, ground = false, vr = 0, geo = null, callsign = 'TEST1   ' }) =>
  ['abc123', callsign, 'US', 0, 0, lon, lat, alt, ground, 200, 90, vr, null, geo];
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
  assert.deepEqual(p.hubs.ATL, { air: 0, ground: 1, dep: 0 });
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

// A national ground stop halts airline departures, while general aviation keeps
// flying. On 2026-11-13 the all-aircraft climber count fell to 0.58 of normal
// an hour into the stop; the airline count fell to 0.33.
test('airline counts take only callsigns of three letters then a digit, trimmed of OpenSky padding', () => {
  const p = aggregateStates([
    row({ lat: 35, lon: -90, alt: 1500, vr: 5, callsign: 'DAL1234 ' }),
    row({ lat: 35, lon: -90, alt: 1500, vr: 5, callsign: 'N123AB  ' }),
    row({ lat: 35, lon: -90, alt: 1500, vr: 5, callsign: 'AB1234  ' }),
    row({ lat: 35, lon: -90, alt: 1500, vr: 5, callsign: null }),
    row({ lat: 35, lon: -90, alt: 9000, vr: 0, callsign: 'UAL9    ' }),
    row({ lat: 48, lon: 10, callsign: 'DLH400' }),
    row({ lat: 48, lon: 10, callsign: 'DEABC' }),
  ], T);
  assert.equal(p.usLowClimbing, 4);
  assert.equal(p.usLowClimbingAirline, 1);
  assert.equal(p.usAirborneAirline, 2);
  assert.equal(p.euAirborne, 2);
  assert.equal(p.euAirborneAirline, 1);
});

test('a hub counts airline departures inside its radius', () => {
  const p = aggregateStates([
    row({ lat: ATL.lat, lon: ATL.lon, alt: 800, vr: 8, callsign: 'DAL1' }),
    row({ lat: ATL.lat, lon: ATL.lon, alt: 800, vr: 8, callsign: 'N1AB' }),
    row({ lat: ATL.lat, lon: ATL.lon, alt: 800, vr: -8, callsign: 'DAL2' }),
  ], T);
  assert.deepEqual(p.hubs.ATL, { air: 3, ground: 0, dep: 1 });
});

test('a European market counts each aircraft near any of its hubs once, and only airline climbers as departures', () => {
  const hub = (code, iata) => EUROPE_MARKETS.find((m) => m.code === code).hubs.find((h) => h.iata === iata);
  const LHR = hub('GB', 'LHR');
  const CDG = hub('FR', 'CDG');
  // Between Heathrow and Gatwick, inside both radii: one UK aircraft.
  const between = { lat: (LHR.lat + hub('GB', 'LGW').lat) / 2, lon: (LHR.lon + hub('GB', 'LGW').lon) / 2 };
  const point = aggregateStates([
    row({ ...between, alt: 900, vr: 6, callsign: 'BAW12   ' }),
    row({ lat: LHR.lat, lon: LHR.lon, alt: 900, vr: 6, callsign: 'G-ABCD  ' }),
    row({ lat: LHR.lat, lon: LHR.lon, ground: true, alt: null, callsign: 'BAW99   ' }),
    row({ lat: LHR.lat, lon: LHR.lon, alt: 900, vr: -6, callsign: 'BAW77   ' }),
    row({ lat: CDG.lat, lon: CDG.lon, alt: 900, vr: 6, callsign: 'AFR1    ' }),
    row({ lat: 47, lon: 2 }),
  ], T);
  assert.deepEqual(point.markets.GB, { seen: 4, dep: 1 });
  assert.deepEqual(point.markets.FR, { seen: 1, dep: 1 });
  assert.deepEqual(point.markets.DE, { seen: 0, dep: 0 });
  assert.deepEqual(Object.keys(point.markets).sort(), ['DE', 'ES', 'FR', 'GB', 'IT']);
  assert.equal(point.euAirborne, 5);
});

test('every European market hub sits inside the Europe box, and no hub falls inside another market\'s radius', () => {
  const R = 6371;
  const km = (a, b) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (const market of EUROPE_MARKETS) {
    for (const h of market.hubs) {
      assert.ok(h.lat >= EUROPE_BOX.south && h.lat <= EUROPE_BOX.north && h.lon >= EUROPE_BOX.west && h.lon <= EUROPE_BOX.east, h.iata);
      for (const other of EUROPE_MARKETS.filter((m) => m !== market)) {
        for (const o of other.hubs) assert.ok(km(h, o) > 96, `${h.iata} and ${o.iata} share aircraft`);
      }
    }
  }
});
