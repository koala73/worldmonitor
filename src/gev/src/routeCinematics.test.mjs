/**
 * fly_route cinematic pins.
 *
 * The dolly is watched, not read, so these lock the qualities an owner can see
 * in a screen recording: it starts and stops from rest, it never steps speed,
 * it rolls INTO turns by a bounded amount and rolls back out, it never clips
 * the mesh, it flattens under prefers-reduced-motion, and it stops the instant
 * anything interrupts it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  ROUTE_CINEMA,
  advanceRouteFlight,
  approachValue,
  createRouteFlight,
  flyRoute,
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  prefersReducedMotion,
  routeAltitudeOffsetM,
  routeColdSeedFloorM,
  routeCorridorCells,
  routeEyeHeightM,
  routeFloorHoldM,
  routeRampFraction,
  probeMeshFloorM,
  routeSpeedProfile,
  signedTurnRad,
} from './cameraVerbs.js';

const FRAME_S = 1 / 60;
const CRUISE_M_S = { slow: 20, normal: 40, fast: 90 };

/**
 * Roll of an applied camera frame, in degrees, + = right wing down. This is
 * what Cesium derives from a direction/up pair, so pins that read it are
 * reading the orientation a viewer would actually see.
 */
function rollDegOf(eye, direction, up) {
  const surfaceUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cesium.Cartesian3());
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, surfaceUp, new Cesium.Cartesian3()), new Cesium.Cartesian3(),
  );
  const levelUp = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()), new Cesium.Cartesian3(),
  );
  const sin = Cesium.Cartesian3.dot(
    Cesium.Cartesian3.cross(levelUp, up, new Cesium.Cartesian3()), direction,
  );
  return Cesium.Math.toDegrees(Math.atan2(sin, Cesium.Cartesian3.dot(levelUp, up)));
}

/**
 * A viewer whose camera actually MODELS orientation: setView with a
 * direction/up pair updates heading/pitch/roll the way Cesium's own
 * decomposition does, and setView with an explicit roll writes it back. Without
 * that, a pin can only prove the code called setView — not that the horizon
 * the user is left holding is level.
 */
function createTickableViewer({ heightM = 700 } = {}) {
  const listeners = [];
  const setViews = [];
  // The tick derives dt from the wall clock, so a synchronous test loop would
  // advance the flight by ~0 no matter how many times it ticked. Stub the
  // clock and step it explicitly.
  const realPerformance = globalThis.performance;
  let nowMs = 0;
  globalThis.performance = { now: () => nowMs };
  const position = Cesium.Cartesian3.fromDegrees(-97.76, 30.26, heightM);
  const camera = {
    positionWC: position,
    positionCartographic: Cesium.Cartographic.fromCartesian(position),
    heading: 0,
    pitch: Cesium.Math.toRadians(-45),
    roll: 0,
    cancelFlight() {},
    lookAtTransform() {},
    setView(options) {
      setViews.push(options);
      const orientation = options?.orientation;
      // A destination ALWAYS moves the camera, whatever orientation form came
      // with it. Branching on the orientation shape instead would let a
      // levelling call that also passed a destination slip past the pose pin.
      if (options?.destination) camera.positionWC = options.destination;
      if (orientation?.direction) {
        camera.roll = Cesium.Math.toRadians(rollDegOf(
          options?.destination || camera.positionWC, orientation.direction, orientation.up,
        ));
      }
      if (orientation && Number.isFinite(orientation.roll)) camera.roll = orientation.roll;
      if (orientation && Number.isFinite(orientation.heading)) camera.heading = orientation.heading;
      if (orientation && Number.isFinite(orientation.pitch)) camera.pitch = orientation.pitch;
    },
  };
  const viewer = {
    trackedEntity: undefined,
    clock: { onTick: { addEventListener: (fn) => { listeners.push(fn); return () => {}; } } },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      tweens: [],
      requestRender() {},
      // A live app has a rendered surface under the route; the mesh probe reads
      // it, so these flights start immediately rather than arming.
      sampleHeight: () => 0,
    },
    camera,
  };
  return {
    viewer,
    setViews,
    tick: (dtS = FRAME_S) => {
      nowMs += dtS * 1000;
      for (const fn of listeners) fn();
    },
    rollDeg: () => Cesium.Math.toDegrees(camera.roll),
    restore: () => { globalThis.performance = realPerformance; },
  };
}

/** The floor a flight is holding, for assertions that care about the value. */
function flight_floorOf(flight) {
  return flight.floorM;
}

/** Unit horizontal component of a pitched camera direction at `eye`. */
function horizontalOf(eye, direction) {
  const surfaceUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cesium.Cartesian3());
  const vertical = Cesium.Cartesian3.multiplyByScalar(
    surfaceUp, Cesium.Cartesian3.dot(direction, surfaceUp), new Cesium.Cartesian3(),
  );
  return Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(direction, vertical, new Cesium.Cartesian3()), new Cesium.Cartesian3(),
  );
}

/** Build a flight the way flyRoute() does, from [lon, lat] degrees. */
function flightFrom(lonLat, options = {}) {
  const pts = lonLat.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0));
  const cumM = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cumM.push(cumM[i - 1] + Cesium.Cartesian3.distance(pts[i - 1], pts[i]));
  }
  return createRouteFlight({ pts, cumM, ...options });
}

/** Fly the whole route at a fixed frame rate and record every frame. */
function record(flight, { maxFrames = 20000 } = {}) {
  const frames = [];
  for (let i = 0; i < maxFrames; i += 1) {
    const frame = advanceRouteFlight(flight, FRAME_S);
    // Arming frames carry no pose — the dolly is waiting for terrain, and the
    // camera is deliberately untouched.
    if (frame.arming) continue;
    frames.push({
      progress: frame.progress,
      speed: frame.groundSpeedMps,
      bankDeg: frame.bankDeg,
      heightM: frame.heightM,
      aglM: frame.aglM,
      traveledM: flight.traveled,
      eye: Cesium.Cartesian3.clone(frame.eye),
      direction: Cesium.Cartesian3.clone(frame.direction),
      up: Cesium.Cartesian3.clone(frame.up),
    });
    if (frame.finished) break;
  }
  assert.ok(frames.at(-1).progress >= 1, 'the flight must terminate');
  return frames;
}

function maxStep(values) {
  let worst = 0;
  for (let i = 1; i < values.length; i += 1) worst = Math.max(worst, Math.abs(values[i] - values[i - 1]));
  return worst;
}

// Austin: a 6-waypoint route with two sharp turns (a right, then a left).
const TWO_TURN_ROUTE = [
  [-97.7600, 30.2600],
  [-97.7480, 30.2600],
  [-97.7480, 30.2700], // sharp LEFT (east → north)
  [-97.7350, 30.2700], // sharp RIGHT (north → east)
  [-97.7350, 30.2800],
  [-97.7220, 30.2800],
];
const STRAIGHT_ROUTE = [[-97.76, 30.26], [-97.70, 30.26], [-97.64, 30.26]];

test('the speed profile eases in and out with no step anywhere', () => {
  const flight = flightFrom(TWO_TURN_ROUTE);
  const frames = record(flight);
  const speeds = frames.map((f) => f.speed);
  const cruise = CRUISE_M_S.normal;

  // Starts and ends from rest — no instant velocity step at either end.
  assert.ok(speeds[0] < cruise * 0.05, `start speed ${speeds[0].toFixed(2)} must be ~0`);
  assert.ok(speeds.at(-1) < cruise * 0.05, `end speed ${speeds.at(-1).toFixed(2)} must be ~0`);

  // Bounded acceleration for the whole flight: the profile is continuous, and
  // no waypoint crossing perturbs it (segment-constant speed is gone).
  assert.ok(maxStep(speeds) < 0.6, `per-frame speed step ${maxStep(speeds).toFixed(3)} m/s too large`);

  // Cruise plateau is exactly flat — waypoints are invisible to the profile.
  const plateau = frames.filter((f) => f.progress > 0.4 && f.progress < 0.6).map((f) => f.speed);
  assert.ok(plateau.length > 10);
  assert.ok(maxStep(plateau) < 1e-9, 'the cruise plateau must not wobble at waypoints');

  // Distance advances monotonically and lands exactly on the route end.
  const traveled = frames.map((f) => f.traveledM);
  for (let i = 1; i < traveled.length; i += 1) {
    assert.ok(traveled[i] >= traveled[i - 1] - 1e-9, 'the dolly never runs backwards');
  }
  assert.ok(Math.abs(traveled.at(-1) - flight.totalM) < 1e-6, 'the dolly reaches the final waypoint');
});

test('easing preserves the shipped pace — mean speed is still the speed word', () => {
  for (const speed of ['slow', 'normal', 'fast']) {
    const flight = flightFrom(TWO_TURN_ROUTE, { speed });
    const expectedS = flight.totalM / CRUISE_M_S[speed];
    assert.ok(
      Math.abs(flight.durationS - expectedS) < 1e-6,
      `${speed}: duration ${flight.durationS} should equal totalM / ${CRUISE_M_S[speed]}`,
    );
    const frames = record(flight);
    const elapsedS = frames.length * FRAME_S;
    assert.ok(
      Math.abs(elapsedS - expectedS) < 0.5,
      `${speed}: flew for ${elapsedS.toFixed(2)}s, expected ${expectedS.toFixed(2)}s`,
    );
  }
});

test('routeSpeedProfile is continuous, normalized, and zero at both ends', () => {
  const r = routeRampFraction(30);
  assert.ok(r > 0 && r <= 0.35);
  assert.equal(routeSpeedProfile(0, r).distance, 0);
  assert.equal(routeSpeedProfile(0, r).speed, 0);
  assert.ok(Math.abs(routeSpeedProfile(1, r).distance - 1) < 1e-12);
  assert.equal(routeSpeedProfile(1, r).speed, 0);
  // Sampled derivative matches the reported speed everywhere (the closed-form
  // distance really is the integral of the speed curve).
  const cruiseShare = 1 / (1 - r);
  for (let u = 0.001; u < 1; u += 0.001) {
    const h = 1e-5;
    const derivative = (routeSpeedProfile(u + h, r).distance - routeSpeedProfile(u - h, r).distance) / (2 * h);
    const reported = routeSpeedProfile(u, r).speed * cruiseShare;
    assert.ok(Math.abs(derivative - reported) < 1e-3, `derivative mismatch at u=${u.toFixed(3)}`);
  }
  // Short flights cap the ramp share rather than easing for the whole runtime.
  assert.equal(routeRampFraction(1), 0.35);
  assert.equal(routeRampFraction(0), 0);
});

test('turns bank into the corner, capped, and roll in and out smoothly', () => {
  const frames = record(flightFrom(TWO_TURN_ROUTE));
  const banks = frames.map((f) => f.bankDeg);

  // Level at both ends.
  assert.ok(Math.abs(banks[0]) < 0.01, 'the dolly starts wings level');
  assert.ok(Math.abs(banks.at(-1)) < 1.5, 'the dolly finishes near wings level');

  // Capped — this is a map, not a flight sim.
  const peak = Math.max(...banks.map(Math.abs));
  assert.ok(peak <= ROUTE_CINEMA.maxBankDeg + 1e-9, `bank ${peak.toFixed(2)}° exceeded the cap`);
  assert.ok(peak > 3, `a 90° corner should read as a real bank, got ${peak.toFixed(2)}°`);

  // Both directions appear: this route alternates left and right corners.
  assert.ok(Math.min(...banks) < -3, 'the left turns bank left');
  assert.ok(Math.max(...banks) > 3, 'the right turns bank right');
  // The FIRST corner is a left, and the roll follows the path, not a clock.
  const firstRoll = banks.find((deg) => Math.abs(deg) > 3);
  assert.ok(firstRoll < 0, `the first corner is a left turn, rolled ${firstRoll?.toFixed(2)}°`);

  // Smooth entry/exit: no roll step a viewer could see as a snap.
  assert.ok(maxStep(banks) < 0.25, `per-frame roll step ${maxStep(banks).toFixed(3)}° too large`);
});

test('a straight route never banks', () => {
  const banks = record(flightFrom(STRAIGHT_ROUTE)).map((f) => f.bankDeg);
  assert.ok(Math.max(...banks.map(Math.abs)) < 0.05, 'a straight run must stay wings level');
});

test('a hairpin saturates the cap without exceeding it', () => {
  const hairpin = [[-97.76, 30.26], [-97.74, 30.26], [-97.76, 30.2605]];
  const banks = record(flightFrom(hairpin, { speed: 'slow' })).map((f) => f.bankDeg);
  const peak = Math.max(...banks.map(Math.abs));
  assert.ok(peak <= ROUTE_CINEMA.maxBankDeg + 1e-9, `hairpin bank ${peak.toFixed(2)}° exceeded the cap`);
  assert.ok(peak > ROUTE_CINEMA.maxBankDeg - 1.5, `a hairpin should reach the cap, got ${peak.toFixed(2)}°`);
});

test('the banked up vector is a roll about the camera forward axis, not a skew', () => {
  const frames = record(flightFrom(TWO_TURN_ROUTE));
  for (const frame of frames) {
    // Orthonormal frame: an up vector that is not perpendicular to direction
    // would shear the view when Cesium converts it to heading/pitch/roll.
    assert.ok(Math.abs(Cesium.Cartesian3.magnitude(frame.up) - 1) < 1e-9);
    assert.ok(Math.abs(Cesium.Cartesian3.magnitude(frame.direction) - 1) < 1e-9);
    assert.ok(Math.abs(Cesium.Cartesian3.dot(frame.up, frame.direction)) < 1e-9);
  }
  // Pitch stays locked at the designed look-down angle for the whole flight.
  for (const frame of frames) {
    const surfaceUp = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(frame.eye, new Cesium.Cartesian3());
    const pitchDeg = -Cesium.Math.toDegrees(
      Math.asin(-Cesium.Cartesian3.dot(frame.direction, surfaceUp)),
    );
    assert.ok(
      Math.abs(pitchDeg - ROUTE_CINEMA.pitchDeg) < 0.5,
      `pitch drifted to ${pitchDeg.toFixed(2)}°`,
    );
  }
});

test('altitude breathes around the requested mean and rises into turns', () => {
  const flight = flightFrom(TWO_TURN_ROUTE, { floorFn: () => 0 });
  const heights = record(flight).map((f) => f.aglM);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  assert.ok(min >= ROUTE_CINEMA.meanHeightM - ROUTE_CINEMA.breathM - 1e-6, `dipped to ${min.toFixed(1)} m`);
  assert.ok(
    max <= ROUTE_CINEMA.meanHeightM + ROUTE_CINEMA.breathM + ROUTE_CINEMA.turnLiftM + 1e-6,
    `climbed to ${max.toFixed(1)} m`,
  );
  assert.ok(max - min > 5, 'the altitude should actually breathe');
  // Vertical rate stays gentle. The peak is the climb INTO a corner (against
  // 40 m/s of ground speed — a shallow swell); rolling back out sinks far
  // slower, because the lift tracks the roll on a deliberately lazy filter.
  const verticalMps = maxStep(heights) / FRAME_S;
  assert.ok(verticalMps < 7, `vertical rate reached ${verticalMps.toFixed(2)} m/s`);

  // Breathing alone is zero-mean: one wavelength integrates to nothing, so the
  // requested altitude stays the mean of a straight run.
  let sum = 0;
  const samples = 2000;
  for (let i = 0; i < samples; i += 1) sum += routeAltitudeOffsetM((i / samples) * 2200, 0);
  assert.ok(Math.abs(sum / samples) < 0.2, 'breathing must be zero-mean');
  // Turning lifts, and only lifts.
  assert.ok(routeAltitudeOffsetM(0, 1) > routeAltitudeOffsetM(0, 0));
  assert.ok(routeAltitudeOffsetM(0, -1) > routeAltitudeOffsetM(0, 0));
});

test('a rise is cleared BEFORE the camera reaches it, not as it arrives', () => {
  // A 900 m ridge across the middle of the route. Clearance under the camera
  // alone cannot prove the lookahead read exists — the floor hold adopts a rise
  // instantly, so reading only the current cell still clears the cell you are
  // standing on. What the lookahead buys is clearing the ridge while you are
  // still SHORT of it, which is what this measures.
  const ridgeFloor = (lat, lon) => (lon > -97.745 && lon < -97.730 ? 900 : 0);
  const flight = flightFrom(TWO_TURN_ROUTE, { floorFn: ridgeFloor });
  const frames = record(flight);
  const floorAtFrame = (frame) => {
    const carto = Cesium.Cartographic.fromCartesian(frame.eye);
    return ridgeFloor(
      Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude),
    );
  };
  let approachSamples = 0;
  for (let i = 0, ahead = 0; i < frames.length; i += 1) {
    const carto = Cesium.Cartographic.fromCartesian(frames[i].eye);
    assert.ok(
      carto.height - floorAtFrame(frames[i]) >= ROUTE_CINEMA.minClearanceM - 1e-6,
      `eye at ${carto.height.toFixed(1)} m cleared the floor under it by too little`,
    );
    // Where the camera will BE in ~130 m of travel — half the lookahead at
    // "normal", roughly three seconds out. Reading only the current cell still
    // clears the cell you stand on (the floor hold adopts a rise instantly);
    // what the ahead read buys is being high enough BEFORE you get there.
    while (ahead < frames.length - 1 && frames[ahead].traveledM < frames[i].traveledM + 130) ahead += 1;
    const floorAhead = floorAtFrame(frames[ahead]);
    if (floorAhead > floorAtFrame(frames[i])) {
      approachSamples += 1;
      assert.ok(
        carto.height - floorAhead >= ROUTE_CINEMA.minClearanceM - 1e-6,
        `on approach the eye was ${carto.height.toFixed(1)} m against a ${floorAhead} m ridge 130 m ahead`,
      );
    }
  }
  assert.ok(approachSamples > 10, `the route must actually approach the ridge (${approachSamples} samples)`);
  // The clamp is the last word even if the shaping constants were retuned into
  // the ground.
  assert.equal(routeEyeHeightM(500, -100000), 500 + ROUTE_CINEMA.minClearanceM);
  assert.equal(routeEyeHeightM(Number.NaN, 0), ROUTE_CINEMA.meanHeightM);
});

test('a COLD corridor never descends blind — the seed holds until terrain lands', () => {
  // The failure this exists for: OSRM route vertices carry height 0, and an
  // unwarmed floor cell reads null. Trusting the vertex put the eye 1.3 km
  // UNDER Albuquerque. Cold is missing data, not flat ground.
  const ALBUQUERQUE = [[-106.61, 35.08], [-106.55, 35.08]];
  const REAL_FLOOR_M = 1600;
  const cold = flightFrom(ALBUQUERQUE, { floorFn: () => null, cameraHeightM: 2400 });
  let first = advanceRouteFlight(cold, FRAME_S);
  while (first.arming) first = advanceRouteFlight(cold, FRAME_S); // outlast the arm
  assert.ok(
    first.heightM > REAL_FLOOR_M,
    `a cold corridor put the eye at ${first.heightM.toFixed(0)} m, under ${REAL_FLOOR_M} m of terrain`,
  );

  // And when the DEM lands a second in, the eye eases down to cruise without
  // ever dropping below the clamp.
  const warming = flightFrom(ALBUQUERQUE, { floorFn: () => null, cameraHeightM: 2400 });
  let minClearance = Infinity;
  for (let i = 0; ; i += 1) {
    if (i === 60) warming.floorFn = () => REAL_FLOOR_M;
    const frame = advanceRouteFlight(warming, FRAME_S);
    if (frame.arming) continue;
    minClearance = Math.min(minClearance, frame.heightM - REAL_FLOOR_M);
    if (frame.finished) break;
  }
  assert.ok(
    minClearance >= ROUTE_CINEMA.minClearanceM - 1e-6,
    `the descent onto a late floor dipped to ${minClearance.toFixed(1)} m of clearance`,
  );
  assert.ok(warming.armS > 0, 'the flight armed rather than racing the warm');
  assert.equal(warming.floorKnown, true, 'and it picked the floor up when it landed');

  // The first real floor is an ACQUISITION, taken at once. Easing onto it would
  // turn the gap between the safety seed and the ground into a several-hundred-
  // metre plummet (measured: 358 m/s). After it lands, ordinary descents are
  // eased as usual.
  const acquiring = flightFrom(ALBUQUERQUE, { floorFn: () => null, cameraHeightM: 2400 });
  assert.equal(acquiring.floorKnown, false, 'a cold construction has no floor yet');
  // The warm lands DURING the arm — the ordinary case, and the one where the
  // floor may be taken whole because nothing has moved yet.
  advanceRouteFlight(acquiring, FRAME_S);
  assert.equal(acquiring.floorM, Number.NaN === acquiring.floorM ? Number.NaN : acquiring.floorM);
  acquiring.floorFn = () => REAL_FLOOR_M;
  advanceRouteFlight(acquiring, FRAME_S);
  assert.equal(acquiring.floorM, REAL_FLOOR_M, 'a pre-departure floor is adopted whole, not eased');
  assert.equal(acquiring.floorKnown, true);
  let peakVerticalMps = 0;
  let previous = advanceRouteFlight(acquiring, FRAME_S).heightM;
  for (let i = 0; i < 600; i += 1) {
    const height = advanceRouteFlight(acquiring, FRAME_S).heightM;
    peakVerticalMps = Math.max(peakVerticalMps, Math.abs(height - previous) / FRAME_S);
    previous = height;
  }
  assert.ok(peakVerticalMps < 7, `after acquisition the eye moved at ${peakVerticalMps.toFixed(1)} m/s`);

  // A corridor that is already warm at construction never needs the seed.
  const prewarmed = flightFrom(ALBUQUERQUE, { floorFn: () => REAL_FLOOR_M, cameraHeightM: 2400 });
  assert.equal(prewarmed.floorKnown, true, 'a warm cache is adopted before the first frame');
  assert.equal(prewarmed.floorM, REAL_FLOOR_M);
});

test('a cold route ARMS for terrain rather than racing the warm', () => {
  // The corridor warm is fire-and-forget, so the alternative to waiting is
  // racing it. Losing that race used to put the eye at an altitude derived from
  // the camera — 774 m underground from a LOW starting camera, which the old
  // pin missed only because it supplied a conveniently safe 2,400 m one.
  const ALBUQUERQUE = [[-106.61, 35.08], [-106.55, 35.08]];
  const REAL_FLOOR_M = 1600;
  const LOW_CAMERA_M = 826;
  let cold = true;
  const flight = flightFrom(ALBUQUERQUE, {
    floorFn: () => (cold ? null : REAL_FLOOR_M),
    cameraHeightM: LOW_CAMERA_M,
  });
  assert.equal(flight.floorKnown, false);

  // While armed the camera is not touched AT ALL — no teleport onto the route,
  // no descent, no frame to apply.
  for (let i = 0; i < 20; i += 1) {
    const frame = advanceRouteFlight(flight, FRAME_S);
    assert.equal(frame.arming, true, 'a cold dolly must not move before it has terrain');
    assert.equal(frame.eye, undefined, 'an arming frame carries no pose to apply');
  }
  assert.equal(flight.traveled, 0, 'and it has not advanced along the route');
  assert.ok(flight.armS > 0.3, 'the arm actually elapsed');

  // The warm lands. From here the flight is ordinary, and never underground.
  cold = false;
  let minHeight = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const frame = advanceRouteFlight(flight, FRAME_S);
    if (frame.arming) continue;
    minHeight = Math.min(minHeight, frame.heightM);
    if (frame.finished) break;
  }
  assert.ok(
    minHeight >= REAL_FLOOR_M + ROUTE_CINEMA.minClearanceM - 1e-6,
    `a cold route flew to ${minHeight.toFixed(0)} m over ${REAL_FLOOR_M} m of terrain`,
  );
});

test('the rendered mesh answers when the DEM never will — once, and only once', () => {
  // The DEM can stay cold indefinitely (proxy down). Clipping requires terrain
  // to BE rendered, and what is rendered is what sampleHeight reads — so the
  // mesh probe closes the hole in the case where the hole is visible.
  const ALBUQUERQUE = [[-106.61, 35.08], [-106.55, 35.08]];
  const REAL_FLOOR_M = 1600;
  const probeCalls = [];
  const flight = flightFrom(ALBUQUERQUE, {
    floorFn: () => null,
    cameraHeightM: 826,
    probeFn: (cells) => {
      probeCalls.push(cells.length);
      return { heightM: REAL_FLOOR_M, sampled: cells.length, requested: cells.length };
    },
  });
  assert.equal(flight.floorKnown, true, 'the probe is consulted before the first frame');
  assert.equal(flight.floorFromMeshProbe, true);

  let minHeight = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const frame = advanceRouteFlight(flight, FRAME_S);
    assert.notEqual(frame.arming, true, 'a probe hit means there is nothing to wait for');
    minHeight = Math.min(minHeight, frame.heightM);
    if (frame.finished) break;
  }
  assert.ok(minHeight >= REAL_FLOOR_M + ROUTE_CINEMA.minClearanceM - 1e-6, `flew at ${minHeight.toFixed(0)} m`);

  // ONE-SHOT, for the whole route. The acquisition re-runs every arming frame
  // to notice the DEM landing — that part is cache reads — but the probe is
  // latched, so a regression to per-frame sampling turns this red.
  assert.equal(probeCalls.length, 1, `the probe fired ${probeCalls.length} times over one route`);
  const totalSampleHeightCalls = probeCalls.reduce((sum, n) => sum + n, 0);
  assert.ok(
    totalSampleHeightCalls <= 8,
    `a route cost ${totalSampleHeightCalls} sampleHeight calls (budget 8)`,
  );

  // A route whose cache is already warm never probes at all.
  const warmProbes = [];
  const warm = flightFrom(ALBUQUERQUE, {
    floorFn: () => REAL_FLOOR_M,
    cameraHeightM: 826,
    probeFn: (cells) => { warmProbes.push(cells.length); return { heightM: 0, sampled: 0, requested: 0 }; },
  });
  for (let i = 0; i < 300; i += 1) advanceRouteFlight(warm, FRAME_S);
  assert.equal(warmProbes.length, 0, 'a warm corridor must not touch the mesh at all');

  // The probe stays latched even when it answers with nothing, so an arm that
  // runs its full 1.2 s still costs one probe.
  const blindProbes = [];
  const blind = flightFrom(ALBUQUERQUE, {
    floorFn: () => null,
    cameraHeightM: 826,
    probeFn: (cells) => { blindProbes.push(cells.length); return { heightM: Number.NaN, sampled: 0, requested: cells.length }; },
  });
  assert.equal(blind.floorKnown, false);
  for (let i = 0; i < 300; i += 1) advanceRouteFlight(blind, FRAME_S);
  assert.equal(blindProbes.length, 1, `a blind probe fired ${blindProbes.length} times`);

  // A hostile probe cannot take the flight down, and is still only tried once.
  let hostileCalls = 0;
  const hostile = flightFrom(ALBUQUERQUE, {
    floorFn: () => null,
    cameraHeightM: 826,
    probeFn: () => { hostileCalls += 1; throw new Error('scene gone'); },
  });
  for (let i = 0; i < 300; i += 1) advanceRouteFlight(hostile, FRAME_S);
  assert.equal(hostileCalls, 1);
});

test('probeMeshFloorM reports COVERAGE, not just a height', () => {
  assert.deepEqual(probeMeshFloorM(null, [{ lat: 1, lon: 1 }]),
    { heightM: Number.NaN, sampled: 0, requested: 1 }, 'no scene, no reading');
  assert.deepEqual(probeMeshFloorM({ sampleHeight: () => 120 }, []),
    { heightM: Number.NaN, sampled: 0, requested: 0 }, 'no cells, no reading');
  // Cells whose tiles are not streamed contribute NOTHING — silence must never
  // be mistaken for flat ground, which is why the caller gets a count.
  const partial = probeMeshFloorM(
    { sampleHeight: (c) => (c.longitude > 0 ? 340 : undefined) },
    [{ lat: 1, lon: 1 }, { lat: 1, lon: -1 }],
  );
  assert.equal(partial.heightM, 340, 'the probe takes the HIGHEST surface it saw');
  assert.equal(partial.sampled, 1, 'and reports that it only reached one of two cells');
  assert.equal(partial.requested, 2);
});

test('a PARTIALLY warm corridor is unresolved, and probes only the cold cells', () => {
  // One cached cell says nothing about the ground under the other seven.
  // Treating it as an answer let the dolly descend to 460 m over a 1,600 m
  // rendered surface — the cache read succeeded, so neither the arm nor the
  // probe ever ran.
  const ALBUQUERQUE = [[-106.61, 35.08], [-106.55, 35.08]];
  const VALLEY_M = 200;
  const RIDGE_M = 1600;
  const probedCells = [];
  // Exactly one cell of the corridor is warm, and it is the LOW one.
  let warmCell = null;
  const partial = flightFrom(ALBUQUERQUE, {
    cameraHeightM: 2400,
    floorFn: (lat, lon) => {
      if (warmCell === null) warmCell = `${lat},${lon}`; // the first cell asked for
      return `${lat},${lon}` === warmCell ? VALLEY_M : null;
    },
    probeFn: (cells) => {
      probedCells.push(cells.map((c) => `${c.lat},${c.lon}`));
      return { heightM: RIDGE_M, sampled: cells.length, requested: cells.length };
    },
  });
  assert.equal(probedCells.length, 1, 'the cold cells must be probed');
  assert.ok(probedCells[0].length >= 1, 'and there were cold cells to probe');
  assert.ok(!probedCells[0].includes(warmCell), 'the already-warm cell must not be re-probed');
  assert.equal(flight_floorOf(partial), RIDGE_M, 'the corridor takes its HIGHEST known ground');

  let minHeight = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const frame = advanceRouteFlight(partial, FRAME_S);
    if (frame.arming) continue;
    minHeight = Math.min(minHeight, frame.heightM);
    if (frame.finished) break;
  }
  assert.ok(
    minHeight >= RIDGE_M + ROUTE_CINEMA.minClearanceM - 1e-6,
    `a half-warm corridor flew at ${minHeight.toFixed(0)} m over a ${RIDGE_M} m ridge`,
  );

  // And when the probe cannot reach the cold cells either, the corridor stays
  // UNRESOLVED: the arm runs and the launch-altitude hold carries the flight.
  let seen = null;
  const unresolved = flightFrom(ALBUQUERQUE, {
    cameraHeightM: 2400,
    floorFn: (lat, lon) => {
      if (seen === null) seen = `${lat},${lon}`;
      return `${lat},${lon}` === seen ? VALLEY_M : null;
    },
    probeFn: (cells) => ({ heightM: Number.NaN, sampled: 0, requested: cells.length }),
  });
  assert.equal(unresolved.floorKnown, false, 'one warm cell does not resolve a corridor');
  assert.equal(advanceRouteFlight(unresolved, FRAME_S).arming, true, 'so the dolly arms');
  let held = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const frame = advanceRouteFlight(unresolved, FRAME_S);
    if (frame.arming) continue;
    held = Math.min(held, frame.heightM);
    if (frame.finished) break;
  }
  assert.ok(held >= 2400 - 1e-6, `held ${held.toFixed(0)} m, below the launch altitude`);
});

test('floor data arriving mid-flight blends down, and never arriving holds', () => {
  const ALBUQUERQUE = [[-106.61, 35.08], [-106.55, 35.08]];
  const LAUNCH_M = 2400;

  // (a) LATE arrival. Pre-departure acquisition takes the floor whole because
  // nothing is moving yet; an arrival after the arm gave up must ease, or the
  // gap between the safety hold and the ground becomes a mid-flight plummet.
  let cold = true;
  const late = flightFrom(ALBUQUERQUE, {
    floorFn: () => (cold ? null : 150),
    cameraHeightM: LAUNCH_M,
  });
  let previous = null;
  let worstDropMps = 0;
  let heldWhileCold = 0;
  let floorBeforeArrival = Number.NaN;
  let floorOnArrivalFrame = Number.NaN;
  for (let i = 0; i < 20000; i += 1) {
    if (i === 1200) { // ~20 s in, long after the arm expired
      cold = false;
      floorBeforeArrival = late.floorM;
    }
    const frame = advanceRouteFlight(late, FRAME_S);
    if (frame.arming) continue;
    if (i === 1200) floorOnArrivalFrame = late.floorM;
    if (cold) heldWhileCold = frame.heightM;
    if (previous !== null) worstDropMps = Math.max(worstDropMps, (previous - frame.heightM) / FRAME_S);
    previous = frame.heightM;
    if (frame.finished) break;
  }
  // The FLOOR itself blends. Taking a mid-flight arrival whole is what the
  // descent limiter exists to survive, not a thing to rely on: the held floor
  // on the arrival frame must sit BETWEEN the old value and the new one.
  assert.ok(
    floorOnArrivalFrame < floorBeforeArrival && floorOnArrivalFrame > 150,
    `a late floor was snapped to ${floorOnArrivalFrame} rather than eased from ${floorBeforeArrival}`,
  );
  assert.ok(heldWhileCold >= LAUNCH_M - 1e-6, `held ${heldWhileCold.toFixed(0)} m, below the launch altitude`);
  assert.ok(worstDropMps <= 10 + 1e-6, `the release dropped the eye at ${worstDropMps.toFixed(1)} m/s`);
  assert.ok(worstDropMps > 1, 'and it did actually descend onto the real floor');

  // (b) NEVER arrives. Honest degradation: hold the launch altitude for the
  // whole route rather than descending into ground nobody has measured.
  const never = flightFrom(ALBUQUERQUE, { floorFn: () => null, cameraHeightM: LAUNCH_M });
  let minHeight = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    const frame = advanceRouteFlight(never, FRAME_S);
    if (frame.arming) continue;
    minHeight = Math.min(minHeight, frame.heightM);
    if (frame.finished) break;
  }
  assert.ok(minHeight >= LAUNCH_M - 1e-6, `held ${minHeight.toFixed(0)} m against a ${LAUNCH_M} m launch`);
  assert.equal(never.floorKnown, false, 'and it never claimed to know the floor');
  assert.ok(never.coldFrames > 100, 'the cold branch carried the whole flight');

  // The seed is bounded: at globe scale the camera's altitude says nothing
  // about the ground under the route.
  assert.equal(routeColdSeedFloorM(0, 2400), 2140);
  assert.equal(routeColdSeedFloorM(0, 17_000_000), 5000, 'the seed is capped');
  assert.equal(routeColdSeedFloorM(0, 100), 0, 'the seed never goes below the path');
  assert.equal(routeColdSeedFloorM(0, Number.NaN), 0);
});

test('a flight warms its own corridor instead of waiting for contact traffic', () => {
  const warmed = [];
  const flight = flightFrom([[-106.61, 35.08], [-106.55, 35.08]], {
    floorFn: () => null,
    warmFn: (cells) => warmed.push(cells),
  });
  assert.equal(warmed.length, 1, 'the head of the corridor is warmed before the first frame');
  const startBatch = warmed[0];
  assert.ok(startBatch.length > 10, `start batch was ${startBatch.length} cells`);
  assert.ok(startBatch.length <= 96, 'one flight can never issue an unbounded warm batch');
  for (const cell of startBatch) {
    assert.equal(cell.lat, Number(cell.lat.toFixed(3)), 'cells sit on the house 0.001° grid');
    assert.equal(cell.lon, Number(cell.lon.toFixed(3)));
  }
  assert.equal(new Set(startBatch.map((c) => `${c.lat},${c.lon}`)).size, startBatch.length, 'deduped');

  // The corridor keeps being warmed AHEAD of the camera as the flight runs.
  for (let i = 0; i < 60 * 6; i += 1) advanceRouteFlight(flight, FRAME_S);
  assert.ok(warmed.length > 1, 'the rolling lookahead warm never fired');
  const later = warmed.at(-1);
  assert.ok(
    later[0].lon > startBatch[0].lon,
    'the rolling warm must move ahead of the camera, not re-warm the start',
  );

  // A warm hook that throws must not take the flight down with it.
  const hostile = flightFrom([[-106.61, 35.08], [-106.55, 35.08]], {
    floorFn: () => 1600,
    warmFn: () => { throw new Error('proxy down'); },
  });
  assert.ok(Number.isFinite(advanceRouteFlight(hostile, FRAME_S).heightM));

  // The collector itself is bounded and ordered.
  const cells = routeCorridorCells(flight, 0, 1e9, 12);
  assert.equal(cells.length, 12, 'the cap is honoured');
});

test('the shaping floor is smoothed both ways, and the CLAMP reads the raw sample', () => {
  assert.equal(routeFloorHoldM(Number.NaN, 120, FRAME_S), 120, 'a cold hold adopts the first sample');
  assert.equal(routeFloorHoldM(400, Number.NaN, FRAME_S), 400, 'a cold cell keeps the held floor');
  // Both directions ease: floor cells are a ~111 m staircase, and adopting a
  // rise instantly popped the eye at every boundary (21.7 m/s over flat ground).
  const rising = routeFloorHoldM(100, 900, FRAME_S);
  assert.ok(rising > 100 && rising < 130, `a rise should ease, got ${rising}`);
  const sinking = routeFloorHoldM(900, 100, FRAME_S);
  assert.ok(sinking < 900 && sinking > 880, `a descent should ease, got ${sinking}`);

  // Safety does not depend on that smoothing: a cliff appearing under the
  // camera is cleared on the frame it is SEEN, because the clamp reads the raw
  // sample rather than the smoothed one.
  const flight = flightFrom(STRAIGHT_ROUTE, { floorFn: () => 0 });
  advanceRouteFlight(flight, FRAME_S);
  flight.floorFn = () => 5000;
  const cliff = advanceRouteFlight(flight, FRAME_S);
  assert.ok(
    cliff.heightM >= 5000 + ROUTE_CINEMA.minClearanceM - 1e-6,
    `a cliff seen this frame must be cleared this frame, eye was ${cliff.heightM.toFixed(0)} m`,
  );
  assert.ok(flight.floorM < 1000, 'while the SHAPING floor is still easing up behind it');
});

test('prefers-reduced-motion flattens the roll and the altitude shaping', () => {
  const flight = flightFrom(TWO_TURN_ROUTE, { floorFn: () => 0, reducedMotion: true });
  const frames = record(flight);
  assert.equal(Math.max(...frames.map((f) => Math.abs(f.bankDeg))), 0, 'no roll under reduced motion');
  for (const frame of frames) {
    assert.ok(Math.abs(frame.aglM - ROUTE_CINEMA.meanHeightM) < 1e-6, 'altitude holds flat');
    assert.ok(Math.abs(Cesium.Cartesian3.dot(frame.up, frame.direction)) < 1e-9);
  }
  // Easing survives: a reduced-motion flight still starts and stops from rest,
  // because an abrupt stop is the motion a viewer feels most.
  assert.ok(frames[0].speed < 2);
  assert.ok(frames.at(-1).speed < 2);
  assert.equal(routeAltitudeOffsetM(500, 0.5, true), 0);
});

test('the reduced-motion PREFERENCE reaches a real flight, not just the flag', () => {
  // Injecting state.reducedMotion proves the shaping honours a boolean. It does
  // not prove the OS preference is ever read — this drives the public path.
  const priorWindow = globalThis.window;
  const queries = [];
  globalThis.window = {
    ...(priorWindow || {}),
    matchMedia: (query) => { queries.push(query); return { matches: true }; },
  };
  try {
    assert.equal(prefersReducedMotion(), true);
    assert.ok(queries.some((q) => /prefers-reduced-motion:\s*reduce/.test(q)), `queried ${queries}`);

    const viewer = createTickableViewer();
    initCameraVerbs(viewer.viewer, () => null);
    const started = flyRoute([{
      type: 'route', label: 'reduced', path: TWO_TURN_ROUTE.map(([lon, lat]) => ({ lon, lat, height: 0 })),
    }]);
    assert.equal(started.ok, true);
    assert.equal(getActiveCameraMotion()?.reducedMotion, true, 'flyRoute must consult the preference');
    for (let i = 0; i < 600; i += 1) viewer.tick();
    assert.ok(
      Math.abs(viewer.rollDeg()) < 1e-3,
      `a reduced-motion flight rolled the real camera to ${viewer.rollDeg()}°`,
    );
    interruptCameraMotion('test-cleanup');

    globalThis.window.matchMedia = () => ({ matches: false });
    assert.equal(prefersReducedMotion(), false);
    flyRoute([{
      type: 'route', label: 'normal', path: TWO_TURN_ROUTE.map(([lon, lat]) => ({ lon, lat, height: 0 })),
    }]);
    assert.equal(getActiveCameraMotion()?.reducedMotion, false);
    interruptCameraMotion('test-cleanup');
    viewer.restore();
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test('an exact U-turn reverses the heading instead of flying the return leg backwards', () => {
  // A Cartesian lerp cannot cross an antipodal pair: below t=0.5 the blend
  // still points the old way, and no per-frame t ever reaches 0.5. The camera
  // used to look BACKWARDS down the entire return leg (direction·travel = −1).
  const OUT_AND_BACK = [[-97.76, 30.26], [-97.74, 30.26], [-97.76, 30.26]];
  const flight = flightFrom(OUT_AND_BACK, { speed: 'slow', floorFn: () => 0 });
  const outbound = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(flight.pts[1], flight.pts[0], new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const returning = Cesium.Cartesian3.negate(outbound, new Cesium.Cartesian3());
  const frames = record(flight);
  const halfM = flight.totalM / 2;

  let worstOut = 1;
  let worstBack = 1;
  for (const frame of frames) {
    const heading = horizontalOf(frame.eye, frame.direction);
    if (frame.traveledM < halfM - 200) {
      worstOut = Math.min(worstOut, Cesium.Cartesian3.dot(heading, outbound));
    } else if (frame.traveledM > halfM + 200) {
      worstBack = Math.min(worstBack, Cesium.Cartesian3.dot(heading, returning));
    }
  }
  assert.ok(worstOut > 0.98, `outbound heading drifted (worst dot ${worstOut.toFixed(3)})`);
  assert.ok(
    worstBack > 0.98,
    `the return leg looked backwards (worst dot ${worstBack.toFixed(3)}; the lerp bug reads −1)`,
  );

  // And the U-turn's bank direction is decided once, not re-rolled every frame
  // by the sign of a floating-point zero.
  const banks = frames.map((f) => f.bankDeg);
  let flips = 0;
  for (let i = 1; i < banks.length; i += 1) {
    if (Math.abs(banks[i]) > 2 && Math.abs(banks[i - 1]) > 2
      && Math.sign(banks[i]) !== Math.sign(banks[i - 1])) flips += 1;
  }
  assert.equal(flips, 0, 'the bank flipped sign mid-turn');
  assert.ok(Math.max(...banks.map(Math.abs)) > 3, 'a U-turn should bank');
  assert.ok(Math.max(...banks.map(Math.abs)) <= ROUTE_CINEMA.maxBankDeg + 1e-9);
});

test('signedTurnRad is deterministic at exactly 180°', () => {
  const up = new Cesium.Cartesian3(0, 0, 1);
  const east = new Cesium.Cartesian3(1, 0, 0);
  const west = new Cesium.Cartesian3(-1, 0, 0);
  // Both signed-zero orderings must agree: the cross product is (0, 0, ±0) and
  // atan2 would hand back +π or −π depending on which zero came out.
  assert.equal(signedTurnRad(east, west, up), Math.PI);
  assert.equal(signedTurnRad(west, east, up), Math.PI);
  // Ordinary turns are unaffected.
  const north = new Cesium.Cartesian3(0, 1, 0);
  assert.ok(signedTurnRad(east, north, up) < 0, 'east → north is a LEFT turn');
  assert.ok(signedTurnRad(north, east, up) > 0, 'north → east is a RIGHT turn');
  assert.ok(Math.abs(Math.abs(signedTurnRad(east, north, up)) - (Math.PI / 2)) < 1e-9);
});

test('approachValue is frame-rate independent and adopts a cold value', () => {
  assert.equal(approachValue(Number.NaN, 7, 2, FRAME_S), 7);
  const oneBigStep = approachValue(0, 10, 2, 0.5);
  let manySmallSteps = 0;
  for (let i = 0; i < 30; i += 1) manySmallSteps = approachValue(manySmallSteps, 10, 2, 0.5 / 30);
  assert.ok(Math.abs(oneBigStep - manySmallSteps) < 1e-9, 'smoothing must not depend on frame rate');
  const afterStall = approachValue(0, 10, 2, 100);
  assert.ok(afterStall <= 10 && afterStall > 9.99, 'a long stall converges without overshooting');
});

test('an interrupt MID-BANK stops the dolly and puts the horizon back level', () => {
  const viewer = createTickableViewer();
  initCameraVerbs(viewer.viewer, () => null);

  const started = flyRoute([{
    type: 'route',
    label: 'evidence route',
    path: TWO_TURN_ROUTE.map(([lon, lat]) => ({ lon, lat, height: 0 })),
  }]);
  assert.equal(started.ok, true);
  assert.equal(started.action, 'fly_route');
  assert.ok(started.distanceM > 0);
  assert.ok(started.durationS > 0);
  assert.equal(getActiveCameraMotion()?.kind, 'route');

  viewer.tick();
  viewer.tick();
  assert.ok(viewer.setViews.length >= 2, 'an active dolly drives the camera every tick');

  // Fly on until the REAL camera is genuinely banked. Cutting a level camera
  // would prove nothing about levelling.
  for (let i = 0; i < 20000 && Math.abs(viewer.rollDeg()) < 3; i += 1) viewer.tick(FRAME_S);
  const rollAtCut = viewer.rollDeg();
  assert.ok(Math.abs(rollAtCut) >= 3, `the camera must be banked before the cut (${rollAtCut.toFixed(2)}°)`);
  const poseAtCut = {
    position: Cesium.Cartesian3.clone(viewer.viewer.camera.positionWC),
    heading: viewer.viewer.camera.heading,
    pitch: viewer.viewer.camera.pitch,
  };

  const { wasActive, leveled } = interruptCameraMotion('manual-input');
  assert.equal(wasActive, true);
  assert.equal(leveled, true, 'the release must take the roll out');
  assert.equal(getActiveCameraMotion(), null, 'the motion slot is free the instant it is cut');
  assert.ok(
    Math.abs(viewer.rollDeg()) < 1e-9,
    `the horizon was left tilted at ${viewer.rollDeg().toFixed(3)}° after the cut`,
  );
  // Levelling preserves where the camera was looking — it is not a re-frame.
  // Asserted NUMERICALLY, not just by the omitted destination: position,
  // heading and pitch must come out the far side unchanged.
  const levelling = viewer.setViews.at(-1);
  assert.equal(levelling.orientation.roll, 0);
  assert.equal(levelling.destination, undefined, 'levelling must not move the camera');
  assert.equal(
    Cesium.Cartesian3.distance(viewer.viewer.camera.positionWC, poseAtCut.position), 0,
    'the camera moved while being levelled',
  );
  assert.equal(viewer.viewer.camera.heading, poseAtCut.heading, 'heading changed while levelling');
  assert.equal(viewer.viewer.camera.pitch, poseAtCut.pitch, 'pitch changed while levelling');

  const writesAtCut = viewer.setViews.length;
  viewer.tick();
  viewer.tick();
  viewer.tick();
  assert.equal(viewer.setViews.length, writesAtCut, 'no camera write survives the interrupt');

  // A second interrupt is inert, and never resurrects the flight.
  assert.equal(interruptCameraMotion('again').wasActive, false);
  assert.equal(getActiveCameraMotion(), null);
});

test('a completed dolly lands wings level and releases the slot', () => {
  const viewer = createTickableViewer();
  initCameraVerbs(viewer.viewer, () => null);
  // A route that is still turning as it ends — the case where a bank would
  // otherwise be frozen into the final frame.
  const started = flyRoute([{
    type: 'route',
    label: 'ends in a corner',
    path: [
      [-97.760, 30.260], [-97.748, 30.260], [-97.748, 30.268], [-97.740, 30.268],
    ].map(([lon, lat]) => ({ lon, lat, height: 0 })),
  }], { speed: 'fast' });
  assert.equal(started.ok, true);

  let banked = 0;
  for (let i = 0; i < 20000 && getActiveCameraMotion(); i += 1) {
    viewer.tick(FRAME_S);
    if (Math.abs(viewer.rollDeg()) > 3) banked += 1;
  }
  assert.ok(banked > 10, 'the route must actually bank before it ends');
  assert.equal(getActiveCameraMotion(), null, 'completion releases the motion slot');
  assert.ok(
    Math.abs(viewer.rollDeg()) < 1e-3,
    `the flight ended holding ${viewer.rollDeg().toFixed(5)}° of roll`,
  );
  // The roll came out through the ease-out, not as a snap on the last frame.
  const rolls = viewer.setViews
    .filter((v) => v.orientation?.direction)
    .map((v) => rollDegOf(v.destination, v.orientation.direction, v.orientation.up));
  assert.ok(maxStep(rolls) < 0.5, `the unwind stepped ${maxStep(rolls).toFixed(3)}° in one frame`);
  assert.ok(Math.abs(rolls.at(-1)) < 1e-3, 'the last APPLIED frame is level on its own');
});

test('a completed dolly lands on the last waypoint', () => {
  const flight = flightFrom(STRAIGHT_ROUTE, { speed: 'fast' });
  const frames = record(flight);
  assert.equal(frames.at(-1).progress, 1);
  // The final frame is applied before the slot is released — the camera lands
  // on the route's last waypoint rather than stopping short of it.
  const endpoint = Cesium.Cartesian3.fromDegrees(...STRAIGHT_ROUTE.at(-1), 0);
  const endCarto = Cesium.Cartographic.fromCartesian(frames.at(-1).eye);
  const endGround = Cesium.Cartesian3.fromRadians(endCarto.longitude, endCarto.latitude, 0);
  assert.ok(Cesium.Cartesian3.distance(endpoint, endGround) < 1, 'the dolly lands on the last waypoint');
  assert.equal(frames.at(-1).bankDeg, 0, 'and it lands level');
});

test('the 0.5 s duration floor is the one place the speed word is not the mean', () => {
  // Documented, not accidental: a route shorter than the camera is tall would
  // otherwise be an instant teleport (and divides the profile by ~zero).
  const tiny = flightFrom([[-97.7600, 30.2600], [-97.75995, 30.2600]]);
  assert.ok(tiny.totalM < 10, `fixture should be a few metres, got ${tiny.totalM.toFixed(1)}`);
  assert.equal(tiny.durationS, 0.5, 'the floor applies');
  assert.ok(tiny.totalM / tiny.durationS < CRUISE_M_S.normal, 'and it flies SLOWER than asked, never faster');
  // Anything long enough to see keeps the contract exactly.
  const normal = flightFrom(TWO_TURN_ROUTE);
  assert.ok(Math.abs((normal.totalM / normal.durationS) - CRUISE_M_S.normal) < 1e-9);
});
