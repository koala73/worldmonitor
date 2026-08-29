import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AIRCRAFT_RECESSION_PARAMS,
  aircraftRecessionFactors,
  applyAircraftBillboardTreatment,
  applyAircraftModelTreatment,
  cameraLimbDistanceM,
} from './aircraftRecession.js';

const params = { ...DEFAULT_AIRCRAFT_RECESSION_PARAMS };
const cameraHeightM = 1_000_000;
const limb = cameraLimbDistanceM(cameraHeightM, params.earthRadiusM);

test('aircraft recession is a no-op below the limb-relative start threshold', () => {
  assert.deepEqual(
    aircraftRecessionFactors({ cameraDistanceM: limb * 0.49, cameraHeightM }, params),
    { scale: 1, alpha: 1, limbRatio: 0.49 },
  );
  assert.deepEqual(
    aircraftRecessionFactors({ cameraDistanceM: limb * 0.5, cameraHeightM }, params),
    { scale: 1, alpha: 1, limbRatio: 0.5 },
  );
});

test('aircraft recession reaches the tunable scale and haze floors at the limb', () => {
  const atLimb = aircraftRecessionFactors({ cameraDistanceM: limb, cameraHeightM }, params);
  assert.ok(Math.abs(atLimb.scale - 0.45) < 1e-12);
  assert.ok(Math.abs(atLimb.alpha - 0.35) < 1e-12);
  const beyond = aircraftRecessionFactors({ cameraDistanceM: limb * 1.2, cameraHeightM }, params);
  assert.ok(Math.abs(beyond.scale - 0.45) < 1e-12);
  assert.ok(Math.abs(beyond.alpha - 0.35) < 1e-12);
});

test('aircraft recession is a globe-view no-op instead of a global distance fade', () => {
  assert.deepEqual(
    aircraftRecessionFactors({ cameraDistanceM: 20_000_000, cameraHeightM: 5_000_000 }, params),
    { scale: 1, alpha: 1, limbRatio: null },
  );
});

test('globe-view transition eases to identity without a threshold pop', () => {
  let prior = null;
  for (let height = 3_500_000; height <= 4_500_000; height += 50_000) {
    const atLimbDistance = cameraLimbDistanceM(height, params.earthRadiusM);
    const current = aircraftRecessionFactors({
      cameraDistanceM: atLimbDistance,
      cameraHeightM: height,
    }, params);
    if (prior) {
      assert.ok(Math.abs(current.alpha - prior.alpha) <= 0.05, `${height}: alpha pop`);
      assert.ok(Math.abs(current.scale - prior.scale) <= 0.05, `${height}: scale pop`);
    }
    prior = current;
  }
  const start = aircraftRecessionFactors({
    cameraDistanceM: cameraLimbDistanceM(3_500_000, params.earthRadiusM),
    cameraHeightM: 3_500_000,
  }, params);
  const end = aircraftRecessionFactors({
    cameraDistanceM: cameraLimbDistanceM(4_500_000, params.earthRadiusM),
    cameraHeightM: 4_500_000,
  }, params);
  assert.ok(Math.abs(start.scale - params.scaleFloor) < 1e-12);
  assert.ok(Math.abs(start.alpha - params.alphaFloor) < 1e-12);
  assert.deepEqual(end, { scale: 1, alpha: 1, limbRatio: null });
});

test('aircraft billboard wire writes scale and alpha only for the far treatment', () => {
  const color = { withAlpha: (alpha) => ({ alpha }) };
  const near = { scale: 1.2, color: { alpha: 0.8 } };
  const nearResult = applyAircraftBillboardTreatment({
    billboard: near,
    baseScale: 1.2,
    baseAlpha: 0.8,
    baseColor: color,
    focusFactor: 1,
    cameraDistanceM: limb * 0.4,
    cameraHeightM,
    params,
  });
  assert.equal(nearResult.scaleWrites, 0);
  assert.equal(nearResult.alphaWrites, 0);

  const far = { scale: 1.2, color: { alpha: 0.8 } };
  const farResult = applyAircraftBillboardTreatment({
    billboard: far,
    baseScale: 1.2,
    baseAlpha: 0.8,
    baseColor: color,
    focusFactor: 0.5,
    cameraDistanceM: limb,
    cameraHeightM,
    params,
  });
  assert.equal(farResult.scaleWrites, 1);
  assert.equal(farResult.alphaWrites, 1);
  assert.ok(Math.abs(far.scale - (1.2 * 0.45)) < 1e-12);
  assert.ok(Math.abs(far.color.alpha - (0.8 * 0.20)) < 1e-12);
});

test('combined focus and haze product is clamped at the composed alpha floor', () => {
  const color = { withAlpha: (alpha) => ({ alpha }) };
  const billboard = { scale: 0.45, color: { alpha: 1 } };
  const result = applyAircraftBillboardTreatment({
    billboard,
    baseScale: 1,
    baseAlpha: 1,
    baseColor: color,
    focusFactor: 0.25,
    cameraDistanceM: limb,
    cameraHeightM,
    params,
  });
  assert.equal(result.alpha, 0.20);
  assert.equal(billboard.color.alpha, 0.20);
});

test('applyAircraftBillboardTreatment returns its documented module singleton', () => {
  const color = { withAlpha: (alpha) => ({ alpha }) };
  const billboard = { scale: 1, color: { alpha: 1 } };
  const input = {
    billboard,
    baseAlpha: 1,
    baseColor: color,
    focusFactor: 1,
    cameraDistanceM: 0,
    cameraHeightM,
    params,
  };
  const first = applyAircraftBillboardTreatment({ ...input, baseScale: 1 });
  const second = applyAircraftBillboardTreatment({ ...input, baseScale: 0.5 });
  assert.strictEqual(first, second);
  assert.equal(first.scale, 0.5, 'the prior reference reflects the next call');
});

test('ambient model presentation receives composed alpha without changing blend semantics', () => {
  const model = { color: { alpha: 1 }, colorBlendAmount: 0.9 };
  const color = { withAlpha: (alpha) => ({ alpha, rgb: 'amber' }) };
  assert.equal(applyAircraftModelTreatment({ model, baseColor: color, alpha: 0.2, params }), 1);
  assert.deepEqual(model.color, { alpha: 0.2, rgb: 'amber' });
  assert.equal(model.colorBlendAmount, 0.9);
  assert.equal(applyAircraftModelTreatment({ model, baseColor: color, alpha: 0.2, params }), 0);
});
