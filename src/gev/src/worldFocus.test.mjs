// One-click transfer pipeline for clicked world targets (pre-launch defect #4).
// The layer only announces the click; the UI owns the camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  WORLD_CLICK_FOCUS_DURATION_SEC,
  WORLD_FOCUS_FRAMING,
  WORLD_FOCUS_REQUEST_EVENT,
  flyToWorldTarget,
  isValidWorldFocusTarget,
  registerWorldFocusRequestListener,
  requestWorldFocus,
  routeWorldFocusRequest,
} from './worldFocus.js';

const POSITION = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 0);

function stubCamera() {
  const calls = { cancelFlight: 0, flights: [] };
  return {
    calls,
    heading: Cesium.Math.toRadians(45),
    cancelFlight() { calls.cancelFlight += 1; },
    flyToBoundingSphere(sphere, options) { calls.flights.push({ sphere, options }); },
  };
}

test('a focus request carries the clicked target to any registered listener', () => {
  const target = new EventTarget();
  const seen = [];
  const dispose = registerWorldFocusRequestListener(target, (event) => seen.push(event.detail));
  assert.equal(requestWorldFocus({ kind: 'vessel', position: POSITION, id: '123' }, target), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'vessel');
  assert.equal(seen[0].id, '123');
  // Disposal is idempotent and removes the exact listener.
  dispose();
  dispose();
  requestWorldFocus({ kind: 'vessel', id: '123', position: POSITION }, target);
  assert.equal(seen.length, 1);
});

test('requests without a kind or a position are dropped, never dispatched', () => {
  const target = new EventTarget();
  let count = 0;
  target.addEventListener(WORLD_FOCUS_REQUEST_EVENT, () => { count += 1; });
  assert.equal(requestWorldFocus({ position: POSITION }, target), false);
  assert.equal(requestWorldFocus({ kind: 'vessel' }, target), false);
  assert.equal(requestWorldFocus(null, target), false);
  assert.equal(count, 0);
});

test('routing hands the request to the UI policy, which owns the flight', () => {
  const order = [];
  const result = routeWorldFocusRequest(
    { detail: { kind: 'fire', id: 'fire-1', position: POSITION } },
    (detail, fly) => {
      order.push(`policy:${detail.kind}`);
      return fly();
    },
    (detail) => {
      order.push(`fly:${detail.kind}`);
      return 'flew';
    },
  );
  // The policy runs FIRST — it releases the follow camera before the flight.
  assert.deepEqual(order, ['policy:fire', 'fly:fire']);
  assert.equal(result, 'flew');
});

test('a refusing policy (cockpit owns the camera) never reaches the flight', () => {
  let flights = 0;
  const result = routeWorldFocusRequest(
    { detail: { kind: 'vessel', id: '123', position: POSITION } },
    () => false,
    () => { flights += 1; },
  );
  assert.equal(result, false);
  assert.equal(flights, 0);
});

test('malformed requests are inert', () => {
  assert.equal(routeWorldFocusRequest(null, () => 'x', () => 'y'), false);
  assert.equal(routeWorldFocusRequest({ detail: { kind: 'vessel' } }, () => 'x', () => 'y'), false);
});

// A request that cannot fly must never cost the user their tracking: the UI
// policy releases the follow camera, so validation happens BEFORE it runs.
test('an unflyable request never reaches the release policy', () => {
  const unflyable = [
    { kind: 'plane', position: POSITION },                       // no framing for this kind
    { kind: 'vessel', position: { x: NaN, y: 0, z: 0 } },        // malformed position
    { kind: 'vessel', position: { x: 0, y: 0 } },                // truthy but incomplete
    { kind: 'vessel', id: '123', position: { x: 0, y: 0, z: 0 } }, // ECEF origin
    { kind: 'fire', id: 'fire-1', position: { x: 1, y: 1, z: 1 } }, // finite but inside Earth
    { kind: 'vessel', position: 'somewhere' },
    { kind: 'vessel', position: POSITION },                     // missing owner id
    { position: POSITION },
  ];
  for (const detail of unflyable) {
    assert.equal(isValidWorldFocusTarget(detail), false, JSON.stringify(detail));
    let policyRuns = 0;
    const result = routeWorldFocusRequest(
      { detail },
      () => { policyRuns += 1; return 'released'; },
      () => 'flew',
    );
    assert.equal(result, false, JSON.stringify(detail));
    assert.equal(policyRuns, 0, `the policy must not run for ${JSON.stringify(detail)}`);
    // Nor may such a request be dispatched in the first place.
    assert.equal(requestWorldFocus(detail, new EventTarget()), false);
  }
  assert.equal(isValidWorldFocusTarget({ kind: 'vessel', id: '123', position: POSITION }), true);
  assert.equal(isValidWorldFocusTarget({ kind: 'fire', id: 'fire-1', position: POSITION }), true);
});

test('the transfer flight supersedes any flight in progress and keeps the operator heading', () => {
  const camera = stubCamera();
  assert.equal(flyToWorldTarget({ camera }, { kind: 'vessel', id: '123', position: POSITION }), true);
  assert.equal(camera.calls.cancelFlight, 1, 'a prior flight must be cancelled, not queued');
  assert.equal(camera.calls.flights.length, 1);
  const { sphere, options } = camera.calls.flights[0];
  assert.equal(sphere.radius, WORLD_FOCUS_FRAMING.vessel.radiusM);
  assert.equal(options.duration, WORLD_CLICK_FOCUS_DURATION_SEC);
  assert.equal(options.offset.range, WORLD_FOCUS_FRAMING.vessel.rangeM);
  // Heading is preserved so the transfer never spins the operator around.
  assert.equal(options.offset.heading, camera.heading);
  assert.equal(options.easingFunction, Cesium.EasingFunction.CUBIC_IN_OUT);
});

test('fires frame wider than vessels — a fire is read by its surroundings', () => {
  const camera = stubCamera();
  flyToWorldTarget({ camera }, { kind: 'fire', id: 'fire-1', position: POSITION });
  const { sphere, options } = camera.calls.flights[0];
  assert.equal(sphere.radius, WORLD_FOCUS_FRAMING.fire.radiusM);
  assert.equal(options.offset.range, WORLD_FOCUS_FRAMING.fire.rangeM);
  assert.ok(WORLD_FOCUS_FRAMING.fire.rangeM > WORLD_FOCUS_FRAMING.vessel.rangeM);
  assert.ok(WORLD_FOCUS_FRAMING.fire.radiusM > WORLD_FOCUS_FRAMING.vessel.radiusM);
});

test('every framing is a real oblique standoff, not a nadir or an inside-out sphere', () => {
  const kinds = Object.keys(WORLD_FOCUS_FRAMING);
  assert.deepEqual(kinds.sort(), ['fire', 'vessel']);
  for (const kind of kinds) {
    const framing = WORLD_FOCUS_FRAMING[kind];
    // Looking DOWN at the target, but obliquely — a nadir drop reads as a map.
    assert.ok(framing.pitchDeg < 0, `${kind}: pitch must look down, got ${framing.pitchDeg}`);
    assert.ok(framing.pitchDeg > -80, `${kind}: pitch must stay oblique, got ${framing.pitchDeg}`);
    // Standing off outside the framed sphere, at a human-readable distance.
    assert.ok(framing.radiusM > 0, `${kind}: radius must be positive`);
    assert.ok(
      framing.rangeM > framing.radiusM,
      `${kind}: range ${framing.rangeM} must stand off outside radius ${framing.radiusM}`,
    );
    assert.ok(framing.rangeM <= 10000, `${kind}: range must stay close-in, got ${framing.rangeM}`);
  }
  // Exact shipped values — a silent retune must show up as a failing test.
  assert.deepEqual({ ...WORLD_FOCUS_FRAMING.vessel }, { radiusM: 150, rangeM: 1200, pitchDeg: -30 });
  assert.deepEqual({ ...WORLD_FOCUS_FRAMING.fire }, { radiusM: 400, rangeM: 3000, pitchDeg: -35 });
});

test('unknown kinds and missing viewers issue no flight', () => {
  const camera = stubCamera();
  assert.equal(flyToWorldTarget({ camera }, { kind: 'plane', position: POSITION }), false);
  assert.equal(flyToWorldTarget({ camera }, { kind: 'vessel' }), false);
  assert.equal(flyToWorldTarget(null, { kind: 'vessel', position: POSITION }), false);
  assert.equal(camera.calls.flights.length, 0);
});
