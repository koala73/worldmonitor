// src/data/motionModel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  norm360, norm180,
  courseBetweenCartesians, limitCourseStep,
  estimateTurnRateDps, turnRateFromFixHistory, arcOffsetEnu,
  speedRamp, lerpAngleDeg, courseSlewCapDps, displayedKinematics, staleCoastLimitSeconds,
  liftRepeatedGroundFix, synthesizeForwardKinematicsFix,
  projectGroundArcLatLon, corridorPathLatLon,
  COURSE_TRACK_ONLY_MPS, COURSE_CHORD_ONLY_MPS, COURSE_MIN_DPS, TURN_MIN_SPEED_MPS,
} from './motionModel.js';

const AUSTIN = { lat: 30.2672, lon: -97.7431, alt: 9000 };
const cart = (latOff, lonOff) =>
  Cesium.Cartesian3.fromDegrees(AUSTIN.lon + lonOff, AUSTIN.lat + latOff, AUSTIN.alt);

test('norm helpers', () => {
  assert.equal(norm360(-90), 270);
  assert.equal(norm180(350), -10);
});

test('displayedKinematics prefers motion derived from the rendered fix segment', () => {
  assert.deepEqual(displayedKinematics({
    derivedSpeedMps: 112,
    derivedTrackDeg: 271,
    reportedSpeedMps: 0,
    reportedTrackDeg: 90,
  }), { speedMps: 112, trackDeg: 271 });
});

test('displayedKinematics preserves a derived stop and falls back when unavailable', () => {
  assert.deepEqual(displayedKinematics({
    derivedSpeedMps: 0,
    derivedTrackDeg: 0,
    reportedSpeedMps: 80,
    reportedTrackDeg: 180,
  }), { speedMps: 0, trackDeg: 0 });
  assert.deepEqual(displayedKinematics({
    reportedSpeedMps: 80,
    reportedTrackDeg: 180,
  }), { speedMps: 80, trackDeg: 180 });
});

test('stale coasting follows last source contact without allowing indefinite drift', () => {
  const fix = 1_000_000;
  assert.equal(staleCoastLimitSeconds({ fixEpochMs: fix }), 60);
  assert.equal(staleCoastLimitSeconds({
    fixEpochMs: fix,
    lastContactEpochMs: fix + 85_000,
  }), 145);
  assert.equal(staleCoastLimitSeconds({
    fixEpochMs: fix,
    lastContactEpochMs: fix + 600_000,
  }), 300);
  assert.equal(staleCoastLimitSeconds({
    fixEpochMs: fix,
    lastContactEpochMs: fix - 10_000,
  }), 60);
});

test('courseBetweenCartesians: due north ≈ 0°, due east ≈ 90°', () => {
  const from = cart(0, 0);
  const north = cart(1000 / 111320, 0);
  const east = cart(0, 1000 / (111320 * Math.cos(AUSTIN.lat * Math.PI / 180)));
  assert.ok(Math.abs(norm180(courseBetweenCartesians(from, north) - 0)) < 0.5);
  assert.ok(Math.abs(norm180(courseBetweenCartesians(from, east) - 90)) < 0.5);
});

test('courseBetweenCartesians: sub-threshold chord returns null', () => {
  const from = cart(0, 0);
  const near = cart(5 / 111320, 0); // 5 m — below default 25 m
  assert.equal(courseBetweenCartesians(from, near), null);
});

test('limitCourseStep: passes small deltas, clamps big ones, wraps shortest way', () => {
  assert.equal(limitCourseStep(null, 123, 60, 0.08), 123); // seed
  assert.equal(limitCourseStep(10, 12, 60, 1), 12);        // within rate
  assert.equal(limitCourseStep(0, 90, 60, 0.5), 30);       // clamped to 30°
  const wrapped = limitCourseStep(350, 10, 60, 1);         // +20 through 360, not −340
  assert.ok(Math.abs(norm180(wrapped - 10)) < 1e-9);
});

test('estimateTurnRateDps: 2°/s ramp detected; noise floored; clamped', () => {
  const ramp = [
    { tSec: 0, trackDeg: 0 }, { tSec: 30, trackDeg: 60 }, { tSec: 60, trackDeg: 120 },
  ];
  assert.ok(Math.abs(estimateTurnRateDps(ramp) - 2) < 1e-9);
  const noise = [{ tSec: 0, trackDeg: 0 }, { tSec: 30, trackDeg: 3 }]; // 0.1°/s < floor
  assert.equal(estimateTurnRateDps(noise), 0);
  const wild = [{ tSec: 0, trackDeg: 0 }, { tSec: 10, trackDeg: 300 }]; // −6°/s unwrapped
  assert.equal(estimateTurnRateDps(wild), -4); // clamped
});

test('turnRateFromFixHistory adapts JulianDate history', () => {
  const t0 = Cesium.JulianDate.now();
  const h = [0, 30, 60].map((s, i) => ({
    time: Cesium.JulianDate.addSeconds(t0, s, new Cesium.JulianDate()),
    track: i * 60,
  }));
  assert.ok(Math.abs(turnRateFromFixHistory(h) - 2) < 1e-9);
});

test('arcOffsetEnu: zero turn = straight line; 90° arc hits R,R; endCourse advances', () => {
  const out = { east: 0, north: 0, endCourseDeg: 0 };
  arcOffsetEnu(200, 90, 0, 10, out); // east at 200 m/s for 10 s
  assert.ok(Math.abs(out.east - 2000) < 1e-6 && Math.abs(out.north) < 1e-6);
  assert.equal(out.endCourseDeg, 90);

  const w = 3; // °/s, dt 30 s → 90° of arc, R = v/ω
  arcOffsetEnu(200, 0, w, 30, out);
  const R = 200 / (w * Math.PI / 180);
  assert.ok(Math.abs(out.east - R) < 1e-6);
  assert.ok(Math.abs(out.north - R) < 1e-6);
  assert.equal(out.endCourseDeg, 90);
});

test('speedRamp: track-only below the gate, chord-only above, ramp between, legacy for unknown', () => {
  assert.equal(speedRamp(0), 0);
  assert.equal(speedRamp(COURSE_TRACK_ONLY_MPS), 0);
  assert.equal(speedRamp(COURSE_CHORD_ONLY_MPS), 1);
  assert.equal(speedRamp(300), 1);
  const mid = speedRamp((COURSE_TRACK_ONLY_MPS + COURSE_CHORD_ONLY_MPS) / 2);
  assert.ok(Math.abs(mid - 0.5) < 1e-9);
  assert.equal(speedRamp(NaN), 1);  // unknown speed → legacy chord behavior
  assert.equal(speedRamp(null), 1);
});

test('lerpAngleDeg: wraps the shortest way', () => {
  assert.equal(lerpAngleDeg(10, 30, 0.5), 20);
  assert.equal(lerpAngleDeg(350, 10, 0.5), 0);   // through 360, not backward 180
  assert.equal(lerpAngleDeg(350, 10, 0), 350);
  assert.equal(lerpAngleDeg(350, 10, 1), 10);
});

test('courseSlewCapDps: COURSE_MIN_DPS at low speed easing to the fleet cap at cruise', () => {
  assert.equal(courseSlewCapDps(0, 60), COURSE_MIN_DPS);
  assert.equal(courseSlewCapDps(COURSE_TRACK_ONLY_MPS, 60), COURSE_MIN_DPS);
  assert.equal(courseSlewCapDps(COURSE_CHORD_ONLY_MPS, 60), 60);
  assert.equal(courseSlewCapDps(NaN, 60), 60);   // unknown speed → legacy cap
});

test('turn-rate guard: hover fix-track jitter manufactures NO turn rate; a real slow turn still does', () => {
  const t0 = Cesium.JulianDate.now();
  const mk = (specs) => specs.map(([s, track, velocity]) => ({
    time: Cesium.JulianDate.addSeconds(t0, s, new Cesium.JulianDate()),
    track, velocity,
  }));
  // Hovering heli: 1 m/s drift, reported track flipping ±45° — used to yield ±°/s
  // that the extrapolation arc integrated into a pirouette. Now 0.
  const hover = mk([[0, 90, 1], [15, 135, 1], [30, 45, 1], [45, 135, 1], [60, 45, 1]]);
  assert.equal(turnRateFromFixHistory(hover), 0);
  // A 25 kt (12.9 m/s) plane really turning 3°/s keeps its estimate (above the floor).
  assert.ok(12.9 > TURN_MIN_SPEED_MPS);
  const slowTurn = mk([[0, 0, 12.9], [15, 45, 12.9], [30, 90, 12.9]]);
  assert.ok(Math.abs(turnRateFromFixHistory(slowTurn) - 3) < 1e-9);
  // estimateTurnRateDps skips only the low-speed intervals when a floor is given.
  const mixed = [
    { tSec: 0, trackDeg: 0, speedMps: 1 }, { tSec: 15, trackDeg: 90, speedMps: 1 }, // noise interval (skipped)
    { tSec: 30, trackDeg: 90, speedMps: 100 }, { tSec: 45, trackDeg: 120, speedMps: 100 }, // real 2°/s
  ];
  assert.ok(Math.abs(estimateTurnRateDps(mixed, 0.4, 4, 5) - 2) < 1e-9);
  // Samples WITHOUT a speed keep the legacy behavior even with a floor set.
  const noSpeed = [{ tSec: 0, trackDeg: 0 }, { tSec: 30, trackDeg: 60 }];
  assert.ok(Math.abs(estimateTurnRateDps(noSpeed, 0.4, 4, 5) - 2) < 1e-9);
});

test('arcOffsetEnu: backward dt retraces the forward arc (warm-up symmetry)', () => {
  const fwd = { east: 0, north: 0, endCourseDeg: 0 };
  const back = { east: 0, north: 0, endCourseDeg: 0 };
  arcOffsetEnu(200, 30, 2, 20, fwd);
  // Going backward from the arc end at its end-course must land at the start.
  arcOffsetEnu(200, fwd.endCourseDeg, 2, -20, back);
  assert.ok(Math.abs(fwd.east + back.east) < 1e-6);
  assert.ok(Math.abs(fwd.north + back.north) < 1e-6);
});

test('repeated kinematics apply only from a forward synthetic fix', () => {
  const epochMs = 1_800_000_000_000;
  const originalPosition = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 9000);
  const newest = {
    time: Cesium.JulianDate.fromDate(new Date(epochMs)),
    epochMs,
    position: Cesium.Cartesian3.clone(originalPosition),
    velocity: 100,
    track: 90,
  };
  const synthetic = synthesizeForwardKinematicsFix(newest, {
    epochMs: epochMs + 10_000,
    velocity: 220,
    track: 15,
  });
  assert.ok(synthetic);
  assert.equal(newest.velocity, 100);
  assert.equal(newest.track, 90);
  assert.ok(Cesium.Cartesian3.equals(newest.position, originalPosition));
  assert.equal(synthetic.velocity, 220);
  assert.equal(synthetic.track, 15);
  assert.ok(Math.abs(Cesium.Cartesian3.distance(newest.position, synthetic.position) - 1000) < 0.5);
});

test('liftRepeatedGroundFix raises only grounded history and preserves the stored coordinates', () => {
  const newest = {
    time: Cesium.JulianDate.now(),
    epochMs: 123,
    position: Cesium.Cartesian3.fromDegrees(-98.04, 29.71, -30),
    velocity: 0,
    track: 270,
  };
  const lifted = Cesium.Cartesian3.fromDegrees(-97.5, 30.1, 320);
  assert.equal(liftRepeatedGroundFix(newest, lifted, true), true);
  const carto = Cesium.Cartographic.fromCartesian(newest.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) - (-98.04)) < 1e-7);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 29.71) < 1e-7);
  assert.ok(Math.abs(carto.height - 320) < 1e-5);
  assert.equal(newest.epochMs, 123);
  assert.equal(newest.velocity, 0);
  assert.equal(newest.track, 270);

  const airborne = { position: Cesium.Cartesian3.fromDegrees(-98.04, 29.71, -30) };
  assert.equal(liftRepeatedGroundFix(airborne, lifted, false), false);
  const lower = Cesium.Cartesian3.fromDegrees(-98.04, 29.71, 100);
  assert.equal(liftRepeatedGroundFix(newest, lower, true), false);
  assert.ok(Math.abs(Cesium.Cartographic.fromCartesian(newest.position).height - 320) < 1e-5);
});

// --- Forward ground projection (display-floor corridor) --------------------
// While a grounded contact COASTS past its newest fix, the displayed position
// travels AWAY from that fix. The corridor needs the ground it is heading FOR
// — and, because the dead-reckon integrates a constant-rate turn, that ground
// is an ARC whenever the contact is turning. A straight tangent leaves the
// real path cold.

test('projectGroundArcLatLon walks due north for course 0 with no turn', () => {
  const p = projectGroundArcLatLon(30.2, -97.66, 0, 111.32, 0, 10); // 1113.2 m
  assert.ok(Math.abs(p.lat - 30.21) < 1e-4, `lat ${p.lat}`);
  assert.ok(Math.abs(p.lon + 97.66) < 1e-9, 'no easting on a due-north leg');
});

test('projectGroundArcLatLon walks due east for course 90 (longitude scaled by latitude)', () => {
  const p = projectGroundArcLatLon(30.2, -97.66, 90, 100, 0, 10); // 1000 m
  assert.ok(Math.abs(p.lat - 30.2) < 1e-9, 'no northing on a due-east leg');
  const expected = -97.66 + 1000 / (111320 * Math.cos(30.2 * Math.PI / 180));
  assert.ok(Math.abs(p.lon - expected) < 1e-6, `lon ${p.lon} vs ${expected}`);
});

test('projectGroundArcLatLon curves away from the tangent under a sustained turn', () => {
  // 12 m/s, 3 deg/s right turn for 30 s = 90 deg of arc.
  const arc = projectGroundArcLatLon(30.2, -97.66, 0, 12, 3, 30);
  const tangent = projectGroundArcLatLon(30.2, -97.66, 0, 12, 0, 30);
  // The tangent runs 360 m due north; the quarter-circle ends ~229 m north and
  // ~229 m east of the start. Hundreds of metres apart — many cells apart.
  assert.ok(arc.lon > tangent.lon + 0.001, `arc must swing east: ${arc.lon} vs ${tangent.lon}`);
  assert.ok(arc.lat < tangent.lat - 0.001, `arc must fall short north: ${arc.lat} vs ${tangent.lat}`);
});

test('projectGroundArcLatLon turns left for a negative rate', () => {
  const right = projectGroundArcLatLon(30.2, -97.66, 0, 12, 3, 30);
  const left = projectGroundArcLatLon(30.2, -97.66, 0, 12, -3, 30);
  assert.ok(left.lon < -97.66 && right.lon > -97.66, `left ${left.lon} right ${right.lon}`);
});

test('projectGroundArcLatLon returns the origin for a zero-length leg', () => {
  assert.deepEqual(projectGroundArcLatLon(30.2, -97.66, 45, 10, 0, 0), { lat: 30.2, lon: -97.66 });
  assert.deepEqual(projectGroundArcLatLon(30.2, -97.66, 45, 0, 0, 30), { lat: 30.2, lon: -97.66 });
});

test('projectGroundArcLatLon returns the origin for non-finite inputs', () => {
  assert.deepEqual(projectGroundArcLatLon(30.2, -97.66, NaN, 10, 0, 30), { lat: 30.2, lon: -97.66 });
  assert.deepEqual(projectGroundArcLatLon(30.2, -97.66, 45, 10, 0, NaN), { lat: 30.2, lon: -97.66 });
});

test('projectGroundArcLatLon does not blow up at the pole', () => {
  const p = projectGroundArcLatLon(89.9999, 0, 90, 100, 0, 10);
  assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `got ${JSON.stringify(p)}`);
});

// --- corridorPathLatLon: the path the display will actually walk ------------

test('corridorPathLatLon is a straight two-point chord while interpolating', () => {
  // The dead-reckon LERPS between fixes, so the chord IS the display path.
  const path = corridorPathLatLon({
    extrapolating: false,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 0, speedMps: 10, turnRateDps: 3,
    fixLat: 30.203, fixLon: -97.658, lookaheadSec: 60,
  });
  assert.deepEqual(path, [{ lat: 30.2, lon: -97.66 }, { lat: 30.203, lon: -97.658 }]);
});

test('corridorPathLatLon leads FORWARD, past the fix, while coasting', () => {
  const path = corridorPathLatLon({
    extrapolating: true,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 0, speedMps: 10, turnRateDps: 0,
    fixLat: 30.197, fixLon: -97.660, lookaheadSec: 60,
  });
  const end = path[path.length - 1];
  assert.ok(end.lat > 30.200, `must lead the contact, got ${end.lat}`);
  assert.ok(end.lat > 30.197, 'never the backtrail behind the stale fix');
  assert.ok(Math.abs(end.lat - (30.2 + 600 / 111320)) < 1e-5, `end lat ${end.lat}`);
});

test('corridorPathLatLon samples the ARC, not a chord, for a turning coaster', () => {
  const path = corridorPathLatLon({
    extrapolating: true,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 0, speedMps: 12, turnRateDps: 3,
    fixLat: 30.199, fixLon: -97.660, lookaheadSec: 30,
  });
  assert.ok(path.length > 2, 'a turning path needs intermediate samples');
  // Mid-path must bulge off the straight line joining the ends — that bulge is
  // the ground a chord-only corridor would leave cold.
  const a = path[0];
  const z = path[path.length - 1];
  const mid = path[Math.floor(path.length / 2)];
  const t = (mid.lat - a.lat) / (z.lat - a.lat);
  const chordLon = a.lon + (z.lon - a.lon) * t;
  assert.ok(Math.abs(mid.lon - chordLon) > 1e-4,
    `arc midpoint ${mid.lon} should not sit on the chord ${chordLon}`);
});

test('corridorPathLatLon on a stationary coaster collapses to the display point', () => {
  const path = corridorPathLatLon({
    extrapolating: true,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 45, speedMps: 0, lookaheadSec: 60,
    fixLat: 30.200, fixLon: -97.660,
  });
  for (const p of path) assert.deepEqual(p, { lat: 30.2, lon: -97.66 });
});

test('corridorPathLatLon falls back to projection when the fix is unusable', () => {
  const path = corridorPathLatLon({
    extrapolating: false,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 90, speedMps: 10, turnRateDps: 0,
    fixLat: NaN, fixLon: NaN, lookaheadSec: 60,
  });
  assert.ok(path[path.length - 1].lon > -97.660, 'still produces a usable endpoint');
});

test('corridorPathLatLon returns nothing without a display position', () => {
  assert.deepEqual(corridorPathLatLon({
    extrapolating: true, displayLat: NaN, displayLon: -97.66, courseDeg: 0, speedMps: 10, lookaheadSec: 60,
  }), []);
});
