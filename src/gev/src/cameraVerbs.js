/**
 * Camera verbs — the "spy satellite simulator" feel
 * documented in `docs/CURRENT-STATE.md`.
 *
 * One motion at a time, driven per clock tick. `once` = bounded eased nudge;
 * `continuous` runs until move_camera{stop}, ANY manual camera input on the
 * canvas (pointerdown/wheel — the cancelFlight reflex), or a navigation tool
 * starts (the shared UI navigation policy releases this owner before the new
 * destination mutates the camera). fly_route is a
 * continuous motion in the same slot: a cinematic dolly along an existing
 * route annotation's street-following path.
 *
 * Orbit circles the current screen-center ground target holding range and
 * pitch while advancing heading (per-frame camera.lookAt; the lookAt
 * transform is cleared on every stop so manual control returns cleanly).
 */

import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';

/** °/s by speed word — orbit; pan uses fractions of view height/s. */
const ORBIT_DEG_S = { slow: 2, normal: 6, fast: 15 };
const TILT_DEG_S = { slow: 4, normal: 10, fast: 20 };
const PAN_VIEW_FRACTION_S = { slow: 0.08, normal: 0.2, fast: 0.45 };
/** MEAN ground speed by speed word. The trapezoid profile below eases in and
 *  out around this mean, so a route still takes totalM / ROUTE_M_S seconds. */
const ROUTE_M_S = { slow: 20, normal: 40, fast: 90 };
/** Bounded `once` nudges (spec: tune by feel in the field test). */
const ONCE = { orbitDeg: 30, tiltDeg: 15, rotateDeg: 15, panViewFraction: 0.25, durationS: 0.9 };
const PITCH_MIN = Cesium.Math.toRadians(-89);
const PITCH_MAX = Cesium.Math.toRadians(-5);

/* ── Route dolly: cinematic tuning ──────────────────────────────────────────
 * Every knob an maintainer may want to retune lives in this block. The shaping is
 * built from four independent layers, each of which flattens to nothing on its
 * own: a trapezoid speed profile, a banked-turn roll, altitude breathing, and
 * a gaze that leads the path. Under prefers-reduced-motion the last three are
 * zeroed and the dolly is a plain eased track along the route.
 * -------------------------------------------------------------------------- */
/** Mean AGL the dolly rides at — the altitude shaping oscillates AROUND this. */
const ROUTE_CAMERA_HEIGHT_M = 260;
/** Locked look-down angle. Decoupled from the lookahead distance so the framing
 *  no longer changes with the speed word (it used to fall out of the geometry:
 *  a 260 m eye aiming at a point 260 m ahead is a hard −45° at the pavement). */
const ROUTE_PITCH_DEG = -32;
/** Seconds of travel the gaze leads the camera by (≈260 m at normal — the
 *  shipped constant — but coherent at slow and fast too). */
const ROUTE_LOOKAHEAD_S = 6.5;
const ROUTE_LOOKAHEAD_MIN_M = 120;
const ROUTE_LOOKAHEAD_MAX_M = 600;
/** 1/s — exponential smoothing rate for the dolly's gaze direction. */
const ROUTE_DIR_SMOOTH_RATE = 1.6;
/** Seconds of ease-in (and again ease-out) at the ends of the flight. */
const ROUTE_RAMP_S = 2.4;
/** Ramps never eat more than this share of a SHORT route's runtime. */
const ROUTE_RAMP_MAX_FRACTION = 0.35;
/** This is a map, not a flight sim: the roll is a hint, never a barrel roll. */
const ROUTE_BANK_MAX_DEG = 10;
/** Seconds of path (centred on the camera) the turn is measured over. The
 *  measure is a triangular pulse peaking exactly at the corner, so the bank
 *  rolls in before the turn and rolls out after it. */
const ROUTE_BANK_WINDOW_S = 4;
/** Degrees of bank per °/s of planned turn. After the roll filters below, a 90°
 *  street corner settles near 7.5° and a hairpin saturates the cap, so the cap
 *  stays a limit rather than the everyday value. */
const ROUTE_BANK_PER_DEG_S = 0.44;
/** Two cascaded first-order filters — C¹ roll entry/exit, no snap at the edges
 *  of the turn pulse. */
const ROUTE_BANK_LEAD_RATE = 2.2;
const ROUTE_BANK_SETTLE_RATE = 1.6;
/** Zero-mean altitude "breathing" over long straights. */
const ROUTE_BREATH_M = 20;
const ROUTE_BREATH_WAVELENGTH_M = 2200;
/** Extra height at full bank — the lookahead rise into a turn. Sized by its
 *  RATE, not its size: the lift has to be delivered inside the few seconds the
 *  camera takes to roll in, so a bigger number reads as a lurch, not a swell. */
const ROUTE_TURN_LIFT_M = 26;
/** 1/s — how fast the ALTITUDE follows the roll. Deliberately slower than the
 *  roll itself: the wings roll through a corner in a few seconds, but the swell
 *  that lifts the eye over it wants to be a long, shallow arc. */
const ROUTE_LIFT_TRACK_RATE = 0.5;
/** 1/s — the altitude shaping is filtered on its way to the camera so rolling
 *  out of a turn sinks the eye gently instead of dropping it. */
const ROUTE_ALT_SMOOTH_RATE = 0.9;
/** Hard clearance above the sampled ground floor; the shaping can never dip
 *  the eye below this, whatever the tuning above says. */
const ROUTE_MIN_CLEARANCE_M = 90;
/** 1/s — how fast the SHAPING floor follows the sampled one, in both
 *  directions. The hard clearance clamp reads the raw sample, so this rate is
 *  a comfort setting, not a safety one. */
const ROUTE_FLOOR_FALL_RATE = 0.9;
/** Below this |cos| the two chords are antipodal and the cross product's sign
 *  is a floating-point coin toss — an exact U-turn must not flip the bank
 *  direction frame to frame, so the degenerate case is branched explicitly. */
const ANTIPODAL_EPS = 1e-6;
/** Metres of corridor warmed when a flight starts, and the rolling window
 *  warmed ahead of the camera afterwards. Cells are the house 0.001° (~111 m)
 *  coarse cells, deduped by the warm batch, which also skips already-warm ones
 *  and queues (never drops) contending callers. */
const ROUTE_WARM_START_M = 4000;
const ROUTE_WARM_AHEAD_M = 3000;
const ROUTE_WARM_MAX_CELLS = 96;
/** Seconds between rolling corridor warms during a flight. */
const ROUTE_WARM_INTERVAL_S = 2;
/** Metres of arc between corridor samples (~half a coarse cell, so no cell the
 *  route crosses for more than ~55 m of ground is skipped). */
const ROUTE_WARM_STEP_M = 55;
/** Ceiling on the conservative floor seed used while the corridor is COLD.
 *  Above this the camera's own altitude stops being a useful proxy for the
 *  ground under it (a globe-scale view would park the dolly in orbit). */
const ROUTE_UNKNOWN_FLOOR_CAP_M = 5000;
/** Corridor cells the floor acquisition looks at, and therefore the HARD cap
 *  on sampleHeight calls a whole route may make: the mesh probe is latched to
 *  fire once per flight, so this is a per-route budget, not a per-frame one. */
const ROUTE_MESH_PROBE_CELLS = 8;
/** Seconds the dolly ARMS — camera untouched — waiting for real floor data
 *  before it starts moving. The corridor warm is fire-and-forget, so without
 *  this the first frame RACES it and can render underground. Matches the house
 *  one-shot floor deadline (FLOOR_RESOLVE_DEADLINE_MS), and is the same
 *  arm-then-act shape a chained orbit uses while its flight settles. */
const ROUTE_ARM_S = 1.2;
/** m/s — cap on how fast the eye may DESCEND. Climbs are never limited (they
 *  are the safety direction). Ordinary terrain following runs a few m/s, so
 *  this only bites when a hold is released onto late-arriving floor data — most
 *  visibly when the mesh probe seeded the floor from a downtown ROOFTOP and the
 *  real DEM later corrects it ~90 m downward. Held at the same bound as the
 *  altitude shaping so that correction reads as one more swell rather than as a
 *  sink of its own. Lagging HIGH is the safe direction, so a genuinely steep
 *  downhill simply floats a little wider of the ground. */
const ROUTE_MAX_DESCENT_MPS = 10;

/* ── Pure cinematic helpers (unit-tested; no viewer, no module state) ────── */

/** Whether the operating system asked us to keep motion boring. */
export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Frame-rate independent first-order approach (exponential smoothing).
 * `1 - e^(-rate·dt)` rather than `rate·dt` so a dropped frame cannot overshoot.
 * @param {number} current Current value (NaN adopts the target).
 * @param {number} target Value to approach.
 * @param {number} ratePerS Approach rate, 1/s.
 * @param {number} dt Seconds elapsed.
 * @returns {number} The smoothed value.
 */
export function approachValue(current, target, ratePerS, dt) {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  const k = 1 - Math.exp(-Math.max(0, ratePerS) * Math.max(0, dt));
  return current + (target - current) * k;
}

/**
 * Share of the flight's runtime spent easing in (and again easing out).
 * @param {number} durationS Flight duration.
 * @returns {number} Ramp fraction in [0, ROUTE_RAMP_MAX_FRACTION].
 */
export function routeRampFraction(durationS) {
  if (!(durationS > 0)) return 0;
  return Math.min(ROUTE_RAMP_MAX_FRACTION, ROUTE_RAMP_S / durationS);
}

/**
 * Trapezoid speed profile — smoothstep up, cruise, smoothstep down.
 *
 * Distance is the CLOSED-FORM integral of the speed curve, so position is
 * exact (no per-frame accumulation drift) and speed is continuous everywhere:
 * zero at both ends, and C¹ across the ramp/plateau joins because smoothstep
 * has zero slope at 0 and 1. Waypoints are invisible to it — the profile is a
 * function of arc length only, so nothing steps as a segment changes.
 * @param {number} u Normalized time, 0..1.
 * @param {number} r Ramp fraction from routeRampFraction().
 * @returns {{distance: number, speed: number}} Arc fraction 0..1, and speed as
 * a multiple of the plateau (cruise) speed.
 */
export function routeSpeedProfile(u, r) {
  const t = Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0));
  if (!(r > 0)) return { distance: t, speed: 1 };
  const area = 1 - r; // ∫₀¹ v du — both ramps together contribute r
  const rampArea = (p) => r * ((p * p * p) - ((p * p * p * p) / 2));
  const smoothstep = (p) => p * p * (3 - (2 * p));
  if (t <= r) {
    const p = t / r;
    return { distance: rampArea(p) / area, speed: smoothstep(p) };
  }
  if (t >= 1 - r) {
    const p = (1 - t) / r;
    return { distance: (area - rampArea(p)) / area, speed: smoothstep(p) };
  }
  return { distance: ((r / 2) + (t - r)) / area, speed: 1 };
}

/**
 * Bank angle for a planned turn rate — proportional, capped, honest about zero.
 * @param {number} turnRateDegS Planned turn rate, °/s (+ = turning right).
 * @param {boolean} [reducedMotion] Flatten the roll entirely.
 * @returns {number} Degrees of roll, + = right wing down.
 */
export function routeBankTargetDeg(turnRateDegS, reducedMotion = false) {
  if (reducedMotion || !Number.isFinite(turnRateDegS)) return 0;
  const raw = turnRateDegS * ROUTE_BANK_PER_DEG_S;
  return Math.max(-ROUTE_BANK_MAX_DEG, Math.min(ROUTE_BANK_MAX_DEG, raw));
}

/**
 * Altitude offset around the route's mean AGL: a zero-mean breath over long
 * straights, plus a small rise into turns for lookahead. Breathing fades out
 * as the bank comes in so the two never fight.
 * @param {number} arcM Distance travelled along the route.
 * @param {number} bankFraction Current bank as a fraction of the cap, −1..1.
 * @param {boolean} [reducedMotion] Flatten to a constant altitude.
 * @returns {number} Metres to add to the mean AGL.
 */
export function routeAltitudeOffsetM(arcM, bankFraction, reducedMotion = false) {
  if (reducedMotion) return 0;
  const bank = Number.isFinite(bankFraction) ? Math.max(-1, Math.min(1, bankFraction)) : 0;
  const straight = 1 - Math.abs(bank);
  const s = Number.isFinite(arcM) ? arcM : 0;
  const breath = Math.sin((2 * Math.PI * s) / ROUTE_BREATH_WAVELENGTH_M) * ROUTE_BREATH_M * straight;
  return breath + (Math.abs(bank) * ROUTE_TURN_LIFT_M);
}

/**
 * Eye height above the ellipsoid. The last word on terrain: whatever the
 * shaping asks for, the eye stays ROUTE_MIN_CLEARANCE_M above the floor.
 * @param {number} floorM Ground floor height at the camera.
 * @param {number} offsetM Altitude shaping offset.
 * @returns {number} Height above the ellipsoid.
 */
export function routeEyeHeightM(floorM, offsetM) {
  const base = Number.isFinite(floorM) ? floorM : 0;
  const shaped = base + ROUTE_CAMERA_HEIGHT_M + (Number.isFinite(offsetM) ? offsetM : 0);
  return Math.max(base + ROUTE_MIN_CLEARANCE_M, shaped);
}

/**
 * Track the ground floor SMOOTHLY, in both directions.
 *
 * The floor is a staircase: cells are 0.001° (~111 m) and the dolly reads the
 * max of the cell it is over and one ahead, so crossing a boundary can step
 * several metres in one frame. Adopting a rise instantly — which terrain safety
 * seems to argue for — turns every one of those steps into an altitude pop
 * (measured: 21.7 m/s of vertical rate over otherwise flat downtown). Safety
 * does not actually need it: the hard clamp in advanceRouteFlight is applied
 * against the RAW sample, so the smoothed value only ever shapes the ride.
 * @param {number} previousM Held floor.
 * @param {number} sampledM Newly sampled floor (NaN keeps the held value).
 * @param {number} dt Seconds elapsed.
 * @returns {number} The floor to shape the flight over this frame.
 */
export function routeFloorHoldM(previousM, sampledM, dt) {
  if (!Number.isFinite(sampledM)) return previousM;
  if (!Number.isFinite(previousM)) return sampledM;
  return approachValue(previousM, sampledM, ROUTE_FLOOR_FALL_RATE, dt);
}

/** Read-only view of the tuning, for tests and harnesses. */
export const ROUTE_CINEMA = Object.freeze({
  meanHeightM: ROUTE_CAMERA_HEIGHT_M,
  pitchDeg: ROUTE_PITCH_DEG,
  maxBankDeg: ROUTE_BANK_MAX_DEG,
  minClearanceM: ROUTE_MIN_CLEARANCE_M,
  breathM: ROUTE_BREATH_M,
  turnLiftM: ROUTE_TURN_LIFT_M,
  rampS: ROUTE_RAMP_S,
});

/* ── Route dolly geometry ────────────────────────────────────────────────── */

const _arcA = new Cesium.Cartesian3();
const _arcB = new Cesium.Cartesian3();
const _chordVertical = new Cesium.Cartesian3();
const _turnCross = new Cesium.Cartesian3();
const _framePos = new Cesium.Cartesian3();
const _frameAheadPos = new Cesium.Cartesian3();
const _frameUp = new Cesium.Cartesian3();
const _frameIn = new Cesium.Cartesian3();
const _frameOut = new Cesium.Cartesian3();
const _frameGaze = new Cesium.Cartesian3();
const _frameRight = new Cesium.Cartesian3();
const _frameLevelUp = new Cesium.Cartesian3();
const _frameDir = new Cesium.Cartesian3();
const _frameEye = new Cesium.Cartesian3();
const _frameBankedUp = new Cesium.Cartesian3();
const _frameCarto = new Cesium.Cartographic();
const _frameAheadCarto = new Cesium.Cartographic();
const _bankQuat = new Cesium.Quaternion();
const _bankMatrix = new Cesium.Matrix3();
const _headingQuat = new Cesium.Quaternion();
const _headingMatrix = new Cesium.Matrix3();
const _warmPos = new Cesium.Cartesian3();
const _warmCarto = new Cesium.Cartographic();
const _probeCarto = new Cesium.Cartographic();

/** Point at arc length `s` along the polyline (binary search — queries jump
 *  backwards for the inbound chord, so a forward cursor would not do). */
function arcPoint(state, s, result) {
  const { pts, cumM } = state;
  const clamped = Math.min(state.totalM, Math.max(0, s));
  let lo = 0;
  let hi = cumM.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumM[mid] <= clamped) lo = mid; else hi = mid - 1;
  }
  const segLen = cumM[lo + 1] - cumM[lo];
  const t = segLen > 1e-6 ? Math.min(1, Math.max(0, (clamped - cumM[lo]) / segLen)) : 0;
  return Cesium.Cartesian3.lerp(pts[lo], pts[lo + 1], t, result);
}

/** Unit horizontal direction from arc `sA` to arc `sB`, or null when degenerate. */
function horizontalChord(state, sA, sB, up, result) {
  const a = arcPoint(state, sA, _arcA);
  const b = arcPoint(state, sB, _arcB);
  Cesium.Cartesian3.subtract(b, a, result);
  const vertical = Cesium.Cartesian3.multiplyByScalar(
    up, Cesium.Cartesian3.dot(result, up), _chordVertical,
  );
  Cesium.Cartesian3.subtract(result, vertical, result);
  const len = Cesium.Cartesian3.magnitude(result);
  if (!(len > 1e-3)) return null;
  return Cesium.Cartesian3.divideByScalar(result, len, result);
}

/**
 * Signed angle from `a` to `b` about `up`; positive = turning RIGHT.
 *
 * At exactly 180° the cross product is zero and its sign is decided by
 * floating-point signed zeros, so an out-and-back route would flip the bank
 * direction frame to frame. A U-turn is resolved as a RIGHT turn, always —
 * arbitrary, but deterministic, which is the property that matters.
 * @param {Cesium.Cartesian3} a Unit horizontal direction turned FROM.
 * @param {Cesium.Cartesian3} b Unit horizontal direction turned TO.
 * @param {Cesium.Cartesian3} up Local up, the axis the turn is measured about.
 * @returns {number} Radians, + = right.
 */
export function signedTurnRad(a, b, up) {
  const cross = Cesium.Cartesian3.cross(a, b, _turnCross);
  const sinLeft = Cesium.Cartesian3.dot(cross, up);
  const cosTurn = Cesium.Cartesian3.dot(a, b);
  if (cosTurn <= -1 + ANTIPODAL_EPS && Math.abs(sinLeft) < ANTIPODAL_EPS) return Math.PI;
  return -Math.atan2(sinLeft, cosTurn);
}

/**
 * Coarse floor cells along a stretch of the route, in travel order.
 * Deduped to the house 0.001° grid and capped, so one flight can never issue an
 * unbounded warm batch.
 * @param {Object} state Route flight state (needs pts/cumM/totalM).
 * @param {number} fromM Arc length to start collecting at.
 * @param {number} spanM Metres of arc to cover.
 * @param {number} [maxCells] Cap on the returned cells.
 * @returns {Array<{lat: number, lon: number}>} Cells to warm.
 */
export function routeCorridorCells(state, fromM, spanM, maxCells = ROUTE_WARM_MAX_CELLS) {
  const out = [];
  if (!(state?.totalM > 0) || !(spanM > 0) || !(maxCells > 0)) return out;
  const start = Math.max(0, Math.min(state.totalM, fromM));
  const end = Math.max(0, Math.min(state.totalM, fromM + spanM));
  const seen = new Set();
  for (let s = start; s <= end + 1e-6 && out.length < maxCells; s += ROUTE_WARM_STEP_M) {
    const point = arcPoint(state, s, _warmPos);
    const carto = Cesium.Cartographic.fromCartesian(point, Cesium.Ellipsoid.WGS84, _warmCarto);
    const lat = Number(Cesium.Math.toDegrees(carto.latitude).toFixed(3));
    const lon = Number(Cesium.Math.toDegrees(carto.longitude).toFixed(3));
    const key = `${lat},${lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lon });
  }
  return out;
}

/** Fire-and-forget warm of a corridor stretch; never throws into the caller. */
function warmRouteCorridor(state, fromM, spanM) {
  if (typeof state?.warmFn !== 'function') return 0;
  const cells = routeCorridorCells(state, fromM, spanM);
  if (!cells.length) return 0;
  try {
    state.warmFn(cells);
  } catch {
    return 0; // best effort — a cold cell holds the last known floor
  }
  state.warmedCells += cells.length;
  return cells.length;
}

/**
 * The floor to hold while the corridor is still cold.
 *
 * Cold is missing data, not flat ground, and the route's own vertices carry
 * height 0 — so the previous fallback flew a Rocky Mountain route at 260 m
 * above the ELLIPSOID. The camera's current position is, by construction,
 * above the ground the user is looking at, so its height minus the cruise AGL
 * is a floor we can defend. It is capped, because at globe scale the camera's
 * altitude stops saying anything about the ground under it.
 * @param {number} pathHeightM The route vertices' own height.
 * @param {number} cameraHeightM Camera height at flight start, if known.
 * @returns {number} A floor to hold until real terrain arrives.
 */
export function routeColdSeedFloorM(pathHeightM, cameraHeightM) {
  const base = Number.isFinite(pathHeightM) ? pathHeightM : 0;
  if (!Number.isFinite(cameraHeightM)) return base;
  const implied = cameraHeightM - ROUTE_CAMERA_HEIGHT_M;
  return Math.max(base, Math.min(base + ROUTE_UNKNOWN_FLOOR_CAP_M, implied));
}

/**
 * Adopt the corridor's floor, from the cache or — failing that — from the
 * rendered mesh directly.
 *
 * Runs at construction and again on every ARMING frame, because the corridor
 * warm is fire-and-forget and this is how the dolly notices it landed. The
 * per-frame part is cache READS (a Map lookup per cell); the mesh probe is
 * latched to fire at most ONCE per flight, so a whole route costs at most
 * ROUTE_MESH_PROBE_CELLS sampleHeight calls however long it arms.
 *
 * A partially warm corridor is NOT resolved. One cached cell says nothing
 * about the ground under the other seven, and treating it as an answer let the
 * dolly descend to 460 m over a 1,600 m surface. Every cell must be accounted
 * for — by the cache, or by a probe that actually reached it.
 *
 * The probe is the answer to "what if the DEM never arrives at all", and it
 * closes the hole in the case where the hole is observable: clipping requires
 * terrain to BE rendered, and what is rendered is what sampleHeight reads. It
 * reads the rendered surface at the CURRENT level of detail — rooftops and
 * primitives included — which is a better estimate than nothing but is not a
 * guaranteed upper bound. The per-frame raw-sample clamp remains the backstop.
 * @param {Object} state Route flight state.
 * @param {boolean} takeWhole Adopt the value outright (pre-departure) rather
 * than easing onto it — a mid-flight arrival must never snap the eye.
 * @returns {boolean} Whether the corridor's floor is now RESOLVED.
 */
function acquireCorridorFloor(state, takeWhole) {
  const cells = routeCorridorCells(state, state.traveled, ROUTE_WARM_START_M, ROUTE_MESH_PROBE_CELLS);
  if (!cells.length) return false;
  const known = [];
  const cold = [];
  if (typeof state.floorFn === 'function') {
    for (const cell of cells) {
      let floor = Number.NaN;
      try {
        floor = state.floorFn(cell.lat, cell.lon);
      } catch { /* a hostile read is the same as a cold one */ }
      if (Number.isFinite(floor)) known.push(floor); else cold.push(cell);
    }
  } else {
    cold.push(...cells);
  }

  // The probe fires once, for exactly the cells the cache could not answer.
  if (cold.length && !state.meshProbeSpent && typeof state.probeFn === 'function') {
    state.meshProbeSpent = true; // latched whatever it returns — one per flight
    try {
      const probe = state.probeFn(cold) || {};
      if (Number.isFinite(probe.heightM)) {
        state.meshProbeFloorM = probe.heightM;
        state.floorFromMeshProbe = true;
        // Only a probe that reached EVERY cold cell resolves the corridor.
        state.meshProbeCoveredCold = probe.sampled >= cold.length;
      }
    } catch { /* tiles not streamed, or a scene mid-teardown */ }
  }
  if (Number.isFinite(state.meshProbeFloorM)) known.push(state.meshProbeFloorM);
  if (!known.length) return false;

  const floor = Math.max(...known);
  // A partial answer still RAISES the held floor — knowing something is better
  // than the seed — but it does not resolve the corridor, so the safe hold and
  // the arm stay in force.
  state.floorM = takeWhole || !Number.isFinite(state.floorM)
    ? floor
    : Math.max(state.floorM, floor);
  if (cold.length && !state.meshProbeCoveredCold) return false;
  state.floorKnown = true;
  return true;
}

/**
 * Highest rendered surface across a handful of corridor cells, with the number
 * of cells that actually answered — a cell whose tiles are not streamed yet
 * contributes nothing, and the caller must not mistake silence for flat ground.
 * @param {Cesium.Scene|undefined} scene The live scene.
 * @param {Array<{lat: number, lon: number}>} cells Cells to probe.
 * @returns {{heightM: number, sampled: number, requested: number}} The reading.
 */
export function probeMeshFloorM(scene, cells) {
  const requested = Array.isArray(cells) ? cells.length : 0;
  const empty = { heightM: Number.NaN, sampled: 0, requested };
  if (!scene || typeof scene.sampleHeight !== 'function' || !requested) return empty;
  let heightM = Number.NaN;
  let sampled = 0;
  for (const cell of cells) {
    try {
      const carto = Cesium.Cartographic.fromDegrees(cell.lon, cell.lat, 0, _probeCarto);
      const height = scene.sampleHeight(carto);
      if (!Number.isFinite(height)) continue;
      sampled += 1;
      heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
    } catch { /* tiles not ready for this cell */ }
  }
  return { heightM, sampled, requested };
}

/**
 * Build the state for one cinematic route flight.
 * @param {Object} options
 * @param {Cesium.Cartesian3[]} options.pts Route vertices.
 * @param {number[]} options.cumM Cumulative arc length per vertex.
 * @param {string} [options.speed] slow | normal | fast.
 * @param {Function|null} [options.floorFn] (latDeg, lonDeg) => floor metres.
 * @param {Function|null} [options.warmFn] (cells) => void — corridor floor warm.
 * @param {Function|null} [options.probeFn] (cells) => {heightM, sampled} —
 * synchronous rendered-mesh probe, fired at most ONCE per flight and only for
 * the cells the cached floor could not answer.
 * @param {number} [options.cameraHeightM] Camera height at start, for the cold seed.
 * @param {boolean} [options.reducedMotion] Flatten bank + altitude shaping.
 * @returns {Object} Motion state for advanceRouteFlight().
 */
export function createRouteFlight({
  pts, cumM, speed = 'normal', floorFn = null, warmFn = null, probeFn = null,
  cameraHeightM = Number.NaN, reducedMotion = false,
}) {
  const totalM = cumM[cumM.length - 1];
  const cruiseMps = ROUTE_M_S[speed] || ROUTE_M_S.normal;
  // The 0.5 s floor keeps a degenerate route from being an instant teleport (it
  // also divides the profile). It is the one case where the speed word is not
  // the mean: routes under 10 m (slow) / 20 m (normal) / 45 m (fast) fly slower
  // than asked. Those are shorter than the camera is tall — nothing to see.
  const durationS = Math.max(0.5, totalM / cruiseMps);
  const pathHeightM = Cesium.Cartographic.fromCartesian(
    pts[0], Cesium.Ellipsoid.WGS84, _warmCarto,
  ).height;
  const state = {
    kind: 'route',
    mode: 'continuous',
    direction: 'forward',
    speed,
    pts,
    cumM,
    totalM,
    durationS,
    ramp: routeRampFraction(durationS),
    u: 0,
    traveled: 0,
    floorFn,
    warmFn,
    probeFn,
    reducedMotion,
    floorM: Number.NaN,
    floorKnown: false,
    coldSeedFloorM: routeColdSeedFloorM(pathHeightM, cameraHeightM),
    // The one altitude we can defend without terrain data: the camera is
    // already there, and the user is already looking at the world from it. It
    // is a NON-DESCENT guarantee, not a clearance guarantee — nothing can
    // promise clearance over ground that was never measured.
    safeHoldHeightM: Number.isFinite(cameraHeightM) ? cameraHeightM : Number.NaN,
    coldFrames: 0,
    floorFromMeshProbe: false,
    meshProbeSpent: false,
    meshProbeFloorM: Number.NaN,
    meshProbeCoveredCold: false,
    armS: 0,
    armed: false,
    departed: false,
    appliedHeightM: Number.NaN,
    warmedCells: 0,
    warmDueS: ROUTE_WARM_INTERVAL_S,
    offsetM: Number.NaN,
    bankLeadDeg: 0,
    bankDeg: 0,
    appliedBankDeg: 0,
    liftBankDeg: 0,
    headingDir: null,
    groundSpeedMps: 0,
  };
  // Warm the head of the corridor before the first frame renders, then check
  // whether anything is warm ALREADY (contact traffic, or a second run over the
  // same route) — that flight needs no arming and no hold at all.
  warmRouteCorridor(state, 0, ROUTE_WARM_START_M);
  acquireCorridorFloor(state, true);
  return state;
}

/**
 * Advance one dolly frame. Returns the camera pose to apply; the caller owns
 * the viewer (so this stays testable without one).
 * @param {Object} state From createRouteFlight().
 * @param {number} dt Seconds elapsed.
 * @returns {{finished: boolean, eye: Cesium.Cartesian3, direction: Cesium.Cartesian3,
 *  up: Cesium.Cartesian3, bankDeg: number, heightM: number, aglM: number,
 *  groundSpeedMps: number, progress: number}} The frame.
 */
export function advanceRouteFlight(state, dt) {
  const step = Math.min(0.25, Math.max(0, Number.isFinite(dt) ? dt : 0));

  // ARMING. The corridor warm is fire-and-forget, so the alternative to waiting
  // is racing it — and losing that race means rendering the first frames at an
  // altitude derived from nothing. While armed the camera is not touched at
  // all: no teleport onto the route, no descent. The wait is covered by the
  // model speaking its confirmation, and a warm cache skips it entirely.
  const canAnswer = typeof state.floorFn === 'function' || typeof state.probeFn === 'function';
  if (canAnswer && !state.floorKnown && !state.departed && state.armS < ROUTE_ARM_S) {
    state.armS += step;
    if (!acquireCorridorFloor(state, true)) {
      return { arming: true, finished: false, progress: 0, bankDeg: 0 };
    }
  }
  state.departed = true;

  state.u = Math.min(1, (state.u || 0) + (step / state.durationS));
  const profile = routeSpeedProfile(state.u, state.ramp);
  const traveled = state.totalM * profile.distance;
  state.traveled = traveled;
  const cruiseMps = state.totalM / (state.durationS * (1 - state.ramp));
  state.groundSpeedMps = cruiseMps * profile.speed;

  const pos = arcPoint(state, traveled, _framePos);
  const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _frameCarto);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(carto, _frameUp);

  // Planned turn: compare where we came from with where we are going, over a
  // window centred on the camera. Peaks AT the corner, tapers either side.
  const halfWindowM = Math.max(20, (ROUTE_BANK_WINDOW_S * cruiseMps) / 2);
  const inbound = horizontalChord(state, traveled - halfWindowM, traveled, up, _frameIn);
  const outbound = horizontalChord(state, traveled, traveled + halfWindowM, up, _frameOut);
  const turnRateDegS = (inbound && outbound)
    ? Cesium.Math.toDegrees(signedTurnRad(inbound, outbound, up)) / ROUTE_BANK_WINDOW_S
    : 0;
  const bankTarget = routeBankTargetDeg(turnRateDegS, state.reducedMotion);
  state.bankLeadDeg = approachValue(state.bankLeadDeg, bankTarget, ROUTE_BANK_LEAD_RATE, step);
  state.bankDeg = approachValue(state.bankDeg, state.bankLeadDeg, ROUTE_BANK_SETTLE_RATE, step);
  // Wings level for takeoff and landing. The speed profile is already a
  // smoothstep envelope that is 1 across the cruise and exactly 0 at both ends,
  // so reusing it unwinds the roll as the dolly slows — and guarantees the LAST
  // applied frame is level, with no snap to get there.
  const appliedBankDeg = state.bankDeg * profile.speed;

  // Gaze leads along the arc, then eases toward the new heading so corners
  // swing like a crane shot instead of a whip pan.
  const lookaheadM = Math.min(
    ROUTE_LOOKAHEAD_MAX_M,
    Math.max(ROUTE_LOOKAHEAD_MIN_M, ROUTE_LOOKAHEAD_S * cruiseMps),
  );
  const gaze = horizontalChord(state, traveled, traveled + lookaheadM, up, _frameGaze)
    || outbound || inbound;
  if (gaze && !state.headingDir) state.headingDir = Cesium.Cartesian3.clone(gaze);
  else if (gaze) {
    // Rotate the heading TOWARD the gaze about the local up, rather than
    // lerping the two vectors. A Cartesian lerp cannot cross an antipodal pair
    // (a U-turn): below t=0.5 the blend still points backwards, and no
    // per-frame t ever reaches 0.5, so the camera stayed reversed for the whole
    // return leg. An angle always crosses.
    const k = 1 - Math.exp(-ROUTE_DIR_SMOOTH_RATE * step);
    const turnToGaze = signedTurnRad(state.headingDir, gaze, up);
    // signedTurnRad is + for a RIGHT turn; a positive rotation about up is a
    // LEFT turn, so the step is negated.
    const rotation = Cesium.Matrix3.fromQuaternion(
      Cesium.Quaternion.fromAxisAngle(up, -turnToGaze * k, _headingQuat), _headingMatrix,
    );
    const turned = Cesium.Matrix3.multiplyByVector(rotation, state.headingDir, _frameDir);
    const vertical = Cesium.Cartesian3.multiplyByScalar(
      up, Cesium.Cartesian3.dot(turned, up), _chordVertical,
    );
    Cesium.Cartesian3.subtract(turned, vertical, turned);
    if (Cesium.Cartesian3.magnitude(turned) > 1e-6) {
      Cesium.Cartesian3.normalize(turned, state.headingDir);
    }
  }
  // A path with no horizontal extent (identical lat/lon, differing heights)
  // has no azimuth to fly: point east so the frame stays orthonormal.
  if (!state.headingDir) {
    const east = Cesium.Cartesian3.fromElements(-pos.y, pos.x, 0, _frameGaze);
    state.headingDir = Cesium.Cartesian3.magnitude(east) > 1e-6
      ? Cesium.Cartesian3.normalize(east, new Cesium.Cartesian3())
      : Cesium.Cartesian3.fromElements(1, 0, 0, new Cesium.Cartesian3());
  }
  const heading = state.headingDir;

  // Locked pitch: heading gives the azimuth, the pitch never wanders.
  const pitch = Cesium.Math.toRadians(ROUTE_PITCH_DEG);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(heading, Math.cos(pitch), _frameDir),
      Cesium.Cartesian3.multiplyByScalar(up, Math.sin(pitch), _frameLevelUp),
      _frameDir,
    ),
    _frameDir,
  );
  // Orthonormal camera frame, then roll it about its own forward axis: a
  // positive rotation drops the right wing, which is what a right turn wants.
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, up, _frameRight), _frameRight,
  );
  const levelUp = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, _frameLevelUp), _frameLevelUp,
  );
  const bankRad = Cesium.Math.toRadians(appliedBankDeg);
  let bankedUp = levelUp;
  if (Math.abs(bankRad) > 1e-6) {
    const quat = Cesium.Quaternion.fromAxisAngle(direction, bankRad, _bankQuat);
    const rotation = Cesium.Matrix3.fromQuaternion(quat, _bankMatrix);
    bankedUp = Cesium.Matrix3.multiplyByVector(rotation, levelUp, _frameBankedUp);
  }

  // Keep the corridor ahead of the camera warm. The batch dedupes to coarse
  // cells, skips warm ones and queues contenders, so a repeat costs nothing.
  state.warmDueS -= step;
  if (state.warmDueS <= 0) {
    state.warmDueS = ROUTE_WARM_INTERVAL_S;
    warmRouteCorridor(state, traveled, ROUTE_WARM_AHEAD_M);
  }

  // Ground floor: the max of here and just ahead, so a rise is cleared BEFORE
  // the camera reaches it. Both are cached reads — nothing samples the mesh.
  let sampledFloor = Number.NaN;
  if (typeof state.floorFn === 'function') {
    const aheadPos = arcPoint(state, traveled + (lookaheadM / 2), _frameAheadPos);
    const aheadCarto = Cesium.Cartographic.fromCartesian(
      aheadPos, Cesium.Ellipsoid.WGS84, _frameAheadCarto,
    );
    try {
      const here = state.floorFn(
        Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude),
      );
      const ahead = state.floorFn(
        Cesium.Math.toDegrees(aheadCarto.latitude), Cesium.Math.toDegrees(aheadCarto.longitude),
      );
      const warm = [here, ahead].filter((value) => Number.isFinite(value));
      if (warm.length) sampledFloor = Math.max(...warm);
    } catch {
      sampledFloor = Number.NaN;
    }
  }
  if (!Number.isFinite(sampledFloor)) {
    // NEVER descend blind. A cold cell is missing data, not flat ground — the
    // route's own vertices carry height 0, so trusting them put the eye 1.3 km
    // UNDER Albuquerque. Hold the last floor we actually knew; before we have
    // ever known one, hold the conservative seed captured at flight start.
    state.floorM = Number.isFinite(state.floorM) ? state.floorM : state.coldSeedFloorM;
    state.coldFrames += 1;
  } else if (!state.floorKnown) {
    // Data arrived AFTER the arm gave up. Easing is the right move now: the
    // camera is already flying, so taking the gap between the safety hold and
    // the ground in one frame would snap. (Pre-departure acquisition takes it
    // whole — see acquireCorridorFloor — because nothing is moving yet.)
    state.floorM = routeFloorHoldM(state.floorM, sampledFloor, step);
    state.floorKnown = true;
  } else {
    state.floorM = routeFloorHoldM(state.floorM, sampledFloor, step);
  }

  state.liftBankDeg = approachValue(state.liftBankDeg, appliedBankDeg, ROUTE_LIFT_TRACK_RATE, step);
  const bankFraction = state.liftBankDeg / ROUTE_BANK_MAX_DEG;
  state.offsetM = approachValue(
    state.offsetM,
    routeAltitudeOffsetM(traveled, bankFraction, state.reducedMotion),
    ROUTE_ALT_SMOOTH_RATE,
    step,
  );
  // Two floors, two jobs. The SMOOTHED floor shapes the ride, so a cell
  // boundary does not pop the eye. The RAW sample owns the safety clamp, so a
  // real rise is cleared on the frame it is seen, smoothing or not.
  let heightM = Math.max(
    routeEyeHeightM(state.floorM, state.offsetM),
    (Number.isFinite(sampledFloor) ? sampledFloor : state.floorM) + ROUTE_MIN_CLEARANCE_M,
  );
  // Still no terrain data (the arm timed out, or the warm never landed at all):
  // hold the launch altitude for as long as that lasts. It is not a clearance
  // guarantee — nothing can promise clearance over ground that was never
  // measured — but the dolly will not take the camera DOWN into the unknown.
  if (!state.floorKnown && Number.isFinite(state.safeHoldHeightM)) {
    heightM = Math.max(heightM, state.safeHoldHeightM);
  }
  // Releasing that hold onto late data is a controlled descent, never a drop.
  if (Number.isFinite(state.appliedHeightM)) {
    heightM = Math.max(heightM, state.appliedHeightM - (ROUTE_MAX_DESCENT_MPS * step));
  }
  state.appliedHeightM = heightM;
  const eye = Cesium.Cartesian3.fromRadians(
    carto.longitude, carto.latitude, heightM, Cesium.Ellipsoid.WGS84, _frameEye,
  );

  state.appliedBankDeg = appliedBankDeg;
  return {
    finished: state.u >= 1,
    eye,
    direction,
    up: bankedUp,
    bankDeg: appliedBankDeg,
    heightM,
    aglM: heightM - state.floorM,
    groundSpeedMps: state.groundSpeedMps,
    progress: state.u,
  };
}

let _viewer = null;
let _getTarget = null;
let _active = null; // { kind, motion, direction, speed, mode, ...state }
let _tickRemover = null;
let _inputRemovers = [];

function clearLookAt() {
  try { _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* teardown race */ }
}

/**
 * Put the horizon back.
 *
 * The route dolly is the only motion that rolls the camera, and Cesium keeps
 * whatever world-space up vector it was last handed — so releasing a flight
 * mid-bank leaves the user holding a tilted horizon until some later motion
 * happens to level it. Heading, pitch and position are preserved; only the
 * roll is taken out.
 * @returns {boolean} Whether a roll was actually removed.
 */
function levelCameraRoll() {
  try {
    const cam = _viewer?.camera;
    if (!cam || typeof cam.setView !== 'function') return false;
    const roll = Cesium.Math.negativePiToPi(cam.roll || 0);
    if (Math.abs(roll) < 1e-5) return false;
    cam.setView({ orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 } });
    return true;
  } catch {
    return false; // teardown race
  }
}

/** Stop any active motion. Returns whether one was running. */
export function interruptCameraMotion(reason = 'interrupt') {
  const wasActive = Boolean(_active);
  // While an entity is TRACKED, the follow camera owns the reference frame —
  // resetting the lookAt transform here flings the camera into space (field
  // finding). Leave the transform to the tracker; it re-asserts every frame.
  const tracking = Boolean(_viewer?.trackedEntity);
  const wasRoute = wasActive && _active.kind === 'route';
  if (wasActive && !tracking && (_active.kind === 'orbit' || _active.kind === 'route')) clearLookAt();
  // Instant, not eased: the user grabbed the camera, or the flight is over.
  // Either way the next thing they hold must be a level horizon.
  const leveled = wasRoute && !tracking ? levelCameraRoll() : false;
  _active = null;
  releaseContinuousRender('camera-verb');
  return { wasActive, reason, leveled };
}

/** Diagnostics / harness hook. */
export function getActiveCameraMotion() {
  if (!_active) return null;
  const info = { kind: _active.kind, mode: _active.mode, speed: _active.speed };
  if (_active.kind === 'route') {
    info.progress = _active.u;
    info.bankDeg = _active.bankDeg;
    info.groundSpeedMps = _active.groundSpeedMps;
    info.traveledM = _active.traveled;
    info.totalM = _active.totalM;
    info.reducedMotion = _active.reducedMotion;
    info.arming = !_active.departed;
    info.floorKnown = _active.floorKnown;
    info.floorFromMeshProbe = _active.floorFromMeshProbe;
    info.meshProbeSpent = _active.meshProbeSpent;
  }
  return info;
}

function onTick() {
  if (!_active || !_viewer) return;
  // Wall-clock dt: clock.currentTime FREEZES when the app clock isn't
  // animating, which starved motion to the 1 ms floor (harness catch).
  const nowMs = performance.now();
  const dt = Math.min(0.25, Math.max(0.001, (nowMs - (_active.lastMs ?? nowMs)) / 1000));
  _active.lastMs = nowMs;
  const cam = _viewer.camera;
  const m = _active;

  // `once` motions ease out and self-stop on budget exhaustion.
  let scale = 1;
  if (m.mode === 'once') {
    m.elapsed = (m.elapsed || 0) + dt;
    const t = Math.min(1, m.elapsed / ONCE.durationS);
    scale = 1 - (1 - t) * (1 - t); // ease-out progress share
    if (t >= 1) { interruptCameraMotion('once-complete'); }
  }

  try {
    if (m.kind === 'orbit' && m.pending) {
      // Armed but target-less (started mid-flight, e.g. "fly to X and orbit
      // it"): keep trying for a ground target until the camera settles.
      m.pendingS = (m.pendingS || 0) + dt;
      if (m.pendingS > 30) { interruptCameraMotion('orbit-arm-timeout'); return; }
      // pickEllipsoid hits the globe from ANY altitude — target existence
      // alone is not arrival. Camera flights are scene tweens, and multi-stage
      // flights have GAPS between tweens: require the tween queue quiet for a
      // continuous 0.8 s before capturing the orbit framing at the REAL
      // destination (field finding: Eiffel chain orbited from mid-flight).
      if (_viewer.scene.tweens.length > 0) { m.settledS = 0; return; }
      m.settledS = (m.settledS || 0) + dt;
      if (m.settledS < 0.8) return;
      const target = _getTarget?.(_viewer);
      if (!target) return;
      const cam2 = _viewer.camera;
      const range = Cesium.Cartesian3.distance(cam2.positionWC, target);
      const carto2 = Cesium.Cartographic.fromCartesian(cam2.positionWC);
      const tCarto2 = Cesium.Cartographic.fromCartesian(target);
      const dh2 = carto2.height - tCarto2.height;
      m.target = target;
      m.hpr = new Cesium.HeadingPitchRange(cam2.heading, -Math.asin(Math.min(1, Math.max(-1, dh2 / Math.max(1, range)))), range);
      m.hprStartHeading = cam2.heading;
      m.pending = false;
      m.elapsed = 0; // once-mode budget starts when the orbit actually begins
      return;
    }
    if (m.kind === 'orbit') {
      const rate = Cesium.Math.toRadians(ORBIT_DEG_S[m.speed]) * (m.direction === 'left' ? -1 : 1);
      if (m.mode === 'once') {
        const total = Cesium.Math.toRadians(ONCE.orbitDeg) * (m.direction === 'left' ? -1 : 1);
        m.hpr.heading = m.hprStartHeading + total * scale;
      } else {
        m.hpr.heading += rate * dt;
      }
      cam.lookAt(m.target, m.hpr);
    } else if (m.kind === 'pan') {
      const heightM = Math.max(50, cam.positionCartographic.height);
      const step = (m.mode === 'once'
        ? (heightM * ONCE.panViewFraction * (scale - (m.lastScale || 0)))
        : heightM * PAN_VIEW_FRACTION_S[m.speed] * dt);
      m.lastScale = scale;
      if (m.direction === 'left') cam.moveLeft(step);
      else if (m.direction === 'right') cam.moveRight(step);
      else if (m.direction === 'up') cam.moveUp(step);
      else cam.moveDown(step);
    } else if (m.kind === 'tilt' || m.kind === 'rotate') {
      const degS = TILT_DEG_S[m.speed];
      const stepRad = (m.mode === 'once'
        ? Cesium.Math.toRadians(m.kind === 'tilt' ? ONCE.tiltDeg : ONCE.rotateDeg) * (scale - (m.lastScale || 0))
        : Cesium.Math.toRadians(degS) * dt);
      m.lastScale = scale;
      if (m.kind === 'tilt') {
        const up = m.direction === 'up';
        // Clamp pitch to [-89°, -5°]: never through the ground, never at the sky.
        const next = cam.pitch + (up ? stepRad : -stepRad);
        if (next > PITCH_MAX || next < PITCH_MIN) { interruptCameraMotion('tilt-clamp'); return; }
        if (up) cam.lookUp(stepRad); else cam.lookDown(stepRad);
      } else if (m.direction === 'left') cam.lookLeft(stepRad);
      else cam.lookRight(stepRad);
    } else if (m.kind === 'route') {
      // The dolly's shaping lives in advanceRouteFlight(); the tick only
      // applies the pose and honours the same completion path as before.
      const frame = advanceRouteFlight(m, dt);
      // Armed and waiting for floor data — the camera stays exactly where the
      // user left it rather than teleporting to an altitude derived from
      // nothing. An interrupt during the arm is still instant.
      if (frame.arming) return;
      cam.setView({ destination: frame.eye, orientation: { direction: frame.direction, up: frame.up } });
      if (frame.finished) { interruptCameraMotion('route-complete'); return; }
    }
  } catch {
    interruptCameraMotion('tick-error');
  }
}

/** Wire the module to the viewer once (idempotent). */
export function initCameraVerbs(viewer, getViewTargetCartesian) {
  if (_viewer === viewer) return;
  _viewer = viewer;
  _getTarget = getViewTargetCartesian;
  if (_tickRemover) _tickRemover();
  _tickRemover = viewer.clock.onTick.addEventListener(onTick);
  for (const rm of _inputRemovers) rm();
  _inputRemovers = [];
  const canvas = viewer.scene.canvas;
  // ANY manual camera input reclaims control — the cancelFlight reflex.
  for (const evt of ['pointerdown', 'wheel']) {
    const h = () => interruptCameraMotion('manual-input');
    canvas.addEventListener(evt, h, { passive: true });
    _inputRemovers.push(() => canvas.removeEventListener(evt, h));
  }
}

/**
 * move_camera implementation. Returns the house result shape; rejections are
 * plain-English `ok:false` errors.
 * @param {Object} args
 * @param {Function|null} runNavigation Validated camera-authority transaction.
 */
export function moveCamera(args = {}, runNavigation = null) {
  const motion = String(args.motion || '').toLowerCase();
  const direction = args.direction ? String(args.direction).toLowerCase() : null;
  const speed = ORBIT_DEG_S[String(args.speed || 'normal').toLowerCase()] ? String(args.speed || 'normal').toLowerCase() : 'normal';
  const mode = args.mode === 'continuous' ? 'continuous' : 'once';
  if (motion === 'stop') {
    const wasActiveBeforeHandoff = Boolean(_active);
    const stop = () => {
      const { wasActive } = interruptCameraMotion('voice-stop');
      return {
        ok: true,
        action: 'move_camera',
        motion: 'stop',
        stopped: wasActiveBeforeHandoff || wasActive,
      };
    };
    return typeof runNavigation === 'function' ? runNavigation(stop) : stop();
  }
  if (!['orbit', 'pan', 'tilt', 'rotate'].includes(motion)) {
    return { ok: false, action: 'move_camera', error: `Unknown motion "${args.motion}" — use orbit, pan, tilt, rotate, or stop.` };
  }
  if (motion !== 'orbit' && !['left', 'right', 'up', 'down'].includes(direction)) {
    return { ok: false, action: 'move_camera', error: `${motion} needs a direction (left/right${motion !== 'rotate' ? '/up/down' : ''}).` };
  }
  if ((motion === 'rotate') && !['left', 'right'].includes(direction)) {
    return { ok: false, action: 'move_camera', error: 'rotate needs left or right.' };
  }
  if (motion === 'tilt') {
    // Honest limits: at the clamp a tilt is a no-op — say so instead of
    // reporting success and letting the model gaslight itself (field test).
    const pitch = _viewer.camera.pitch;
    if (direction === 'up' && pitch >= PITCH_MAX - Cesium.Math.toRadians(0.5)) {
      return { ok: false, action: 'move_camera', error: 'Already at the upper tilt limit (near the horizon) — tilt down, or zoom/pan instead.' };
    }
    if (direction === 'down' && pitch <= PITCH_MIN + Cesium.Math.toRadians(0.5)) {
      return { ok: false, action: 'move_camera', error: 'Already looking straight down — tilt up to raise the horizon.' };
    }
  }
  if (motion === 'orbit' && _viewer?.trackedEntity && typeof runNavigation !== 'function') {
    // The follow camera owns a tracked view; a lookAt orbit fights it frame
    // by frame and stop rips the camera out (field finding). Honest refusal
    // until tracked-orbit rides the follow camera natively (roadmap).
    const label = _viewer.trackedEntity?.name || _viewer.trackedEntity?.id || 'the tracked target';
    return { ok: false, action: 'move_camera', error: `Already following ${label} — the follow camera owns the view while tracking. Say "stop tracking" first if you want a free orbit.` };
  }
  const start = () => {
    interruptCameraMotion('replaced');
    const state = { kind: motion, direction: direction || 'right', speed, mode };
    if (motion === 'orbit') {
      if (_viewer.scene.tweens.length > 0) {
        // A camera flight is in progress ("fly to X and orbit it") — ALWAYS arm
        // and capture at the destination; a target existing right now is
        // meaningless (the globe is always under the crosshair).
        _active = { kind: 'orbit', direction: direction || 'right', speed, mode, pending: true };
        holdContinuousRender('camera-verb');
        return { ok: true, action: 'move_camera', motion, direction: direction || 'right', speed, mode, armed: 'waiting-for-arrival' };
      }
      const target = _getTarget?.(_viewer);
      if (!target) {
        // Mid-flight chain ("fly to X and orbit it"): ARM the orbit — the tick
        // loop keeps trying for a ground target as the flight settles.
        _active = { kind: 'orbit', direction: direction || 'right', speed, mode, pending: true };
        holdContinuousRender('camera-verb');
        return { ok: true, action: 'move_camera', motion, direction: direction || 'right', speed, mode, armed: 'waiting-for-arrival' };
      }
      const cam = _viewer.camera;
      const range = Cesium.Cartesian3.distance(cam.positionWC, target);
      // Pitch from geometry so lookAt reproduces the CURRENT framing exactly.
      const carto = Cesium.Cartographic.fromCartesian(cam.positionWC);
      const tCarto = Cesium.Cartographic.fromCartesian(target);
      const dh = carto.height - tCarto.height;
      const pitch = -Math.asin(Math.min(1, Math.max(-1, dh / Math.max(1, range))));
      state.target = target;
      state.hpr = new Cesium.HeadingPitchRange(cam.heading, pitch, range);
      state.hprStartHeading = cam.heading;
    }
    _active = state;
    // Verb motion drives the camera per clock tick — hold until interrupted;
    // interruptCameraMotion is the single release path. (perf wave 2)
    holdContinuousRender('camera-verb');
    return { ok: true, action: 'move_camera', motion, direction: state.direction, speed, mode };
  };
  const preserveCameraFlight = motion === 'orbit'
    && _viewer.scene.tweens.length > 0
    && !_viewer.trackedEntity;
  return typeof runNavigation === 'function'
    ? runNavigation(start, { preserveCameraFlight })
    : start();
}

/**
 * Zoom while orbiting: scale the orbit RADIUS instead of letting the zoom
 * fight the per-frame lookAt (field test: "zoom out did literally nothing").
 * @param {number} factor  >1 zooms out (radius grows), <1 zooms in.
 * @returns {boolean} true when an orbit consumed the zoom.
 */
export function adjustOrbitRange(factor) {
  if (!_active || _active.kind !== 'orbit' || !_active.hpr) return false;
  _active.hpr.range = Math.max(80, Math.min(5_000_000, _active.hpr.range * factor));
  return true;
}

/**
 * fly_route implementation: dolly along an existing route annotation.
 * @param {Array} annoList  — engine list() output (raw annos incl. `path`)
 * @param {Object} args
 * @param {Function|null} floorFn  (latDeg, lonDeg) => cached floor metres.
 * @param {Function|null} runNavigation Validated camera-authority transaction.
 * @param {Function|null} warmFn  (cells) => void — batch-warms the floor cells
 * along the route corridor. Without it a cold cache has no protection: route
 * vertices carry height 0, so an unwarmed mountain corridor reads as sea level.
 */
export function flyRoute(annoList, args = {}, floorFn = null, runNavigation = null, warmFn = null) {
  const speed = ROUTE_M_S[String(args.speed || 'normal').toLowerCase()] ? String(args.speed || 'normal').toLowerCase() : 'normal';
  const routes = (annoList || []).filter((a) => a.type === 'route' && Array.isArray(a.path) && a.path.length >= 2);
  if (!routes.length) {
    return { ok: false, action: 'fly_route', error: 'No route is drawn — draw a route first (e.g. "route from A to B"), then fly it.' };
  }
  let route = routes[routes.length - 1];
  if (args.label) {
    const wanted = String(args.label).toLowerCase();
    const byLabel = routes.filter((a) => String(a.label || '').toLowerCase().includes(wanted));
    if (!byLabel.length) {
      return { ok: false, action: 'fly_route', error: `No route matches "${args.label}" — say fly the route without a name for the newest one.` };
    }
    route = byLabel[byLabel.length - 1];
  }
  if (route.path.some((point) => !Number.isFinite(point?.lat)
    || point.lat < -90 || point.lat > 90
    || !Number.isFinite(point?.lon)
    || point.lon < -180 || point.lon > 180
    || (point.height !== undefined && !Number.isFinite(point.height)))) {
    return { ok: false, action: 'fly_route', error: 'The selected route has an invalid waypoint.' };
  }
  const pts = route.path.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.height || 0)));
  const cumM = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cumM.push(cumM[i - 1] + Cesium.Cartesian3.distance(pts[i - 1], pts[i]));
  }
  if (!Number.isFinite(cumM.at(-1)) || cumM.at(-1) <= 0) {
    return { ok: false, action: 'fly_route', error: 'The selected route has no flyable distance.' };
  }
  const start = () => {
    interruptCameraMotion('replaced');
    _active = createRouteFlight({
      pts,
      cumM,
      speed,
      floorFn,
      warmFn,
      probeFn: (cells) => probeMeshFloorM(_viewer?.scene, cells),
      cameraHeightM: _viewer?.camera?.positionCartographic?.height,
      reducedMotion: prefersReducedMotion(),
    });
    holdContinuousRender('camera-verb');
    return {
      ok: true, action: 'fly_route', label: route.label || null, speed,
      distanceM: Math.round(_active.totalM), durationS: Math.round(_active.durationS),
      waypoints: pts.length,
    };
  };
  return typeof runNavigation === 'function' ? runNavigation(start) : start();
}
