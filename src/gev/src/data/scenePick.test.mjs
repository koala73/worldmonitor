import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { isPickedWorldPosition } from './scenePick.js';

const describe = (position) => (position
  ? `(${position.x}, ${position.y}, ${position.z})`
  : String(position));

test('a degenerate depth pick is rejected before it reaches Cesium', () => {
  // These are the shapes `scene.pickPosition()` can produce when the depth read
  // over empty sky is meaningless. Each one is a MISSED pick, not a place.
  const degenerate = [
    null,
    undefined,
    new Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN),
    new Cesium.Cartesian3(0, 0, 0),
    new Cesium.Cartesian3(Number.POSITIVE_INFINITY, 0, 0),
    new Cesium.Cartesian3(0, Number.NEGATIVE_INFINITY, 0),
    new Cesium.Cartesian3(1, Number.NaN, 1),
    new Cesium.Cartesian3(0.2, -0.3, 0.1),
  ];
  for (const position of degenerate) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
  }
});

test('the guard is an Earth-sized band, not just a non-zero check', () => {
  // Finiteness alone is not validation. A pick has to land in the shell the
  // Earth actually occupies, because the values BETWEEN "zero" and "the globe"
  // are the ones that fail quietly.
  const belowTheFloor = [
    // the regression probe: finite, non-zero, and 6,378 km underground. A bare
    // non-zero check accepts it, and the shipped path then reverse-geocodes
    // 0°, 0° as if the operator were looking at the Gulf of Guinea.
    new Cesium.Cartesian3(500, 0, 0),
    new Cesium.Cartesian3(0, 1_000_000, 0),
    new Cesium.Cartesian3(0, 0, 5_999_999),
  ];
  for (const position of belowTheFloor) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
    // Each one converts WITHOUT throwing — that is exactly what makes it dangerous.
    const carto = Cesium.Cartographic.fromCartesian(position);
    assert.ok(carto, `Cesium converts ${describe(position)} without complaint`);
    assert.ok(carto.height < -300_000, 'and puts the "target" hundreds of km underground');
  }

  const aboveTheCeiling = [
    new Cesium.Cartesian3(1_000_000_001, 0, 0),
    new Cesium.Cartesian3(0, 1e12, 0),
    // Large enough to overflow Cesium's geodetic iteration into NaN.
    new Cesium.Cartesian3(1e155, 0, 0),
  ];
  for (const position of aboveTheCeiling) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
  }
  assert.throws(
    () => Cesium.Cartographic.fromCartesian(new Cesium.Cartesian3(1e155, 0, 0)),
    /normalized result is not a number/,
    'the ceiling is load-bearing: an absurd finite magnitude still throws',
  );

  // Both edges of the band are inclusive, and both are real magnitudes.
  assert.equal(isPickedWorldPosition(new Cesium.Cartesian3(6_000_000, 0, 0)), true);
  assert.equal(isPickedWorldPosition(new Cesium.Cartesian3(1_000_000_000, 0, 0)), true);
});

test('a real picked position is accepted', () => {
  const real = [
    // Ground, a cruising airliner, and the deepest surface point on the globe.
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0),
    Cesium.Cartesian3.fromDegrees(139.6917, 35.6895, 12_000),
    Cesium.Cartesian3.fromDegrees(0, -89.9, -400),
    Cesium.Cartesian3.fromDegrees(142.2, 11.35, -10_935),
    // A tall structure: pickPosition returns the mesh, not the terrain.
    Cesium.Cartesian3.fromDegrees(55.2744, 25.1972, 828),
    // The polar surface is the smallest magnitude the globe can produce.
    Cesium.Cartesian3.fromDegrees(0, 90, 0),
    // Satellites are real contacts too, up to geostationary.
    Cesium.Cartesian3.fromDegrees(0, 0, 550_000),
    Cesium.Cartesian3.fromDegrees(0, 0, 35_786_000),
  ];
  for (const position of real) {
    assert.equal(isPickedWorldPosition(position), true, `must accept ${describe(position)}`);
  }

  // The floor has real margin under the smallest legitimate magnitude, so no
  // plausible pick sits anywhere near the boundary.
  const polarSurface = Cesium.Cartesian3.magnitude(Cesium.Cartesian3.fromDegrees(0, 90, -10_935));
  assert.ok(polarSurface > 6_300_000, `smallest real magnitude was ${polarSurface}`);
});

test('the guard rejects each way Cesium mishandles a degenerate pick', () => {
  // This pins the REASON for the guard, so it cannot drift into cargo cult.
  // Cesium fails three different ways, and only one of them is loud.

  // 1. Non-finite components throw — the uncaught DeveloperError on the demo path.
  for (const position of [
    new Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN),
    new Cesium.Cartesian3(Number.POSITIVE_INFINITY, 0, 0),
    new Cesium.Cartesian3(1, Number.NaN, 1),
  ]) {
    assert.throws(
      () => Cesium.Cartographic.fromCartesian(position),
      /normalized result is not a number/,
      `Cesium must still throw on ${describe(position)}`,
    );
    assert.equal(isPickedWorldPosition(position), false);
  }

  // 2. Exactly the center returns undefined — silent, and a TypeError at any
  //    call site that reads `.latitude` off the result.
  const center = new Cesium.Cartesian3(0, 0, 0);
  assert.equal(Cesium.Cartographic.fromCartesian(center), undefined);
  assert.equal(isPickedWorldPosition(center), false);

  // 3. A near-center point converts "successfully" into a place inside the
  //    Earth's core. That is the quietest failure of the three and the reason
  //    the guard needs a magnitude band, not just a finiteness check.
  const nearCenter = new Cesium.Cartesian3(0.2, -0.3, 0.1);
  assert.ok(Cesium.Cartographic.fromCartesian(nearCenter), 'Cesium converts it without complaint');
  assert.equal(isPickedWorldPosition(nearCenter), false);

  // …and every position the guard accepts must convert to the right place.
  const accepted = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 250);
  assert.equal(isPickedWorldPosition(accepted), true);
  const carto = Cesium.Cartographic.fromCartesian(accepted);
  assert.ok(carto, 'a valid pick must convert');
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) + 97.7431) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 30.2672) < 1e-6);
});
