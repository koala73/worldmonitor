// src/data/flowMatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFlowToRoads, median } from './flowMatch.js';

// Synthetic geometry around downtown Austin (cos-lat correction matters here).
const LAT0 = 30.26;
const LON0 = -97.7431;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Build a straight polyline from a start point, heading, length, and vertex spacing (meters). */
function line({ lat = LAT0, lon = LON0, northM = 0, eastM = 0, lengthM, stepM = 25, bearingDeg = 0 }) {
  const startLat = lat + northM / M_PER_DEG_LAT;
  const startLon = lon + eastM / M_PER_DEG_LON;
  const steps = Math.max(1, Math.round(lengthM / stepM));
  const coords = [];
  const rad = (bearingDeg * Math.PI) / 180;
  for (let i = 0; i <= steps; i++) {
    const d = (lengthM * i) / steps;
    coords.push([
      startLon + (Math.sin(rad) * d) / M_PER_DEG_LON,
      startLat + (Math.cos(rad) * d) / M_PER_DEG_LAT,
    ]);
  }
  return coords;
}

const ROAD_NS = { coords: line({ lengthM: 500, bearingDeg: 0 }), type: 'primary' };

function flow(coords, trafficLevel, { closure = false, roadType = 'Major road' } = {}) {
  return { coords, trafficLevel, roadType, closure };
}

// ── matching core ───────────────────────────────────────────

test('coincident parallel road matches with the flow level', () => {
  const flows = [flow(line({ lengthM: 500, bearingDeg: 0, eastM: 4 }), 0.42)];
  const { matches, matchedCount, candidateCount } = matchFlowToRoads([ROAD_NS], flows);
  assert.equal(matchedCount, 1);
  assert.equal(candidateCount, 1);
  assert.ok(matches[0], 'road should match');
  assert.ok(Math.abs(matches[0].level - 0.42) < 1e-9);
  assert.equal(matches[0].closure, false);
});

test('opposite-direction flow still matches (two-way bearing fold)', () => {
  // Same line drawn south->north vs road north->south equivalence.
  const reversed = line({ lengthM: 500, bearingDeg: 0, eastM: 4 }).reverse();
  const { matches } = matchFlowToRoads([ROAD_NS], [flow(reversed, 0.3)]);
  assert.ok(matches[0], 'reversed flow should still match');
  assert.ok(Math.abs(matches[0].level - 0.3) < 1e-9);
});

test('perpendicular decoy at the same location does NOT match', () => {
  // East-west flow crossing the road's midpoint.
  const decoy = flow(line({ northM: 250, eastM: -250, lengthM: 500, bearingDeg: 90 }), 0.1);
  const { matches, matchedCount, candidateCount } = matchFlowToRoads([ROAD_NS], [decoy]);
  assert.equal(matches[0], null);
  assert.equal(matchedCount, 0);
  // The decoy IS within 35 m of at least one sample — it's a candidate, just
  // bearing-rejected. Coverage denominator must reflect that.
  assert.equal(candidateCount, 1);
});

test('parallel flow offset by more than 35 m does not match', () => {
  const farFlow = flow(line({ lengthM: 500, bearingDeg: 0, eastM: 50 }), 0.2);
  const { matches, matchedCount, candidateCount } = matchFlowToRoads([ROAD_NS], [farFlow]);
  assert.equal(matches[0], null);
  assert.equal(matchedCount, 0);
  assert.equal(candidateCount, 0);
});

test('closure propagates to the matched road', () => {
  const closed = flow(line({ lengthM: 500, bearingDeg: 0, eastM: 2 }), 0, { closure: true });
  const { matches } = matchFlowToRoads([ROAD_NS], [closed]);
  assert.ok(matches[0], 'closed road should still match');
  assert.equal(matches[0].closure, true);
});

test('closure propagates when only PART of the road is closed', () => {
  const openHalf = flow(line({ lengthM: 250, bearingDeg: 0, eastM: 2 }), 0.9);
  const closedHalf = flow(line({ northM: 250, lengthM: 250, bearingDeg: 0, eastM: 2 }), 0, { closure: true });
  const { matches } = matchFlowToRoads([ROAD_NS], [openHalf, closedHalf]);
  assert.ok(matches[0]);
  assert.equal(matches[0].closure, true);
});

test('level is the median across matched samples (thirds at 0.2/0.4/0.9 -> 0.4)', () => {
  const thirds = [
    flow(line({ lengthM: 168, bearingDeg: 0, eastM: 2 }), 0.2),
    flow(line({ northM: 168, lengthM: 166, bearingDeg: 0, eastM: 2 }), 0.4),
    flow(line({ northM: 334, lengthM: 166, bearingDeg: 0, eastM: 2 }), 0.9),
  ];
  const { matches } = matchFlowToRoads([ROAD_NS], thirds);
  assert.ok(matches[0]);
  assert.ok(Math.abs(matches[0].level - 0.4) < 1e-9, `median was ${matches[0].level}`);
});

test('a road with flow on only a short stretch (< half its samples) stays null', () => {
  // Flow covers only the first ~15% of the road — 1 of 7 samples at best.
  const stub = flow(line({ lengthM: 75, bearingDeg: 0, eastM: 2 }), 0.5);
  const { matches, matchedCount, candidateCount } = matchFlowToRoads([ROAD_NS], [stub]);
  assert.equal(matches[0], null);
  assert.equal(matchedCount, 0);
  assert.equal(candidateCount, 1); // it had candidates, they were just too few
});

test('multiple roads: results stay parallel to the input array', () => {
  const roadFar = { coords: line({ eastM: 5000, lengthM: 500, bearingDeg: 0 }), type: 'residential' };
  const flows = [flow(line({ lengthM: 500, bearingDeg: 0, eastM: 3 }), 0.6)];
  const { matches, matchedCount } = matchFlowToRoads([roadFar, ROAD_NS], flows);
  assert.equal(matches.length, 2);
  assert.equal(matches[0], null);
  assert.ok(matches[1]);
  assert.equal(matchedCount, 1);
});

test('sparse-vertex flow polylines (long coord pairs) still match everywhere', () => {
  // One 500 m segment as a single coord pair — midpoint hashing alone would
  // miss samples near the ends; subdivision must cover them.
  const sparse = flow([
    ROAD_NS.coords[0],
    ROAD_NS.coords[ROAD_NS.coords.length - 1],
  ], 0.5);
  const { matches } = matchFlowToRoads([ROAD_NS], [sparse]);
  assert.ok(matches[0], 'sparse flow polyline should match the full road');
});

// ── degenerate inputs ───────────────────────────────────────

test('empty inputs are safe', () => {
  assert.deepEqual(matchFlowToRoads([], []), { matches: [], matchedCount: 0, candidateCount: 0 });
  const noFlow = matchFlowToRoads([ROAD_NS], []);
  assert.deepEqual(noFlow.matches, [null]);
  assert.equal(noFlow.candidateCount, 0);
  assert.deepEqual(matchFlowToRoads([], [flow(line({ lengthM: 100 }), 0.5)]).matches, []);
});

test('degenerate road (single/zero-length coords) stays null without throwing', () => {
  const dot = { coords: [[LON0, LAT0]], type: 'residential' };
  const zero = { coords: [[LON0, LAT0], [LON0, LAT0]], type: 'residential' };
  const flows = [flow(line({ lengthM: 100 }), 0.5)];
  const { matches } = matchFlowToRoads([dot, zero], flows);
  assert.deepEqual(matches, [null, null]);
});

// ── median helper ───────────────────────────────────────────

test('median: odd count picks the middle', () => {
  assert.equal(median([0.9, 0.2, 0.4]), 0.4);
});

test('median: even count averages the two middles', () => {
  assert.equal(median([0.2, 0.4, 0.6, 1.0]), 0.5);
});

test('median: single value and empty', () => {
  assert.equal(median([0.7]), 0.7);
  assert.equal(median([]), null);
});
