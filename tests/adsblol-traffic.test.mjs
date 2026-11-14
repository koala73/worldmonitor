import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { toStateRow, mergeSweep, MAX_POSITION_AGE_S } = require('../scripts/shared/adsblol-traffic.cjs');
const { aggregateStates } = require('../scripts/shared/air-traffic-aggregate.cjs');
const { US_HUBS, HUB_RADIUS_KM, EUROPE_BOX, ADSBLOL_CIRCLES, ADSBLOL_RADIUS_NM } = require('../scripts/shared/air-traffic-regions.cjs');
const { SERIES, buildTrafficPointWrite } = require('../scripts/shared/air-traffic-history.cjs');

const ATL = US_HUBS.find((hub) => hub.iata === 'ATL');
const toRad = (deg) => (deg * Math.PI) / 180;
const distKm = (a, b) => {
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

test('every hub disc lies inside one adsb.lol query circle', () => {
  const radiusKm = ADSBLOL_RADIUS_NM * 1.852;
  for (const hub of US_HUBS) {
    const inside = ADSBLOL_CIRCLES.some((circle) => distKm(circle, hub) + HUB_RADIUS_KM <= radiusKm);
    assert.ok(inside, `${hub.iata} is not fully covered`);
  }
  assert.ok(ADSBLOL_CIRCLES.some((circle) => circle.lat >= EUROPE_BOX.south && circle.lat <= EUROPE_BOX.north
    && circle.lon >= EUROPE_BOX.west && circle.lon <= EUROPE_BOX.east), 'a circle samples the Europe control');
});

test('an adsb.lol aircraft counts exactly like the matching OpenSky row', () => {
  const climbing = { hex: 'A1B2C3', lat: ATL.lat, lon: ATL.lon, alt_baro: 2000, baro_rate: 1500, seen_pos: 1 };
  const parked = { hex: '~c0ffee', lat: ATL.lat, lon: ATL.lon, alt_baro: 'ground', seen_pos: 2 };
  const europe = { hex: '4ca123', lat: 50, lon: 8, alt_baro: 36000, seen_pos: 0 };
  const point = aggregateStates(mergeSweep([{ ac: [climbing, parked, europe] }]), Date.UTC(2026, 10, 14, 12));
  assert.equal(point.usAirborne, 1);
  assert.equal(point.usLowClimbing, 1, '2,000 ft climbing is under the 3,000 m low-altitude line');
  assert.equal(point.usSeen, 2);
  assert.deepEqual(point.hubs.ATL, { air: 1, ground: 1 });
  assert.equal(point.euAirborne, 1);
  assert.equal(toStateRow(parked)[0], 'c0ffee');
});

test('a stale position or a missing position is not counted', () => {
  assert.equal(toStateRow({ hex: 'a', lat: 40, lon: -100, alt_baro: 30000, seen_pos: MAX_POSITION_AGE_S + 1 }), null);
  assert.equal(toStateRow({ hex: 'a', alt_baro: 30000 }), null);
});

test('overlapping circles count an aircraft once, at its freshest position', () => {
  const older = { hex: 'abc', lat: 40, lon: -100, alt_baro: 30000, seen_pos: 20 };
  const fresher = { hex: 'abc', lat: 41, lon: -100, alt_baro: 30000, seen_pos: 1 };
  const rows = mergeSweep([{ ac: [older] }, { ac: [fresher] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][6], 41);
});

test('a response without an ac array fails the sweep instead of counting zero', () => {
  assert.throws(() => mergeSweep([{ ac: [] }, {}]), /no ac array/);
});

test('the adsb.lol series writes its own hash, heartbeat and marker', () => {
  const point = aggregateStates(mergeSweep([{ ac: [{ hex: 'a', lat: 40, lon: -100, alt_baro: 30000 }] }]), Date.UTC(2026, 10, 14, 12));
  const write = buildTrafficPointWrite(point, point.t, SERIES.adsblol);
  assert.equal(write.key, 'aviation:traffic:history:adsblol:v1:2026-11-14');
  assert.deepEqual(write.metaCommands.map((command) => command[1]), [SERIES.adsblol.heartbeatKey, SERIES.adsblol.activationKey]);
  for (const key of [write.key, ...write.metaCommands.map((command) => command[1])]) {
    assert.ok(![SERIES.opensky.prefix, SERIES.opensky.heartbeatKey, SERIES.opensky.activationKey].some((k) => key === k || key.startsWith(`${SERIES.opensky.prefix}:`)), key);
  }
});
