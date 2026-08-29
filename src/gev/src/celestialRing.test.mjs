import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELESTIAL_PLANE_EPSILON,
  GLOBE_ENTER_CLEARANCE_PX,
  GLOBE_EXIT_CLEARANCE_PX,
  celestialScreenAngle,
  circularAngleDistance,
  earthDiscScreenRadius,
  getKeyholeFadeTuning,
  getKeyholeGeometry,
  isCelestialRingStyleSupported,
  isFullGlobeInsideKeyhole,
  keyholeLabelAlpha,
  normalizeAngle,
  setKeyholeFadeTuning,
} from './celestialRing.js';

function geometry(clearance, offset = 0) {
  const keyholeRadius = 500;
  const earthRadius = keyholeRadius - offset - clearance;
  return {
    earthCenterX: 500 + offset,
    earthCenterY: 500,
    earthRadius,
    keyholeCenterX: 500,
    keyholeCenterY: 500,
    keyholeRadius,
  };
}

test('full globe enters only with the larger clearance', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX), false), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX - 0.1), false), false);
});

test('visible globe uses the smaller exit clearance for hysteresis', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX), true), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX - 0.1), true), false);
});

test('off-center globe containment includes center offset', () => {
  const centered = geometry(30, 0);
  const shifted = { ...centered, earthCenterX: centered.earthCenterX + 20 };
  assert.equal(isFullGlobeInsideKeyhole(centered, false), true);
  assert.equal(isFullGlobeInsideKeyhole(shifted, false), false);
});

test('invalid or clipped Earth discs are rejected', () => {
  assert.equal(isFullGlobeInsideKeyhole(null, false), false);
  assert.equal(isFullGlobeInsideKeyhole({ ...geometry(30), earthRadius: -1 }, false), false);
  assert.equal(isFullGlobeInsideKeyhole(geometry(-2), true), false);
});

test('Earth-disc projection radius rejects local and invalid camera geometry', () => {
  const earthRadius = 6_378_137;
  assert.equal(earthDiscScreenRadius(earthRadius, 800, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 0, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 800, 0), null);
  assert.ok(earthDiscScreenRadius(earthRadius * 2, 800, Math.PI / 3) > 0);
});

test('camera-plane projection maps right, up, left, and down to canvas angles', () => {
  assert.ok(Math.abs(celestialScreenAngle(1, 0).angle - 0) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, 1).angle - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(-1, 0).angle - Math.PI) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, -1).angle - Math.PI * 0.5) < 1e-9);
});

test('unstable camera-axis projection retains the last bearing and fades', () => {
  const last = 1.25;
  const projected = celestialScreenAngle(CELESTIAL_PLANE_EPSILON * 0.2, 0, last);
  assert.equal(projected.stable, false);
  assert.equal(projected.angle, last);
  assert.ok(projected.opacity > 0 && projected.opacity < 1);
});

test('angle normalization wraps both directions', () => {
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(Math.PI * 5) - Math.PI) < 1e-9);
});

test('circular angle distance remains small across the wrap point', () => {
  assert.ok(Math.abs(circularAngleDistance(0.04, Math.PI * 2 - 0.03) - 0.07) < 1e-9);
  assert.ok(Math.abs(circularAngleDistance(0, Math.PI) - Math.PI) < 1e-9);
});

test('celestial ring is available only in Normal style', () => {
  assert.equal(isCelestialRingStyleSupported('normal'), true);
  for (const style of ['retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']) {
    assert.equal(isCelestialRingStyleSupported(style), false);
  }
});

test('sun and moon bearings are independent rather than forced opposite', () => {
  const sun = celestialScreenAngle(1, 0).angle;
  const moon = celestialScreenAngle(0.6, -0.8).angle;
  assert.notEqual(normalizeAngle(moon - sun), Math.PI);
});

test('shared keyhole geometry is centered and height-derived', () => {
  const landscape = getKeyholeGeometry(1200, 800);
  const portrait = getKeyholeGeometry(800, 1200);
  assert.equal(landscape.centerX, 600);
  assert.equal(landscape.centerY, 400);
  assert.equal(landscape.radius, 420);
  assert.equal(portrait.centerX, 400);
  assert.equal(portrait.centerY, 600);
  assert.equal(portrait.radius, 630);
});

test('label alpha stays opaque inside and fades monotonically outside', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0 });
  const geometry = getKeyholeGeometry(1200, 800);
  const y = geometry.centerY;
  assert.equal(keyholeLabelAlpha(geometry.centerX, y, 1200, 800), 1);
  assert.equal(keyholeLabelAlpha(geometry.centerX + geometry.radius, y, 1200, 800), 1);
  const quarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.25, y, 1200, 800,
  );
  const middle = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.5, y, 1200, 800,
  );
  const threeQuarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.75, y, 1200, 800,
  );
  assert.ok(quarter > middle && middle > threeQuarter);
  assert.ok(Math.abs(quarter - 0.75) < 1e-12);
  assert.ok(Math.abs(middle - 0.5) < 1e-12);
  assert.ok(Math.abs(threeQuarter - 0.25) < 1e-12);
  assert.equal(keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx, y, 1200, 800,
  ), 0);
});

test('fade tuning scales with keyhole radius and supports outside opacity', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.2, outsideOpacity: 0.3 });
  const small = getKeyholeGeometry(800, 600);
  const large = getKeyholeGeometry(1600, 1200);
  assert.equal(large.featherPx, small.featherPx * 2);
  assert.deepEqual(getKeyholeFadeTuning(), { fadeRatio: 0.2, outsideOpacity: 0.3 });
  assert.equal(keyholeLabelAlpha(
    small.centerX + small.radius + small.featherPx,
    small.centerY,
    800,
    600,
  ), 0.3);
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0.05 });
});
