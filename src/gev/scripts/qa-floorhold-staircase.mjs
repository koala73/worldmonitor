#!/usr/bin/env node
/**
 * scripts/qa-floorhold-staircase.mjs — what a grounded contact DOES while its
 * floor data arrives, tick by tick.
 *
 * The unit pins assert the clamp's answer for a given cache state. They cannot
 * see the shape of the transition, which is what an owner actually watches: a
 * contact that reaches the right height by way of a jump into midair and a
 * visible stair-step down is wrong even though every individual answer is
 * defensible. An field test found exactly that — planes floating at
 * terminal gates — and this is the rig that reproduces it.
 *
 * A stationary grounded contact at a cold cell, driven at the 80 ms fleet
 * cadence, with cells warming on a fixed schedule. Reports time-to-surface,
 * time visibly buried, time visibly FLOATING, and the visible step count.
 *
 *   node scripts/qa-floorhold-staircase.mjs
 *
 * Pure module-level: no browser, no network, no GPU.
 */
import * as Cesium from 'cesium';
import { pickRenderAltitudeM } from '../src/data/renderAltitude.js';
import {
  _floorGroundedDisplayPositionForTest, _clearDisplayFloorStateForTest,
} from '../src/data/flights.js';
import {
  reportMeshFloorCell, setMeshFloorPreferred, _clearMeshFloorCellsForTest, GROUND_FLOOR_LIFT_M,
} from '../src/data/groundFloor.js';

const LAT = 30.2004, LON = -97.6604;          // own cell 30.200 / -97.660
const APRON = -22.0, ROOF = -4.0, START = -32.0; // ellipsoidal; SFO-ish geoid start
const TARGET = APRON + GROUND_FLOOR_LIFT_M;    // -20.5
const N = { up: [30.2014, LON], down: [30.1994, LON], left: [LAT, -97.6614], right: [LAT, -97.6594] };

const SCENARIOS = [
  ['S1 flat apron cold start (own cell warms last)', [
    [1120, () => { reportMeshFloorCell(...N.up, APRON); reportMeshFloorCell(...N.down, APRON); }],
    [5200, () => reportMeshFloorCell(LAT, LON, APRON)],
  ]],
  ['S2 apron beside a terminal (one neighbour is a roof)', [
    [1120, () => { reportMeshFloorCell(...N.up, ROOF); reportMeshFloorCell(...N.down, APRON); }],
    [5200, () => reportMeshFloorCell(LAT, LON, APRON)],
  ]],
  ['S3 own cell never warms (roof neighbour only)', [
    [1120, () => reportMeshFloorCell(...N.up, ROOF)],
  ]],
  ['S3b own cell never warms (roof + apron neighbours)', [
    [1120, () => { reportMeshFloorCell(...N.up, ROOF); reportMeshFloorCell(...N.down, APRON);
                   reportMeshFloorCell(...N.left, APRON); }],
  ]],
];

const summary = [];
for (const [name, schedule] of SCENARIOS) {
  _clearDisplayFloorStateForTest(); _clearMeshFloorCellsForTest(); setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(LON, LAT, START);
  const samples = [];
  let pending = [...schedule];
  for (let t = 0; t <= 12000; t += 80) {
    while (pending.length && pending[0][0] <= t) pending.shift()[1]();
    const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, name, 1000 + t);
    samples.push([t, Cesium.Cartographic.fromCartesian(out, Cesium.Ellipsoid.WGS84).height]);
  }
  const settle = samples.find(([, h]) => Math.abs(h - TARGET) < 0.1);
  const buried = samples.filter(([, h]) => h < APRON - 0.05).length * 80;
  const floatMax = Math.max(0, ...samples.map(([, h]) => h - TARGET));
  const floatMs = samples.filter(([, h]) => h > TARGET + 0.5).length * 80;
  const steps = [];
  for (let i = 1; i < samples.length; i += 1) {
    const d = samples[i][1] - samples[i - 1][1];
    if (Math.abs(d) > 0.5) steps.push([samples[i][0], d]);
  }
  const plateaus = new Set(samples.map(([, h]) => h.toFixed(1))).size;
  console.log(`\n### ${name}`);
  console.log(`  target = ${TARGET.toFixed(2)} m   start = ${START.toFixed(2)} m`);
  console.log(`  time-to-surface       = ${settle ? `${settle[0]} ms` : 'NEVER'}`);
  console.log(`  time visibly BURIED   = ${buried} ms`);
  console.log(`  time visibly FLOATING = ${floatMs} ms   (worst +${floatMax.toFixed(1)} m)`);
  console.log(`  visible steps (>0.5m) = ${steps.length}  (up ${steps.filter(([, d]) => d > 0).length} / down ${steps.filter(([, d]) => d < 0).length})`);
  console.log(`  distinct plateaus     = ${plateaus}`);
  summary.push(`  ${name} :: settle=${settle ? settle[0] : 'NEVER'} steps=${steps.length} float=${floatMs}ms(+${floatMax.toFixed(1)}m) buried=${buried}ms`);
}
console.log(`\nSUMMARY (this tree, post-fix)\n${summary.join('\n')}\n`);

// ---------------------------------------------------------------------------
// F1 — takeoff roll with the on_ground flag FLAPPING (field observation: VIR138M
// at JFK, 45 kt, "clearly on good ground, then suddenly popped below the
// ground, then popped back up").
//
// Two mechanisms meet here. OpenSky's on_ground flag is not clean through a
// rotation, and the fix's own height source switches at the same moment: a
// grounded fix is the resolved surface, an airborne one with baro just
// appearing is baro + geoid N, which at a sea-level field IS the geoid — below
// the ground the contact is still rolling on. Whether that dip is VISIBLE is
// then entirely down to whether the display clamp still remembers a floor.
//
// EVERY tick below is counted, the airborne one included. That tick renders
// under the runway and always will: the display clamp passes airborne positions
// through by design — an airborne height is the fix-time clamp's job, and
// flooring one would put a rotating aircraft back on the ground. So this rig
// reports two numbers, not one. The grounded count is what the hold owns and it
// must be zero. The airborne count is the ACCEPTED transition residual: the
// flap's own cost at the source, one tick wide, bounded by the field's geoid
// separation (~4 m here). What the hold changed is what happens AFTER the flap
// — 12 of 22 grounded ticks buried and not recovering, versus none.
// ---------------------------------------------------------------------------
const JFK_GROUND = -28.5;   // ~4 m MSL field, geoid N ~ -32.5 m
const JFK_GEOID = -32.5;
const JFK_LON = -73.78;

console.log('\n### F1 takeoff roll, on_ground flapping for one poll');
console.log('  poll-path height source at the flap:');
console.log(`    grounded, own cell warm       = ${pickRenderAltitudeM({ geoAltM: null, baroAltM: null, onGround: true, surfaceM: JFK_GROUND, geoidN: JFK_GEOID })} m`);
console.log(`    airborne, baro appears at 0 ft = ${pickRenderAltitudeM({ geoAltM: null, baroAltM: 0, onGround: false, surfaceM: null, geoidN: JFK_GEOID })} m`);
console.log(`    the source switch alone drops the fix ${(JFK_GROUND - JFK_GEOID).toFixed(1)} m, to below the runway`);

_clearDisplayFloorStateForTest(); _clearMeshFloorCellsForTest(); setMeshFloorPreferred(true);
// Only the cell it STARTED on is warm: at 23 m/s it outruns its own floor data,
// which is the whole reason the hold exists.
reportMeshFloorCell(40.64, JFK_LON, JFK_GROUND);
let rollLat = 40.64;
const rollRows = [];
for (let i = 0; i <= 22; i += 1) {
  const onGround = i !== 10;               // ONE airborne poll mid-roll
  const pos = Cesium.Cartesian3.fromDegrees(JFK_LON, rollLat, JFK_GEOID);
  const out = _floorGroundedDisplayPositionForTest({ onGround }, pos, false, 'VIR138M', 1000 + i * 80);
  rollRows.push([i, onGround, Cesium.Cartographic.fromCartesian(out, Cesium.Ellipsoid.WGS84).height]);
  rollLat += 0.00021;                      // ~23 m per 80 ms tick
}
const below = ([, , h]) => h < JFK_GROUND - 0.05;
for (const row of rollRows) {
  const [i, og, h] = row;
  const mark = below(row)
    ? (og ? '   <-- BELOW THE RUNWAY' : '   <-- below the runway (airborne pass-through)')
    : '';
  console.log(`  tick ${String(i).padStart(2)}  onGround=${og ? 'T' : 'F'}  render=${h.toFixed(2)}${mark}`);
}
const groundedRows = rollRows.filter(([, og]) => og);
const airborneRows = rollRows.filter(([, og]) => !og);
const dipped = rollRows.filter(below);
console.log(`\n  ticks rendering BELOW the runway: ${dipped.length} / ${rollRows.length}  (every tick counted)`);
console.log(`    grounded : ${groundedRows.filter(below).length} / ${groundedRows.length}   <- what the hold owns; must be 0`);
console.log(`    airborne : ${airborneRows.filter(below).length} / ${airborneRows.length}   <- pass-through by design; accepted transition residual`);
const worst = Math.min(JFK_GROUND, ...dipped.map(([, , h]) => h));
console.log(`  worst burial          = ${(worst - JFK_GROUND).toFixed(2)} m  (the field's geoid separation, one tick wide)`);
