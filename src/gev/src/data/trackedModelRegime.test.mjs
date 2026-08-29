// src/data/trackedModelRegime.test.mjs
//
// Zoom-driven 2D↔3D for the TRACKED contact (product invariant 2026-08-19).
//
// Two things are pinned here, and both are behavioural rather than cosmetic:
//
//  1. The POLICY — thresholds and hysteresis — as pure math in
//     trackedModelRegime.js. The enter ceiling is the playtested swap
//     distance, deliberately much NEARER than the fleet ceiling, and the exit
//     ceiling is deliberately higher than the enter ceiling. A regression that
//     collapsed the two thresholds back into one would silently reintroduce
//     billboard↔model flapping for a camera orbiting the boundary, which no
//     unit test would otherwise catch.
//
//  2. The WIRING in both flight layers — that the tracked contact takes its
//     model with the fleet `models3d` toggle OFF (the whole point of the
//     feature), that cockpit and TR-3B suppression survived the rewrite, and
//     that deselecting drops the regime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackedModelZoomActive,
  TRACKED_MODEL_ENTER_ALT_M,
  TRACKED_MODEL_EXIT_ALT_M,
  FLEET_MODEL_ALT_CEIL_M,
  TRACKED_MODEL_EXIT_RATIO,
} from './trackedModelRegime.js';
import * as Cesium from 'cesium';
import flightsLayer, {
  _setTrackedFlightRefreshStateForTest,
  _trackedModelRegimeActiveForTest as flightsRegimeActive,
  _updateTrackedModelForTest as flightsDriveTrackedModel,
  _trackedBillboardColorForTest as flightsTrackedBillboardColor,
  _driveFleetModelHandoffForTest as flightsDriveFleetModel,
  _ensureFleetModelForTest as flightsEnsureFleetModel,
} from './flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
  _trackedModelRegimeActiveForTest as militaryRegimeActive,
  _updateTrackedModelForTest as militaryDriveTrackedModel,
  _trackedBillboardColorForTest as militaryTrackedBillboardColor,
  _driveFleetModelHandoffForTest as militaryDriveFleetModel,
  _ensureFleetModelForTest as militaryEnsureFleetModel,
} from './militaryFlights.js';
import { clearTr3bRegistry, setTr3b } from './tr3bRegistry.js';
import { reportMeshFloorCell, _clearMeshFloorCellsForTest } from './groundFloor.js';

// Sample altitudes are expressed RELATIVE to the band rather than as absolute
// offsets. The thresholds have already been retuned once (1_000_000 → 150_000
// on the owner's playtest), and the fixed ±50 km / ±100 km offsets that were
// fine against a 150 km-wide band silently landed on the WRONG SIDE of the exit
// ceiling against a 22.5 km one. Deriving them keeps the next retune honest.
const BAND_WIDTH_M = TRACKED_MODEL_EXIT_ALT_M - TRACKED_MODEL_ENTER_ALT_M;
/** Strictly between enter and exit: latched → holds, fresh → does not. */
const INSIDE_BAND_M = TRACKED_MODEL_ENTER_ALT_M + BAND_WIDTH_M / 2;
/** Unambiguously past the exit ceiling. */
const FAR_OUTSIDE_M = TRACKED_MODEL_EXIT_ALT_M * 2;
/** Unambiguously below the enter ceiling. */
const WELL_INSIDE_M = TRACKED_MODEL_ENTER_ALT_M / 2;

// ---------------------------------------------------------------------------
// 1. Policy: thresholds + hysteresis math
// ---------------------------------------------------------------------------

test('the tracked 3D takeover sits at the playtested swap distance', () => {
  // Field test 2026-08-20: an earlier 1_000_000 m ceiling "pops to 3D far
  // too early" — 2D still reads correctly at ~600_000 m and the swap belongs at
  // ~150_000 m. These are the numbers the operator judged by eye, so they are
  // pinned literally rather than derived from anything.
  assert.equal(TRACKED_MODEL_ENTER_ALT_M, 150_000);
  assert.equal(trackedModelZoomActive(600_000, false), false,
    'the owner explicitly called 2D correct at ~600 km — it must not model there');
  assert.equal(trackedModelZoomActive(140_000, false), true,
    'inside the ruled swap distance the model owns the visual');
});

test('the tracked contact swaps NEARER than the fleet — a recorded inversion, not a bug', () => {
  // Consequence of the selected threshold, spelled out so it cannot be "tidied
  // away": with the DISPLAY-rail 3D toggle ON, camera altitudes between the
  // tracked ceiling and the fleet ceiling draw surrounding contacts as models
  // while the SELECTED one is still a billboard. The fleet pass skips the
  // tracked icao, so nothing double-draws — this is purely an ordering
  // difference. Aligning them is a fleet-side decision, out of scope here.
  assert.equal(FLEET_MODEL_ALT_CEIL_M, 800_000,
    'mirror of MODEL_ALT_CEIL_M in both flight layers');
  assert.ok(TRACKED_MODEL_ENTER_ALT_M < FLEET_MODEL_ALT_CEIL_M,
    'the tracked contact deliberately enters 3D closer in than the fleet does');
  assert.equal(trackedModelZoomActive(FLEET_MODEL_ALT_CEIL_M - 1, false), false,
    'just inside the fleet ceiling the tracked contact is still 2D');
});

test('enter and exit thresholds are ASYMMETRIC — the anti-flap band', () => {
  assert.equal(TRACKED_MODEL_EXIT_RATIO, 1.15);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, 172_500);
  assert.equal(TRACKED_MODEL_EXIT_ALT_M, TRACKED_MODEL_ENTER_ALT_M * TRACKED_MODEL_EXIT_RATIO,
    'the exit ceiling stays derived from enter, so retuning enter carries the band with it');
  assert.ok(TRACKED_MODEL_EXIT_ALT_M > TRACKED_MODEL_ENTER_ALT_M,
    'a single shared threshold is exactly the flapping bug this prevents');
});

test('the regime enters at the enter ceiling and leaves only past the exit ceiling', () => {
  // Coming in from far out: nothing below the enter ceiling → still 2D.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, false), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M, false), false,
    'the ceiling itself is still outside — the regime is strictly below it');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - 1, false), true);

  // Already inside: the model holds the visual all the way out to the exit ceiling.
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + 1, true), true,
    'crossing back over the ENTER ceiling must not hand back — that is the flap');
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M - 1, true), true);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M, true), false);
  assert.equal(trackedModelZoomActive(TRACKED_MODEL_EXIT_ALT_M + 1, true), false);
});

test('an orbit sitting AT the boundary never flaps', () => {
  // Simulate a camera loitering on the enter ceiling with orbital
  // wobble. Under a single threshold this alternates every sample.
  let active = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M - BAND_WIDTH_M / 4, false);
  assert.equal(active, true, 'the orbit begins inside the regime');
  let transitions = 0;
  for (let i = 0; i < 40; i++) {
    const wobble = (i % 2 === 0 ? 1 : -1) * (BAND_WIDTH_M / 8);
    const next = trackedModelZoomActive(TRACKED_MODEL_ENTER_ALT_M + wobble, active);
    if (next !== active) transitions++;
    active = next;
  }
  assert.equal(transitions, 0, 'the hysteresis band absorbs boundary wobble entirely');
  assert.equal(active, true);
});

test('a missing camera height reads as infinitely far out, never as "zoomed in"', () => {
  for (const height of [undefined, null, NaN, Infinity]) {
    assert.equal(trackedModelZoomActive(height, false), false);
    assert.equal(trackedModelZoomActive(height, true), false,
      'a torn-down viewer must not latch the model on');
  }
});

// ---------------------------------------------------------------------------
// 2. Wiring: both flight layers
// ---------------------------------------------------------------------------

const ICAO = 'abc123';

/** `stopTracking()` is the real deselect path, and it announces the clear on
 *  `window`. Give it somewhere to land so the test drives production code
 *  rather than a stand-in. */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { dispatchEvent() { return true; }, addEventListener() {}, removeEventListener() {} };
}

/** A viewer stub whose camera altitude the test can move between evaluations. */
function viewerAtHeight(height, { tilesLoaded = true, sampleHeight = () => undefined } = {}) {
  const tileset = { show: true, tilesLoaded };
  return {
    camera: {
      positionCartographic: { height },
      positionWC: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 5000),
      frustum: { fovy: Cesium.Math.toRadians(60) },
    },
    scene: {
      canvas: { clientHeight: 900 },
      frameState: { frameNumber: 1 },
      primitives: { length: 1, get() { return tileset; } },
      sampleHeight,
    },
    tileset,
    trackedEntity: undefined,
    entities: { remove() {} },
  };
}

/** A billboard with a real position, so the tracked-model driver has somewhere
 *  to put a model when it gets one (dead reckoning yields nothing without a
 *  fix history, and the driver falls back to this). */
function contactBillboard() {
  return {
    position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
    color: null,
    show: true,
    rotation: 0,
  };
}

/** Records what the driver hands to the scene, so a test can assert that a
 *  failing loader never put a model up. */
function recordingModelCollection() {
  const added = [];
  return { added, add(m) { added.push(m); }, remove() {}, isDestroyed() { return false; } };
}

const LAYERS = [
  {
    name: 'flights',
    layer: flightsLayer,
    regimeActive: flightsRegimeActive,
    driveTrackedModel: flightsDriveTrackedModel,
    driveFleetModel: flightsDriveFleetModel,
    ensureFleetModel: flightsEnsureFleetModel,
    trackedBillboardColor: flightsTrackedBillboardColor,
    bellyM: 6.719,
    seed({ viewer, tracked = true, icao24 = ICAO, modelCollection = null, onGround = false, models = [] }) {
      const billboard = contactBillboard();
      _setTrackedFlightRefreshStateForTest({
        icao24,
        entity: null,
        billboard,
        billboardCollection: { show: true, remove() {} },
        viewer,
        tracked,
        models,
        modelCollection,
        meta: { callsign: 'TEST123 ', altitude: 10_668, klass: 'airliner', onGround },
      });
      return billboard;
    },
  },
  {
    name: 'militaryFlights',
    layer: militaryFlightsLayer,
    regimeActive: militaryRegimeActive,
    driveTrackedModel: militaryDriveTrackedModel,
    driveFleetModel: militaryDriveFleetModel,
    ensureFleetModel: militaryEnsureFleetModel,
    trackedBillboardColor: militaryTrackedBillboardColor,
    bellyM: 5.631 * 0.8,
    seed({ viewer, tracked = true, icao24 = ICAO, modelCollection = null, onGround = false, models = [] }) {
      const billboard = contactBillboard();
      _setTrackedMilitaryRefreshStateForTest({
        icao24,
        entity: null,
        billboard,
        billboardCollection: { show: true, remove() {} },
        viewer,
        tracked,
        models,
        modelCollection,
        meta: { callsign: 'TEST123 ', altitudeFt: 35_000, klass: 'fastjet', onGround },
      });
      return billboard;
    },
  },
];

for (const fixture of LAYERS) {
  test(`${fixture.name}: production fleet loader admits a HIDDEN primitive and fails back to 2D`, async () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: true });

    const realFrom = Cesium.Model.fromGltfAsync;
    const viewer = viewerAtHeight(30_000, { tilesLoaded: false });
    const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);
    const loadedCollection = recordingModelCollection();
    const loadingModel = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: false,
      show: true,
      scale: 1,
      destroy() {},
    };

    try {
      const loadingIcao = fixture.name === 'flights' ? 'a0f201' : 'b0f201';
      Cesium.Model.fromGltfAsync = () => Promise.resolve(loadingModel);
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24: loadingIcao,
        onGround: true,
        modelCollection: loadedCollection,
      });
      const admitted = await fixture.ensureFleetModel(loadingIcao);
      assert.equal(admitted, loadingModel, 'the production fleet loader admits the resolved primitive');
      assert.equal(loadedCollection.added.length, 1, 'the production loader adds it once');
      assert.equal(loadingModel.ready, false);
      // Cesium 1.138's Model.update has no `show` guard — PrimitiveCollection
      // updates every member unconditionally and `_ready` flips in afterRender —
      // so hiding an admitted primitive costs its load nothing, and it is the
      // only thing that keeps Cesium's default show=true from claiming the
      // visual at the identity matrix before the first tick places it.
      assert.equal(loadingModel.show, false, 'admission hides the primitive until it is placed');
      assert.equal(loadingModel.scale, 1, 'and never touches its scale to do it');
      assert.equal(billboard.show, true, 'the 2D billboard owns the cold loading state');

      const nearby = fixture.layer.getNearby(billboard.position, 1_000, 50)
        .find((object) => object.icao24 === loadingIcao);
      assert.ok(nearby, 'fleet proximity retains the billboard-owned loading contact');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(nearby.position, billboard.position, 0, 1e-6),
        'fleet proximity stays at the billboard rather than the unplaced model');

      fixture.driveFleetModel({ icao24: loadingIcao, position, course: 92 });
      assert.equal(loadingModel.show, false);
      assert.equal(loadingModel.scale, 1);
      assert.equal(billboard.show, true, 'cold terrain preserves the same visible 2D owner');

      const failedIcao = fixture.name === 'flights' ? 'a0f202' : 'b0f202';
      const failedCollection = recordingModelCollection();
      Cesium.Model.fromGltfAsync = () => Promise.reject(new Error('simulated fleet GLB failure'));
      const failedBillboard = fixture.seed({
        viewer,
        tracked: false,
        icao24: failedIcao,
        onGround: true,
        modelCollection: failedCollection,
      });
      const failedModel = await fixture.ensureFleetModel(failedIcao);
      assert.equal(failedModel, null, 'a rejected fleet GLB is never admitted');
      assert.equal(failedCollection.added.length, 0);
      assert.equal(failedBillboard.show, true,
        'fleet load rejection leaves the 2D owner visible');
      assert.ok(fixture.layer.getNearby(failedBillboard.position, 1_000, 50)
        .some((object) => object.icao24 === failedIcao),
      'fleet load rejection leaves the contact in the billboard proximity cohort');
    } finally {
      Cesium.Model.fromGltfAsync = realFrom;
      fixture.layer.setParams({ models3d: false });
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: grounded fleet handoff waits through terrain load and keeps one visual owner`, () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();

    const realNow = Date.now;
    let now = 4_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    const sampledHeight = 187.5;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: false,
      sampleHeight: () => { sampleCalls++; return sampledHeight; },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f101' : 'b0f101';
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: true,
      show: true,
    };
    const position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);

    try {
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24,
        onGround: true,
        models: [[icao24, model]],
      });
      billboard.show = false;

      let ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, false, 'cold terrain cannot transfer ownership to 3D');
      assert.equal(model.show, false, 'the ready primitive is hidden until ground resolves');
      assert.equal(billboard.show, true, 'the 2D contact returns in the same handoff turn');
      assert.ok(model.show || billboard.show, 'the contact never has both visuals hidden');
      assert.equal(sampleCalls, 0, 'cold tiles do not force sampleHeight');

      now += 1000;
      viewer.tileset.tilesLoaded = true;
      ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, false, 'the miss backoff remains in force before two seconds');
      assert.equal(sampleCalls, 0, 'backoff prevents an early synchronous sample');
      assert.ok(model.show || billboard.show, 'backoff still leaves a visible owner');

      now += 1500;
      ownsVisual = fixture.driveFleetModel({ icao24, position, course: 92 });
      assert.equal(ownsVisual, true, 'the model takes over after a valid terrain sample');
      assert.equal(sampleCalls, 1, 'the settled terrain is sampled exactly once');
      assert.equal(model.show, true);
      assert.equal(billboard.show, false);
      assert.ok(model.show || billboard.show, 'successful handoff keeps a visible owner');
      const placed = Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3());
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `placement uses the exact ${fixture.bellyM} m asset-measured belly offset`);

      viewer.tileset.tilesLoaded = false;
      const datumShifted = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({ icao24, position: datumShifted, course: 92 });
      assert.equal(ownsVisual, true,
        'a poll-time vertical datum change does not invalidate a stationary snap');
      assert.equal(sampleCalls, 1, 'the height-normalized cache does not resample vertically');
      assert.ok(model.show || billboard.show, 'datum transition keeps a visible owner');

      // Taxi past the 50 m resample threshold while the tiles are gone. The old
      // snap stops being the direct answer, but it is still a MEASUREMENT of
      // ground this contact was standing on ~96 m ago, so it is held: hiding the
      // model here would pop a taxiing aircraft from 3D to 2D for a whole retry
      // backoff (2–30 s), which is the one thing the gate must not introduce.
      const taxied = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      ownsVisual = fixture.driveFleetModel({ icao24, position: taxied, course: 92 });
      assert.equal(ownsVisual, true,
        'a taxi-invalidated snap is HELD through the resample outage, not dropped');
      assert.equal(model.show, true, 'no 3D→2D pop while the resample is backing off');
      assert.equal(billboard.show, false);
      assert.equal(sampleCalls, 1, 'and the hold costs no extra synchronous sample');
      const held = Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3());
      assert.ok(Math.abs(Cesium.Cartographic.fromCartesian(held).height
        - (sampledHeight + fixture.bellyM)) < 0.001,
      'the hold places the model on the last MEASURED floor, not on the feed altitude');

      // Past the drift bound the memory stops describing anywhere this contact
      // has been, so it is dropped rather than stretched and the gate takes over.
      const farTaxied = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500); // ~289 m out
      ownsVisual = fixture.driveFleetModel({ icao24, position: farTaxied, course: 92 });
      assert.equal(ownsVisual, false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld');
      assert.equal(model.show, false);
      assert.equal(billboard.show, true);
      assert.ok(model.show || billboard.show, 'release returns atomically to 2D');

      const failedIcao = fixture.name === 'flights' ? 'a0f102' : 'b0f102';
      const failedBillboard = fixture.seed({
        viewer,
        tracked: false,
        icao24: failedIcao,
        onGround: true,
        models: [],
      });
      failedBillboard.show = false;
      ownsVisual = fixture.driveFleetModel({
        icao24: failedIcao,
        position,
        course: 92,
      });
      assert.equal(ownsVisual, false, 'a missing/failed model never claims ownership');
      assert.equal(failedBillboard.show, true, 'load failure keeps the billboard visible');
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: a held snap is dropped when measured ground contradicts it`, () => {
    // Adversarial review 2026-08-23, reproduced verbatim. The drift bound asks
    // "how far has the contact travelled", which is only a PROXY for "does this
    // value still describe the ground here" — and 202 m of taxi onto a surface
    // 30 m higher fits inside it. Because a miss PRESERVES the hold, nothing in
    // the retry path corrects that: the model stays buried for as long as the
    // resample keeps missing, which on the OSM fallback is forever.
    //
    // A at 120 m → taxi 202 m to B, whose measured skin is 150 m → resample
    // misses. The held 120 m must NOT be used to place a model at B.
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: false });
    _clearMeshFloorCellsForTest();

    const realNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    let sampled = 120;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: true,
      sampleHeight: () => { sampleCalls++; return sampled; },
    });
    const icao24 = fixture.name === 'flights' ? 'a0f103' : 'b0f103';
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: true,
      show: true,
    };
    /** Height (m) the model's matrix currently places it at. */
    const placedHeightM = () => Cesium.Cartographic.fromCartesian(
      Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3()),
    ).height;

    const LAT = 30.21;
    const A_LON = -97.71;
    // ~202 m east at this latitude: past MOVE_INVALIDATE_M (50 m) so the snap is
    // demoted, and INSIDE HELD_SNAP_MAX_DRIFT_M (250 m) so the bound alone does
    // not catch it — that is the whole point of the repro.
    const B_LON = -97.7079;
    const B_GROUND_M = 150;

    try {
      const billboard = fixture.seed({
        viewer,
        tracked: false,
        icao24,
        onGround: true,
        models: [[icao24, model]],
      });
      billboard.show = false;

      const atA = Cesium.Cartesian3.fromDegrees(A_LON, LAT, 0);
      const atB = Cesium.Cartesian3.fromDegrees(B_LON, LAT, 0);
      const taxiM = Cesium.Cartesian3.distance(
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atA, new Cesium.Cartesian3()),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atB, new Cesium.Cartesian3()),
      );
      assert.ok(taxiM > 50 && taxiM < 250,
        `the repro must sit INSIDE the drift bound to be a repro (taxi ${taxiM.toFixed(1)} m)`);

      // A: the snap resolves and the model takes the visual.
      let ownsVisual = fixture.driveFleetModel({ icao24, position: atA, course: 92 });
      assert.equal(ownsVisual, true, 'a measured snap at A hands the visual to the model');
      assert.equal(sampleCalls, 1);
      assert.ok(Math.abs(placedHeightM() - (sampled + fixture.bellyM)) < 0.001,
        'the model stands on the measured 120 m at A');

      // Something measures B's surface — the mesh-floor cells the billboard
      // chain and meshFloorSampler share. This is the fresh evidence.
      reportMeshFloorCell(LAT, B_LON, B_GROUND_M);

      // B, with the resample missing: tiles gone, so no sample can land.
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atB, course: 92 });
      assert.equal(sampleCalls, 1, 'the missing resample fires no new sample');
      assert.equal(ownsVisual, false,
        'a held measurement contradicted by measured ground must not place the model');
      assert.equal(model.show, false, 'nothing is drawn 30 m under the apron');
      assert.equal(billboard.show, true, 'the floored 2D billboard is the honest fallback');
      assert.ok(model.show || billboard.show, 'the release is atomic — never both hidden');

      // "If the contact remains at B, misses can preserve that burial forever."
      // They cannot: the hold is gone, so every later miss re-answers COLD.
      for (let i = 0; i < 5; i++) {
        now += 60_000;
        assert.equal(fixture.driveFleetModel({ icao24, position: atB, course: 92 }), false,
          'repeated misses must not resurrect the dropped hold');
        assert.equal(model.show, false);
      }

      // And when evidence does arrive, it is B's ground the model stands on.
      sampled = B_GROUND_M;
      viewer.tileset.tilesLoaded = true;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atB, course: 92 });
      assert.equal(ownsVisual, true, 'a fresh sample at B restores the model');
      assert.equal(sampleCalls, 2);
      assert.ok(Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        "the restored model stands on B's 150 m, not on the stale 120 m");

      // The rule is ONE-SIDED, and this is the half that keeps it useful. Roll
      // on to C, where the measured cell reads BELOW the held value, and let the
      // resample miss again. A cell under a real sample is the floor chain's
      // expected error — cells latch once over ~111 m, borrowed neighbours lean
      // lowest, the display clamp only ever raises — so it is not evidence of
      // burial and must NOT cost the contact its model. A two-sided rule fails
      // here, and did: on the track-regression rig a planted cell sat 66.7 m
      // below a real sample at the same spot.
      const C_LON = -97.7064; // ~144 m further on, still inside the drift bound
      const atC = Cesium.Cartesian3.fromDegrees(C_LON, LAT, 0);
      const rollM = Cesium.Cartesian3.distance(
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atB, new Cesium.Cartesian3()),
        Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(atC, new Cesium.Cartesian3()),
      );
      assert.ok(rollM > 50 && rollM < 250,
        `the downhill leg must also sit inside the bound (roll ${rollM.toFixed(1)} m)`);
      reportMeshFloorCell(LAT, C_LON, B_GROUND_M - 50); // measured LOWER than the hold
      viewer.tileset.tilesLoaded = false;
      now += 60_000;
      ownsVisual = fixture.driveFleetModel({ icao24, position: atC, course: 92 });
      assert.equal(ownsVisual, true,
        'a cell reading BELOW the hold is the floor chain under-reading, not burial — the hold stands');
      assert.equal(model.show, true, 'the contact keeps its model through a downhill taxi');
      assert.ok(Math.abs(placedHeightM() - (B_GROUND_M + fixture.bellyM)) < 0.001,
        'and it keeps standing on the measurement it actually has');
    } finally {
      Date.now = realNow;
      fixture.layer.stopTracking();
      _clearMeshFloorCellsForTest();
    }
  });

  test(`${fixture.name}: grounded tracked model waits for a valid terrain snap with no visual gap`, async () => {
    clearTr3bRegistry();
    fixture.layer.stopTracking();
    fixture.layer.setParams({ models3d: false });

    const realFrom = Cesium.Model.fromGltfAsync;
    const realNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    let sampleCalls = 0;
    let sampledHeight = undefined;
    const viewer = viewerAtHeight(30_000, {
      tilesLoaded: false,
      sampleHeight: () => { sampleCalls++; return sampledHeight; },
    });
    const collection = recordingModelCollection();
    const model = {
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      ready: false,
      show: true,
      scale: 1,
      destroy() {},
    };
    Cesium.Model.fromGltfAsync = () => Promise.resolve(model);

    try {
      const billboard = fixture.seed({
        viewer,
        modelCollection: collection,
        onGround: true,
        icao24: fixture.name === 'flights' ? 'a0f001' : 'b0f001',
      });

      fixture.driveTrackedModel();
      await Promise.resolve(); await Promise.resolve();
      assert.equal(collection.added.length, 1, 'the loaded primitive enters the scene once');
      assert.equal(model.ready, false, 'the production loader is still awaiting GPU readiness');
      assert.equal(model.show, false, 'the loading primitive is admitted hidden, not zero-scaled');
      assert.equal(model.scale, 1, 'its scale is left to the pixel-cap driver');
      assert.equal(fixture.trackedBillboardColor().alpha, 1,
        'the tracked billboard remains opaque while the model lacks safe placement');
      assert.equal(sampleCalls, 0, 'cold tiles do not force a synchronous sample');
      const loadingDetection = fixture.layer.getDetectableObjects({ maxCount: 50 })
        .find((object) => object.sourceId === (fixture.name === 'flights' ? 'a0f001' : 'b0f001'));
      assert.ok(loadingDetection, 'the tracked billboard remains detectable while its model loads');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(
        loadingDetection.position,
        billboard.position,
        0,
        1e-6,
      ), 'a hidden tracked model cannot steal the detection anchor');
      billboard.show = false; // tracking hides the fleet sprite; the tracked entity remains the 2D owner
      const loadingNearby = fixture.layer.getNearby(billboard.position, 1_000, 50)
        .find((object) => object.icao24 === (fixture.name === 'flights' ? 'a0f001' : 'b0f001'));
      assert.ok(loadingNearby, 'the tracked contact remains in proximity while its model loads');
      assert.ok(Cesium.Cartesian3.equalsEpsilon(
        loadingNearby.position,
        billboard.position,
        0,
        1e-6,
      ), 'a hidden tracked model cannot steal the proximity position');

      now += 1000;
      viewer.tileset.tilesLoaded = true;
      sampledHeight = 187.5;
      fixture.driveTrackedModel();
      assert.equal(sampleCalls, 0, 'the tracked path honors the same retry backoff before sampling');
      assert.equal(model.show, false, 'retry backoff keeps the unplaced primitive hidden');
      assert.equal(fixture.trackedBillboardColor().alpha, 1,
        'retry backoff leaves the tracked billboard opaque');

      now += 1500;
      fixture.driveTrackedModel();
      assert.equal(sampleCalls, 1, 'the first settled turn samples once');
      assert.equal(model.show, false, 'terrain alone does not reveal an unready model');
      assert.equal(fixture.trackedBillboardColor().alpha, 1,
        'the billboard retains ownership until GPU readiness too');

      model.ready = true;
      fixture.driveTrackedModel();
      assert.equal(model.show, true, 'the model appears only after its snapped matrix is written');
      assert.equal(fixture.trackedBillboardColor().alpha, 0,
        'the billboard becomes transparent only when the model actually owns the visual');
      const placed = Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3());
      const placedHeight = Cesium.Cartographic.fromCartesian(placed).height;
      assert.ok(Math.abs(placedHeight - (sampledHeight + fixture.bellyM)) < 0.001,
        `tracked placement uses the exact ${fixture.bellyM} m asset-measured belly offset`);

      viewer.tileset.tilesLoaded = false;
      sampledHeight = undefined;
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, true,
        'a successful cached snap survives a poll-time vertical datum change');
      assert.equal(sampleCalls, 1,
        'a stationary vertical-only change does not consume another terrain sample');

      // Taxi past the resample threshold with the tiles gone: the tracked model
      // holds its last measured floor rather than handing the operator's own
      // selection back to a 2D glyph for a retry backoff.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.709, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, true,
        'a taxi-invalidated tracked snap is HELD through the resample outage');
      assert.equal(fixture.trackedBillboardColor().alpha, 0,
        'the model still owns the visual, so the billboard stays transparent');
      assert.equal(sampleCalls, 1, 'the hold costs no extra synchronous sample');

      // Past the drift bound the memory is released and the gate takes over.
      billboard.position = Cesium.Cartesian3.fromDegrees(-97.707, 30.21, -500);
      fixture.driveTrackedModel();
      assert.equal(model.show, false,
        'past HELD_SNAP_MAX_DRIFT_M the hold is released and the model is withheld');
      assert.equal(fixture.trackedBillboardColor().alpha, 1,
        'there is no invisible-owner gap while the replacement snap is unavailable');
    } finally {
      Cesium.Model.fromGltfAsync = realFrom;
      Date.now = realNow;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the tracked contact goes 3D with the fleet 3D toggle OFF`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    assert.equal(fixture.layer.getParams().models3d, false, 'the fleet toggle really is off');

    // Zoomed out past the ceiling → the billboard still owns the visual.
    fixture.seed({ viewer: viewerAtHeight(INSIDE_BAND_M) });
    assert.equal(fixture.regimeActive(), false);

    // Zoom in past the ceiling → the model takes over, toggle untouched.
    fixture.seed({ viewer: viewerAtHeight(WELL_INSIDE_M) });
    assert.equal(fixture.regimeActive(), true,
      'zoom-driven 2D↔3D is DEFAULT for the tracked contact');
    assert.equal(fixture.layer.getParams().models3d, false,
      'and it never arms the fleet toggle as a side effect');
  });

  test(`${fixture.name}: the tracked regime is hysteretic across a live zoom in/out`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(FAR_OUTSIDE_M);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), false, 'starts far out, in 2D');

    // Zoom in through the boundary.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true, '3D at the enter ceiling');

    // Drift back over the ENTER ceiling — must HOLD (this is the flap guard).
    viewer.camera.positionCartographic.height = INSIDE_BAND_M;
    assert.equal(fixture.regimeActive(), true, 'the exit band holds the model');

    // Zoom all the way back out — the billboard returns.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_EXIT_ALT_M + 1;
    assert.equal(fixture.regimeActive(), false, 'past the exit ceiling, 2D returns');

    // And a second round trip behaves identically (no stuck latch).
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true);
    viewer.camera.positionCartographic.height = TRACKED_MODEL_EXIT_ALT_M + 1;
    assert.equal(fixture.regimeActive(), false);
  });

  test(`${fixture.name}: deselect + re-track the SAME contact re-enters at the ENTER ceiling`, () => {
    // The regression this pins: a deselect followed by a same-turn re-track of
    // the SAME icao (Contacts re-entry, a cross-layer round trip back to this
    // layer) never makes `_trackedIcao` observably change, so the predicate's
    // icao-change guard never fires. The reset therefore has to live in the
    // PRODUCTION teardown — which is why nothing below touches a test-only
    // latch reset; the seam re-seeds state but deliberately leaves the latches
    // alone, and `stopTracking()` is the real deselect path.
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });

    // Latch the regime on close in...
    const viewer = viewerAtHeight(TRACKED_MODEL_ENTER_ALT_M - 1);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true);

    // ...drift into the hysteresis band, where the model legitimately holds.
    viewer.camera.positionCartographic.height = INSIDE_BAND_M;
    assert.equal(fixture.regimeActive(), true, 'the ORIGINAL selection still holds in the band');

    // Deselect through the production path, then re-track the SAME contact.
    fixture.layer.stopTracking();
    fixture.seed({ viewer }); // same icao, still inside the band
    assert.equal(fixture.regimeActive(), false,
      'a re-tracked contact must pass the ENTER ceiling again, not inherit the exit band');

    // And it still enters normally once actually zoomed in.
    viewer.camera.positionCartographic.height = TRACKED_MODEL_ENTER_ALT_M - 1;
    assert.equal(fixture.regimeActive(), true);
    fixture.layer.stopTracking();
  });

  test(`${fixture.name}: a converted TR-3B never takes the model, at any zoom`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(1); // as zoomed in as it gets
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true, 'control: an unconverted contact does model');

    setTr3b(ICAO, true);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), false,
      'there is no TR-3B GLB — the triangle billboard stays the visual all the way in');

    setTr3b(ICAO, false);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true, 'un-converting restores the handoff');
    clearTr3bRegistry();
  });

  test(`${fixture.name}: deselecting drops the regime even zoomed all the way in`, () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });
    const viewer = viewerAtHeight(1);
    fixture.seed({ viewer });
    assert.equal(fixture.regimeActive(), true);

    fixture.seed({ viewer, tracked: false }); // nothing selected
    assert.equal(fixture.regimeActive(), false,
      'with no selection there is no tracked model to own the visual');
  });

  test(`${fixture.name}: turning the fleet toggle ON does not disturb the tracked regime`, () => {
    clearTr3bRegistry();
    const viewer = viewerAtHeight(WELL_INSIDE_M);
    fixture.seed({ viewer });
    fixture.layer.setParams({ models3d: true });
    assert.equal(fixture.regimeActive(), true);
    fixture.layer.setParams({ models3d: false });
    assert.equal(fixture.regimeActive(), true,
      'the fleet toggle owns the FLEET; the selected contact is independent of it');
  });
}

// ---------------------------------------------------------------------------
// 3. Bounded on-demand loading
//
// The tracked regime is default-on and its driver runs every scene.preUpdate.
// A missing or corrupt GLB — or a dead network — used to leave the driver in a
// load→reject loop at frame rate for as long as the contact stayed selected,
// because the catch cleared only the in-flight flag. These pin the bound.
// ---------------------------------------------------------------------------

/** Drive N frames of the production tracked-model driver, letting each
 *  rejected load settle, with a fake clock the backoff can be walked past. */
async function driveFrames(fixture, count, clock) {
  for (let i = 0; i < count; i++) {
    fixture.driveTrackedModel();
    await Promise.resolve(); await Promise.resolve(); // let the rejection settle
    clock.advance(2000); // past the retry backoff, so only the LATCH can stop it
  }
}

for (const fixture of LAYERS) {
  test(`${fixture.name}: a rejecting GLB loader is bounded, not a per-frame retry loop`, async () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });

    const realFrom = Cesium.Model.fromGltfAsync;
    const realNow = Date.now;
    let now = 1_000_000;
    const clock = { advance(ms) { now += ms; } };
    Date.now = () => now;
    let attempts = 0;
    const requested = [];
    Cesium.Model.fromGltfAsync = ({ url }) => {
      attempts++; requested.push(url);
      return Promise.reject(new Error('simulated missing GLB'));
    };
    // The give-up path warns once by design; keep the run's output clean.
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };

    try {
      const collection = recordingModelCollection();
      const viewer = viewerAtHeight(30_000); // well inside the regime
      const billboard = fixture.seed({ viewer, modelCollection: collection });
      assert.equal(fixture.regimeActive(), true, 'the regime is open, so the driver will try to load');

      await driveFrames(fixture, 12, clock);
      const settled = attempts;
      assert.ok(settled > 0, 'it must actually try');
      assert.ok(settled <= 3,
        `a failing asset must give up within 3 attempts per selection, got ${settled}`);

      // Many more frames must produce NO further attempts — this is the loop bound.
      await driveFrames(fixture, 25, clock);
      assert.equal(attempts, settled,
        'once latched, further frames must not re-ask for the same failed asset');

      // Nothing was ever handed to the scene, so the billboard stayed the visual.
      assert.equal(collection.added.length, 0, 'a failed load never puts a model up');
      assert.equal(fixture.trackedBillboardColor().alpha, 1,
        'a rejected tracked model leaves the tracked billboard opaque');
      assert.equal(billboard.show, true,
        'a rejected model never creates a frame with both visual representations hidden');

      // Exactly one operator-facing warning, and it names the asset.
      assert.equal(warnings.length, 1, 'the give-up is announced once, not per frame');
      assert.ok(warnings[0].includes(requested[0]), `the warning names the asset: ${warnings[0]}`);

      // A NEW selection gets a fresh budget — the latch is per contact.
      fixture.layer.stopTracking();
      fixture.seed({ viewer, icao24: 'def456', modelCollection: collection });
      await driveFrames(fixture, 3, clock);
      assert.ok(attempts > settled, 'selecting another contact restores the retry budget');
    } finally {
      Cesium.Model.fromGltfAsync = realFrom;
      Date.now = realNow;
      console.warn = realWarn;
      fixture.layer.stopTracking();
    }
  });

  test(`${fixture.name}: the failure latch clears on a same-icao re-track too`, async () => {
    clearTr3bRegistry();
    fixture.layer.setParams({ models3d: false });

    const realFrom = Cesium.Model.fromGltfAsync;
    const realNow = Date.now;
    const realWarn = console.warn;
    let now = 2_000_000;
    const clock = { advance(ms) { now += ms; } };
    Date.now = () => now;
    let attempts = 0;
    Cesium.Model.fromGltfAsync = () => { attempts++; return Promise.reject(new Error('simulated missing GLB')); };
    console.warn = () => {};

    try {
      const collection = recordingModelCollection();
      const viewer = viewerAtHeight(30_000);
      fixture.seed({ viewer, modelCollection: collection });
      await driveFrames(fixture, 12, clock);
      const latched = attempts;
      await driveFrames(fixture, 10, clock);
      assert.equal(attempts, latched, 'latched for this selection');

      // Deselect and re-select the SAME contact through the production path.
      fixture.layer.stopTracking();
      fixture.seed({ viewer, modelCollection: collection });
      await driveFrames(fixture, 3, clock);
      assert.ok(attempts > latched,
        're-tracking the same contact is a new selection and gets its retries back');
    } finally {
      Cesium.Model.fromGltfAsync = realFrom;
      Date.now = realNow;
      console.warn = realWarn;
      fixture.layer.stopTracking();
    }
  });
}

test('both layers gate the tracked-model load and record its failures', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.match(source, /!_trackedModel && !_trackedModelLoading && _trackedModelLoadAllowed\(\)/,
      `${name}: the driver asks permission before starting another tracked-model load`);
    assert.match(source, /_noteTrackedModelLoadFailure\(trackedSpec\.url, err\)/,
      `${name}: a rejected load is recorded against this selection, not silently retried`);
    // The reset must be reachable from the real teardown, not only a test seam.
    assert.match(source, /_releaseTrackedModel\(\);\n  _resetTrackedSelectionState\(\);/,
      `${name}: deselect clears the per-selection latches in the production path`);
    assert.match(source, /_trackedIcao = icao24;\n  _resetTrackedSelectionState\(\);/,
      `${name}: selecting a contact starts from a clean per-selection state`);
  }
});

test('the tracked regime never consults the fleet models3d toggle', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['flights.js', 'militaryFlights.js']) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    const regime = /function _trackedModelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.ok(regime, `${name}: _trackedModelRegimeActive is defined`);
    assert.doesNotMatch(regime, /_models3dEnabled|_modelRegimeActive\(\)/,
      `${name}: the tracked contact's handoff is default-on, not gated on the fleet toggle`);
    assert.match(regime, /trackedModelZoomActive\(/,
      `${name}: the tracked contact uses the shared hysteretic zoom policy`);
    // The FLEET must still obey the toggle — the budget decision stays the operator's.
    const fleet = /function _modelRegimeActive\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    assert.match(fleet, /if \(!_models3dEnabled\) return false;/,
      `${name}: the fleet regime still obeys the DISPLAY-rail 3D toggle`);
  }
});
