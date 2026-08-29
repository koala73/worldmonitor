import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  clampTrackedCameraPosition,
  trackedDisplayPositionForCamera,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';

test('tracked camera origin crossing returns to the prior side at the minimum range', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, 500, -300),
    direction: new Cesium.Cartesian3(0, -1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -1000, 600);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Cesium.Cartesian3.dot(camera.position, previous) > 0);
  assert.ok(Math.abs(Cesium.Cartesian3.magnitude(camera.position) - 150) < 1e-9);
});

test('tracked camera clamps a too-close approach along the current sight line', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -80, 0),
    direction: new Cesium.Cartesian3(0, 1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -200, 0);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Math.abs(camera.position.x) === 0);
  assert.equal(camera.position.y, -150);
  assert.ok(Math.abs(camera.position.z) === 0);
});

test('tracked camera leaves a safe approach unchanged', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -800, 500),
    direction: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(0, 800, -500),
      new Cesium.Cartesian3(),
    ),
  };
  const previous = Cesium.Cartesian3.clone(camera.position);
  const before = Cesium.Cartesian3.clone(camera.position);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), false);
  assert.deepEqual(camera.position, before);
});

test('tracked model keeps calibrated scale when it projects below the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 1000,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  assert.equal(scale, 24);
});

test('tracked model shrinks smoothly when close enough to exceed the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 150,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  const focalLengthPx = 800 / (2 * Math.tan(Math.PI / 6));
  const projectedDiameterPx = (2 * 1.43 * scale * focalLengthPx) / 150;
  assert.ok(scale < 24);
  assert.ok(Math.abs(projectedDiameterPx - 104) < 1e-9);
});

test('tracked camera prefers the already-rendered display cache', () => {
  let callbackReads = 0;
  const cached = new Cesium.Cartesian3(1, 2, 3);
  const entity = {
    gevDisplayPosition: () => cached,
    position: {
      getValue: () => {
        callbackReads += 1;
        return new Cesium.Cartesian3(4, 5, 6);
      },
    },
  };
  const result = trackedDisplayPositionForCamera(
    entity,
    Cesium.JulianDate.now(),
    new Cesium.Cartesian3(),
  );
  assert.deepEqual(result, cached);
  assert.notEqual(result, cached);
  assert.equal(callbackReads, 0);
});
