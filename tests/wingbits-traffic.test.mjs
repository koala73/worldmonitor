import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { toStateRow, stateRowsFromAreas, MAX_POSITION_AGE_MS } = require('../scripts/shared/wingbits-traffic.cjs');
const { aggregateStates } = require('../scripts/shared/air-traffic-aggregate.cjs');
const { US_HUBS } = require('../scripts/shared/air-traffic-regions.cjs');
const { SERIES, buildTrafficPointWrite } = require('../scripts/shared/air-traffic-history.cjs');

const ATL = US_HUBS.find((hub) => hub.iata === 'ATL');
const NOW = Date.UTC(2026, 10, 15, 4, 11, 42);
const at = (ageMs) => new Date(NOW - ageMs).toISOString();

test('a Wingbits flight becomes an OpenSky row in metres and metres per second', () => {
  const row = toStateRow({ h: 'A1B2C3', f: 'DAL123', la: 33.6, lo: -84.4, ab: 10000, ag: 10500, gs: 400, th: 90, og: false });
  assert.equal(row[0], 'a1b2c3');
  assert.equal(row[1], 'DAL123');
  assert.deepEqual([row[5], row[6]], [-84.4, 33.6]);
  assert.equal(row[7], 3048);
  assert.equal(row[8], false);
  assert.ok(Math.abs(row[9] - 205.78) < 0.01);
  assert.equal(row[11], null, 'no vertical rate in Wingbits');
  assert.equal(row[13], 3200.4);
  assert.equal(toStateRow({ h: 'x', la: 1 }), null, 'a flight with no position has no row');
});

test('overlapping areas count an aircraft once, from its latest report', () => {
  const rows = stateRowsFromAreas([
    { alias: 'us-a', data: [{ h: 'a1', la: ATL.lat, lo: ATL.lon, ab: 2000, og: false, ra: at(20_000) }] },
    { alias: 'us-b', data: [{ h: 'a1', la: ATL.lat, lo: ATL.lon, og: true, ra: at(1_000) }] },
  ], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][8], true, 'the later report wins');
});

test('reports older than the cutoff or without a time are left out', () => {
  const rows = stateRowsFromAreas([{ alias: 'us', data: [
    { h: 'fresh', la: 35, lo: -100, ra: at(MAX_POSITION_AGE_MS) },
    { h: 'old', la: 35, lo: -100, ra: at(MAX_POSITION_AGE_MS + 1) },
    { h: 'undated', la: 35, lo: -100 },
  ] }], NOW);
  assert.deepEqual(rows.map((row) => row[0]), ['fresh']);
});

test('a response that is not a list of areas with data arrays throws, so it can never become a count', () => {
  assert.throws(() => stateRowsFromAreas({}, NOW), TypeError);
  assert.throws(() => stateRowsFromAreas([{ alias: 'us' }], NOW), TypeError);
  assert.deepEqual(stateRowsFromAreas([{ alias: 'us', data: [] }], NOW), []);
});

test('a Wingbits point stores only what Wingbits measures, in its own keys', () => {
  const rows = stateRowsFromAreas([{ alias: 'us', data: [{ h: 'a1', la: ATL.lat, lo: ATL.lon, ab: 1000, og: false, ra: at(0) }] }], NOW);
  const point = aggregateStates(rows, NOW);
  const write = buildTrafficPointWrite(point, NOW, SERIES.wingbits);
  assert.equal(write.key, 'aviation:traffic:history:wingbits:v1:2026-11-15');
  const stored = JSON.parse(write.commands[0][3]);
  assert.equal('usLowClimbing' in stored, false);
  assert.equal('usLowClimbingAirline' in stored, false);
  assert.equal(stored.usAirborneAirline, 0, 'the row has no callsign');
  assert.deepEqual(stored.hubs.ATL, { air: 1, ground: 0 }, 'no departure count without a vertical rate');
  assert.deepEqual(stored.markets.GB, { seen: 0 }, 'market coverage, but no departure count without a vertical rate');
  assert.equal(write.metaCommands[0][1], 'seed-meta:aviation:traffic-history-wingbits');
  assert.equal(write.metaCommands[1][1], 'seed-activated:aviation:traffic-history-wingbits');
});

test('an OpenSky point still stores climbers, and rejects a point without them', () => {
  const point = aggregateStates([['a1', null, null, null, null, ATL.lon, ATL.lat, 500, false, 100, 0, 5, null, null]], NOW);
  const stored = JSON.parse(buildTrafficPointWrite(point, NOW).commands[0][3]);
  assert.equal(stored.usLowClimbing, 1);
  assert.equal(stored.usLowClimbingAirline, 0);
  assert.deepEqual(stored.hubs.ATL, { air: 1, ground: 0, dep: 0 });
  const { usLowClimbing, ...withoutClimbers } = point;
  assert.equal(usLowClimbing, 1);
  assert.throws(() => buildTrafficPointWrite(withoutClimbers, NOW), TypeError);
});

// A Wingbits box spans w nm along every parallel it crosses, so it covers fewer
// degrees of longitude toward the equator.
const { buildWingbitsViewportAreas } = require('../scripts/shared/wingbits-traffic.cjs');
const { CONUS_BOX, EUROPE_BOX } = require('../scripts/shared/air-traffic-regions.cjs');
const covers = (area, lat, lon) => Math.abs(lat - area.la) * 60 <= area.h / 2 + 1e-6
  && Math.abs(lon - area.lo) * 60 * Math.cos((lat * Math.PI) / 180) <= area.w / 2 + 1e-6;

for (const [name, s, w, n, e] of [
  ['CONUS', CONUS_BOX.south, CONUS_BOX.west, CONUS_BOX.north, CONUS_BOX.east],
  ['Europe', EUROPE_BOX.south, EUROPE_BOX.west, EUROPE_BOX.north, EUROPE_BOX.east],
  ['a viewport across the equator', -20, -70, 25, 20],
]) {
  test(`the tiles cover every point of ${name}, including the seams at its southern edge`, () => {
    const areas = buildWingbitsViewportAreas(s, w, n, e);
    const missed = [];
    for (let lat = s; lat <= n + 1e-9; lat += 0.5) {
      for (let lon = w; lon <= e + 1e-9; lon += 0.25) {
        if (!areas.some((area) => covers(area, lat, lon))) missed.push(`${lat},${lon}`);
      }
    }
    assert.deepEqual(missed.slice(0, 5), [], `${missed.length} points outside every tile`);
    for (const area of areas) assert.ok(area.w <= 2000 && area.h <= 2000, 'every box is within the Wingbits size limit');
  });
}

test('an OpenSky point stores airline counts and hub departures', () => {
  const point = aggregateStates([['a1', 'DAL12   ', null, null, null, ATL.lon, ATL.lat, 500, false, 100, 0, 5, null, null]], NOW);
  const stored = JSON.parse(buildTrafficPointWrite(point, NOW).commands[0][3]);
  assert.deepEqual(
    [stored.usAirborneAirline, stored.usLowClimbingAirline, stored.euAirborneAirline, stored.hubs.ATL.dep],
    [1, 1, 0, 1],
  );
  const { usLowClimbingAirline, ...withoutAirlineClimbers } = point;
  assert.equal(usLowClimbingAirline, 1);
  assert.throws(() => buildTrafficPointWrite(withoutAirlineClimbers, NOW), TypeError);
});
