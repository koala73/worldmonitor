import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  HORIZON_FEATHER_RAD,
  horizonOccluder,
  screenProjectedRotation,
  skyBackdropFactor,
  stabilizeScreenRotation,
} from './iconOrientation.js';

const equatorPosition = Cesium.Cartesian3.fromDegrees(0, 0, 0);

function sceneForScreenRotation(degrees) {
  const angle = Cesium.Math.toRadians(degrees);
  return {
    camera: {
      rightWC: new Cesium.Cartesian3(Math.cos(angle), 0, -Math.sin(angle)),
      upWC: new Cesium.Cartesian3(Math.sin(angle), 0, Math.cos(angle)),
    },
  };
}

function wrappedDelta(actual, expected) {
  return Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected));
}

test('camera-basis course projection stays correct through a full orbit', () => {
  for (const degrees of [0, 90, 179, 181, 220, 270, 359]) {
    const actual = screenProjectedRotation(
      sceneForScreenRotation(degrees),
      equatorPosition,
      0,
      null,
    );
    assert.ok(
      Math.abs(wrappedDelta(actual, Cesium.Math.toRadians(degrees))) < 1e-12,
      `expected ${degrees}° course projection, received ${Cesium.Math.toDegrees(actual)}°`,
    );
  }
});

test('off-center oblique contacts pin the documented perspective divergence', () => {
  // Camera looks obliquely toward the equator. Right is world-east; up and
  // forward are pitched 30° from the local tangent/normal pair.
  const pitch = Cesium.Math.toRadians(30);
  const right = new Cesium.Cartesian3(0, 1, 0);
  const up = new Cesium.Cartesian3(Math.sin(pitch), 0, Math.cos(pitch));
  const forward = new Cesium.Cartesian3(-Math.cos(pitch), 0, Math.sin(pitch));
  const basisRotation = screenProjectedRotation({ camera: { rightWC: right, upWC: up } },
    equatorPosition, 0, null);

  // Exact pinhole derivative for a contact 2 km right of center and 5 km in
  // front. North has a depth component under this oblique camera, so exact
  // projection turns slightly while the stable camera-basis result stays up.
  const contactX = 2000;
  const contactY = 0;
  const contactZ = 5000;
  const north = new Cesium.Cartesian3(0, 0, 1);
  const directionX = Cesium.Cartesian3.dot(north, right);
  const directionY = Cesium.Cartesian3.dot(north, up);
  const directionZ = Cesium.Cartesian3.dot(north, forward);
  const exactScreenX = directionX * contactZ - contactX * directionZ;
  const exactScreenUp = directionY * contactZ - contactY * directionZ;
  const exactRotation = Math.atan2(-exactScreenX, exactScreenUp);

  assert.ok(Math.abs(basisRotation) < 1e-12);
  assert.ok(Math.abs(wrappedDelta(exactRotation, basisRotation)) > Cesium.Math.toRadians(5));
});

test('screen rotation holds sub-degree projection noise', () => {
  const previous = 1;
  assert.equal(
    stabilizeScreenRotation(previous, previous + (0.25 * Math.PI / 180)),
    previous,
  );
});

test('screen rotation accepts deliberate camera-orbit movement', () => {
  const previous = 1;
  const next = previous + (2 * Math.PI / 180);
  assert.equal(stabilizeScreenRotation(previous, next), next);
});

test('screen rotation compares across the wrapped angle boundary', () => {
  const previous = Math.PI - (0.1 * Math.PI / 180);
  const next = -Math.PI + (0.1 * Math.PI / 180);
  assert.equal(stabilizeScreenRotation(previous, next), previous);
});

// --- Backdrop discriminator -------------------------------------------------
// A label's plate should hold text off busy ground and get out of the way
// against empty sky. These pin the geometry that decides which case it is.

/** Camera at cruise altitude over the equator at lon 0, looking outward. */
const CRUISE_M = 10_000;
const cruiseCamera = Cesium.Cartesian3.fromDegrees(0, 0, CRUISE_M);

/**
 * Longitude of the ellipsoid silhouette from `cruiseCamera`. Along the equator
 * the WGS84 cross-section is a true circle of radius `maximumRadius`, so the
 * tangent condition is exact here and the expected answer is derived, not
 * guessed.
 */
const tangentLonDeg = Cesium.Math.toDegrees(Math.acos(
  Cesium.Ellipsoid.WGS84.maximumRadius
  / (Cesium.Ellipsoid.WGS84.maximumRadius + CRUISE_M),
));

test('a contact above the silhouette is read against sky', () => {
  // Another aircraft at the same flight level 200 km ahead. The chord between
  // two points at equal altitude bends below them, so it exits above the
  // horizon rather than into the planet — which is why a cruising contact
  // appears against sky and not against ground.
  const ahead = Cesium.Cartesian3.fromDegrees(200_000 / 111_320, 0, CRUISE_M);
  assert.equal(skyBackdropFactor(cruiseCamera, ahead), 1);
  // Straight overhead is the unambiguous case.
  const overhead = Cesium.Cartesian3.fromDegrees(0, 0, 400_000);
  assert.equal(skyBackdropFactor(cruiseCamera, overhead), 1);
});

test('a contact below the silhouette keeps ground behind it', () => {
  // Low and close: the view ray through it strikes the planet well short of
  // the horizon, so the plate has real imagery to separate the text from.
  const below = Cesium.Cartesian3.fromDegrees(30_000 / 111_320, 0, 2_000);
  assert.equal(skyBackdropFactor(cruiseCamera, below), 0);
  assert.equal(skyBackdropFactor(cruiseCamera, Cesium.Cartesian3.fromDegrees(0.05, 0, 0)), 0);
});

test('the silhouette itself lands exactly mid-band', () => {
  // The band is centred on the true horizon, so the tangent point is the 50%
  // crossing. This is the assertion that fails if the discriminator is ever
  // swapped for a spherical-earth or screen-space approximation.
  const tangent = Cesium.Cartesian3.fromDegrees(tangentLonDeg, 0, 0);
  assert.ok(Math.abs(skyBackdropFactor(cruiseCamera, tangent) - 0.5) < 1e-6);
});

/**
 * A contact 100 km ahead, climbing from the deck to above the camera. Only
 * altitude can carry a contact across the silhouette — a point at height zero
 * is on the planet and can never be in front of sky — so this, not a ground
 * track, is the sweep that exercises the band.
 */
function climbSweep(step = 500) {
  const samples = [];
  for (let height = 0; height <= 12_000; height += step) {
    samples.push(skyBackdropFactor(
      cruiseCamera,
      Cesium.Cartesian3.fromDegrees(100_000 / 111_320, 0, height),
    ));
  }
  return samples;
}

test('the band lerps monotonically and saturates on both sides', () => {
  // Smoothstep across the band means a contact drifting over the horizon
  // fades rather than popping.
  const samples = climbSweep();
  for (let i = 1; i < samples.length; i++) {
    assert.ok(
      samples[i] >= samples[i - 1] - 1e-12,
      `factor must not fall as a contact rises past the horizon (${samples[i - 1]} → ${samples[i]})`,
    );
  }
  assert.equal(samples[0], 0, 'well below the horizon is fully grounded');
  assert.equal(samples[samples.length - 1], 1, 'well above the horizon is fully sky');
  const partial = samples.filter((value) => value > 0 && value < 1);
  assert.ok(partial.length >= 3, `expected a real blend band, saw ${partial.length} partial samples`);
});

test('the band, not the geometry, is what smooths the crossing', () => {
  // With the feather removed the same sweep must collapse to a hard step.
  // This separates "the discriminator is right" from "the blend is wired up":
  // if the two ever get conflated, only one of these two tests goes red.
  const hard = [];
  for (let height = 0; height <= 12_000; height += 500) {
    hard.push(skyBackdropFactor(
      cruiseCamera,
      Cesium.Cartesian3.fromDegrees(100_000 / 111_320, 0, height),
      0,
    ));
  }
  assert.deepEqual([...new Set(hard)], [0, 1], 'a zero band must produce only the two end states');
});

/**
 * JFK, where the geoid runs about 34 m BELOW the ellipsoid: the ramp sits near
 * −30 m of ellipsoid height and a widebody cockpit reads ALT −18 m. Everyday
 * ground level at a coastal airport is therefore a camera INSIDE the ellipsoid,
 * which is why this is the scenario the horizon test has to get right.
 */
const JFK_LON = -73.7781;
const JFK_LAT = 40.6413;
const JFK_RAMP_H = -30;
const jfkCockpit = Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT, -18);
const DEG_PER_M_LAT = 1 / 110_574;

test('below the ellipsoid, a contact against open sky still reads as sky', () => {
  // The owner's cockpit view: traffic on approach, 8 km out and 900 m up, is
  // ~6.5° above eye level — the whole band is 1.09° per side, so this is not a
  // near call. Before the fix a sub-ellipsoid camera fell into the degenerate
  // guard and every one of these came back 0: a row of dark boxes on empty sky.
  const approach = Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT + 8_000 * DEG_PER_M_LAT, 900);
  assert.equal(skyBackdropFactor(jfkCockpit, approach), 1);
  // Straight overhead is the unambiguous case, from under the surface as much
  // as from cruise altitude.
  assert.equal(
    skyBackdropFactor(jfkCockpit, Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT, 10_000)),
    1,
  );
});

test('below the ellipsoid, a contact on the ramp still keeps its plate', () => {
  // Sky selectivity must not become "no plates at ground level". An aircraft
  // 150 m ahead on the ramp sits 12 m below the cockpit — 4.6° under eye level,
  // four band-widths down — so it is read against apron and keeps the full
  // plate that holds mono text off bright concrete.
  const ramp = Cesium.Cartesian3.fromDegrees(
    JFK_LON,
    JFK_LAT + 150 * DEG_PER_M_LAT,
    JFK_RAMP_H,
  );
  assert.equal(skyBackdropFactor(jfkCockpit, ramp), 0);
  // And the taxiway further out, still below the cockpit floor.
  assert.equal(
    skyBackdropFactor(
      jfkCockpit,
      Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT + 400 * DEG_PER_M_LAT, JFK_RAMP_H - 5),
    ),
    0,
  );
});

test('at the surface the horizon is exactly eye level, geodetic not geocentric', () => {
  // With no altitude there is no horizon dip, so the honest silhouette is the
  // local horizontal plane through the camera and a contact ON that plane is
  // the 50% crossing. The plane that matters is the GEODETIC tangent plane, and
  // at 40°N the geodetic normal misses the geocentric radial by ~0.19° — about
  // a sixth of the 1.09° half-band, so a spherical stand-in would land visibly
  // off centre rather than at 0.5, which is what the second half of this test
  // measures.
  const onSurface = Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT, 0);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(onSurface);
  const east = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(20_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  const alongHorizontal = Cesium.Cartesian3.add(onSurface, east, new Cesium.Cartesian3());
  assert.ok(
    Math.abs(skyBackdropFactor(onSurface, alongHorizontal) - 0.5) < 1e-5,
    `eye level must be the band centre, got ${skyBackdropFactor(onSurface, alongHorizontal)}`,
  );
  // The geocentric radial is NOT the answer: a contact perpendicular to it
  // lands measurably off centre, so this test cannot pass by accident.
  const radialUp = Cesium.Cartesian3.normalize(onSurface, new Cesium.Cartesian3());
  const perpToRadial = Cesium.Cartesian3.cross(
    radialUp,
    Cesium.Cartesian3.UNIT_Z,
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.cross(perpToRadial, radialUp, perpToRadial);
  Cesium.Cartesian3.multiplyByScalar(
    Cesium.Cartesian3.normalize(perpToRadial, perpToRadial),
    20_000,
    perpToRadial,
  );
  const alongRadialPlane = Cesium.Cartesian3.add(onSurface, perpToRadial, new Cesium.Cartesian3());
  assert.ok(
    Math.abs(skyBackdropFactor(onSurface, alongRadialPlane) - 0.5) > 0.05,
    'a geocentric horizontal would be a different plane; the test must be able to tell',
  );
});

/**
 * A fixed contact on the deck 30 km east along the equator — where the WGS84
 * cross-section is a true circle, so the sweep's geometry is exact — read from
 * a camera climbing from 50 m under the surface to 50 m over it. The contact
 * sits just under the horizon the whole way, so the factor is mid-band and
 * genuinely varying: this sweep measures the crossover itself, not a saturated
 * end state.
 */
function surfaceCrossingSweep(from = -50, to = 50, step = 1) {
  const contact = Cesium.Cartesian3.fromDegrees(30_000 / 111_319.49, 0, 0);
  const samples = [];
  for (let height = from; height <= to; height += step) {
    samples.push(skyBackdropFactor(Cesium.Cartesian3.fromDegrees(0, 0, height), contact));
  }
  return samples;
}

test('the answer stays continuous as the camera rises through the surface', () => {
  // The tangent cone and eye level are the same limit: the horizon dip
  // acos(R/(R+h)) goes to zero as the camera settles onto the ellipsoid, so the
  // cone opens continuously to the horizontal plane and the two regimes meet
  // with no seam. A hard fail-closed under the surface put a full step into the
  // middle of that climb — plates snapping on as the camera touched down.
  const samples = surfaceCrossingSweep();
  let worst = 0;
  for (let i = 1; i < samples.length; i++) {
    worst = Math.max(worst, Math.abs(samples[i] - samples[i - 1]));
  }
  assert.ok(worst < 0.05, `no step across the surface may pop; worst adjacent jump ${worst}`);
});

test('the crossover has no seam at the surface itself', () => {
  // A centimetre either side of the ellipsoid must read the same. The dip at
  // 1 cm is 5.6e-5 rad, a thousandth of the band, so any visible difference
  // here is a discontinuity in the code rather than in the geometry.
  const contact = Cesium.Cartesian3.fromDegrees(30_000 / 111_319.49, 0, 0);
  const under = skyBackdropFactor(Cesium.Cartesian3.fromDegrees(0, 0, -0.01), contact);
  const over = skyBackdropFactor(Cesium.Cartesian3.fromDegrees(0, 0, 0.01), contact);
  assert.ok(Math.abs(under - over) < 5e-3, `seam at the surface: ${under} vs ${over}`);
});

test('a sub-surface camera carries real information, not one frozen answer', () => {
  // The failure mode this replaces returned a constant. Under the surface the
  // factor must still track the contact's elevation, so a sweep of DIFFERENT
  // sub-surface camera heights must produce different answers.
  const belowOnly = surfaceCrossingSweep(-200, -1, 1);
  const spread = Math.max(...belowOnly) - Math.min(...belowOnly);
  assert.ok(spread > 0.05, `a sub-surface camera must still discriminate; spread ${spread}`);
  assert.ok(
    belowOnly.every((value) => value > 0 && value < 1),
    'this sweep is deliberately mid-band the whole way',
  );
});

/**
 * The formula this fix replaced, verbatim, kept only as the differential
 * reference below. The clamp is supposed to be the IDENTITY above the surface —
 * `1 / cameraMag` is already under 1 there, so `Math.min` cannot round it — and
 * that claim is worth a permanent pin rather than a one-off measurement, because
 * a future edit to the shared lines could drift the cruise answer while every
 * sub-surface test stayed green.
 */
function legacyAboveSurfaceFactor(cameraPosition, position, featherRad = HORIZON_FEATHER_RAD) {
  const s = Cesium.Ellipsoid.WGS84.oneOverRadii;
  const cx = cameraPosition.x * s.x;
  const cy = cameraPosition.y * s.y;
  const cz = cameraPosition.z * s.z;
  const cameraMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (!(cameraMag > 1)) return 0;
  let dx = position.x * s.x - cx;
  let dy = position.y * s.y - cy;
  let dz = position.z * s.z - cz;
  const rayMag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(rayMag > 0)) return 0;
  dx /= rayMag;
  dy /= rayMag;
  dz /= rayMag;
  const cosToCentre = -(cx * dx + cy * dy + cz * dz) / cameraMag;
  const rayAngle = Math.acos(Math.min(1, Math.max(-1, cosToCentre)));
  const margin = rayAngle - Math.asin(1 / cameraMag);
  if (!(featherRad > 0)) return margin > 0 ? 1 : 0;
  const t = Math.min(1, Math.max(0, margin / (2 * featherRad) + 0.5));
  return t * t * (3 - 2 * t);
}

/** Deterministic LCG, so a failure is reproducible rather than a flake. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('above the surface the answer is bit-identical to the formula it replaced', () => {
  // Every camera the product has ever rendered from is above the ellipsoid, so
  // this fix must be provably invisible there — not "close", identical. Object.is
  // rather than a tolerance: a tolerance would let a real drift hide under it.
  const random = seededRandom(0x5eed_1234);
  let compared = 0;
  let insideBand = 0;
  for (let i = 0; i < 4000; i++) {
    const lon = random() * 360 - 180;
    const lat = random() * 170 - 85;
    // 1 m to ~geostationary: the whole range the camera actually occupies.
    const cameraHeight = 1 + random() ** 4 * 36_000_000;
    const camera = Cesium.Cartesian3.fromDegrees(lon, lat, cameraHeight);
    const contact = Cesium.Cartesian3.fromDegrees(
      lon + (random() * 60 - 30),
      Math.max(-89, Math.min(89, lat + (random() * 60 - 30))),
      random() ** 3 * 1_000_000 - 500,
    );
    const shipped = skyBackdropFactor(camera, contact);
    const legacy = legacyAboveSurfaceFactor(camera, contact);
    assert.ok(
      Object.is(shipped, legacy),
      `above-surface drift at sample ${i} (h=${cameraHeight}): ${shipped} !== ${legacy}`,
    );
    if (shipped > 0 && shipped < 1) insideBand++;
    compared++;
  }
  assert.equal(compared, 4000, 'the sweep must actually run');
  // Saturated ends agree trivially; only the smoothstep interior can show a
  // float-level drift. If a future edit to the sampling pushed every sample to
  // 0 or 1 this pin would still be green while proving nothing, so guard it.
  assert.ok(
    insideBand >= 100,
    `the sweep must exercise the blend band, not just its saturated ends (${insideBand} inside)`,
  );
});

test('below the surface the backdrop test agrees with the occluder beside it', () => {
  // These two are halves of one geometry: the occluder asks what is in FRONT of
  // a point, this asks what is BEHIND it, and the docstring's invariant is that
  // for any point the occluder KEEPS, a ray that hits the ellipsoid hits it
  // beyond the point. Cesium resolves a sub-ellipsoid camera by culling
  // everything under the local horizontal plane — eye level, the same limit
  // adopted here — so the invariant survives under the surface only if both
  // halves use that plane. The old fail-closed broke exactly this: the occluder
  // kept a contact against sky and the backdrop test called it ground.
  const camera = Cesium.Cartesian3.fromDegrees(JFK_LON, JFK_LAT, -18);
  const occluder = horizonOccluder({ positionWC: camera });
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(camera);
  const offsetBy = (up) => Cesium.Cartesian3.add(
    camera,
    Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(0, 20_000, up),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  // 20 km out and 600 m clear of eye level is well outside the 1.09° band.
  const aboveEye = offsetBy(600);
  const belowEye = offsetBy(-600);
  assert.equal(occluder.isPointVisible(aboveEye), true, 'the occluder keeps what is above eye level');
  assert.equal(skyBackdropFactor(camera, aboveEye), 1, 'and the backdrop test must call it sky');
  assert.equal(occluder.isPointVisible(belowEye), false, 'the occluder culls what is below it');
  assert.equal(skyBackdropFactor(camera, belowEye), 0, 'and the backdrop test must call it ground');
});

test('a degenerate camera or contact reports ground rather than throwing', () => {
  // A plate that stays is a cosmetic miss; a plate that vanishes on a frame
  // where the inputs go bad is a flicker. Fail toward the plate — but only for
  // inputs that are genuinely unanswerable, never for an ordinary low camera.
  assert.equal(skyBackdropFactor(null, cruiseCamera), 0);
  assert.equal(skyBackdropFactor(cruiseCamera, null), 0);
  assert.equal(skyBackdropFactor(cruiseCamera, cruiseCamera), 0);
  // The planet's centre has no local vertical to measure against.
  assert.equal(skyBackdropFactor(Cesium.Cartesian3.ZERO, cruiseCamera), 0);
  assert.equal(skyBackdropFactor(new Cesium.Cartesian3(NaN, NaN, NaN), cruiseCamera), 0);
  assert.equal(skyBackdropFactor(cruiseCamera, new Cesium.Cartesian3(NaN, NaN, NaN)), 0);
  // An infinite coordinate normalizes to NaN a few lines later, and a NaN plate
  // alpha reaches the canvas as an invisible label rather than a caught error.
  assert.equal(skyBackdropFactor(new Cesium.Cartesian3(Infinity, 0, 0), cruiseCamera), 0);
  assert.equal(skyBackdropFactor(cruiseCamera, new Cesium.Cartesian3(Infinity, 0, 0)), 0);
});

test('the feather band is a named constant in a sane screen-space range', () => {
  // ~1° per side: at the product's default frustum that is tens of pixels of
  // crossfade. A band of degrees would smear plates across half the sky; a
  // band of arc-seconds would pop.
  assert.ok(HORIZON_FEATHER_RAD > 0.002 && HORIZON_FEATHER_RAD < 0.09);
});
