// src/data/nearbyModelHandoff.test.mjs
//
// `getNearby()` is the proximity seam behind the Context/Contacts cohort counts
// and the voice framing tools. It used to admit contacts on billboard
// visibility alone, so every plane the fleet 3D-model handoff had taken over
// (billboard hidden, model shown) silently dropped out of the results and the
// counts flapped to zero. The guard now mirrors the sibling
// `getDetectableObjects()` in each layer: a contact stays nearby while EITHER
// visual owns it, and a contact nothing is drawing for stays excluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import flightsLayer, { _setTrackedFlightRefreshStateForTest } from './flights.js';
import militaryFlightsLayer, { _setTrackedMilitaryRefreshStateForTest } from './militaryFlights.js';

const ICAO = 'abc123';
const OTHER = 'def456';
/** ~10.6 km from the seeded contact — well inside the query range either way. */
const CENTER = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 200);
const RANGE_M = 250_000;
const MODEL_POSITION = Cesium.Cartesian3.fromDegrees(-97.69, 30.22, 10_900);
const MODEL_ROTATION = Cesium.Matrix3.fromRotationZ(Math.PI / 2);
const COMPUTED_SCALE = 7;

function contactBillboard(show) {
  return {
    position: Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668),
    color: Cesium.Color.WHITE,
    show,
  };
}

function contactViewer() {
  return { camera: { positionCartographic: null }, scene: {} };
}

const LAYERS = [
  {
    name: 'commercial',
    layer: flightsLayer,
    visualCenterM: Cesium.Cartesian3.ZERO,
    seed({ billboardShow, models = [] }) {
      _setTrackedFlightRefreshStateForTest({
        icao24: ICAO,
        entity: null,
        billboard: contactBillboard(billboardShow),
        billboardCollection: { show: true, remove() {} },
        viewer: contactViewer(),
        tracked: false,
        models,
        meta: {
          callsign: `${ICAO.toUpperCase()} `,
          altitude: 10_668,
          klass: 'airliner',
          onGround: false,
        },
      });
    },
  },
  {
    name: 'military',
    layer: militaryFlightsLayer,
    visualCenterM: Cesium.Cartesian3.ZERO,
    seed({ billboardShow, models = [] }) {
      _setTrackedMilitaryRefreshStateForTest({
        icao24: ICAO,
        entity: null,
        billboard: contactBillboard(billboardShow),
        billboardCollection: { show: true, remove() {} },
        viewer: contactViewer(),
        tracked: false,
        models,
        meta: {
          callsign: `${ICAO.toUpperCase()} `,
          altitudeFt: 35_000,
          klass: 'fighter',
          onGround: false,
        },
      });
    },
  },
];

/** ICAO24 identities the layer reports as nearby the fixed center. */
function nearbyIcaos(layer) {
  return layer.getNearby(CENTER, RANGE_M, 50).map((contact) => contact.icao24);
}

/** Detection position for the shared fixture contact. */
function detectionPosition(layer) {
  return layer.getDetectableObjects({ maxCount: 50 })
    .find((contact) => contact.sourceId === ICAO)?.position || null;
}

for (const fixture of LAYERS) {
  test(`${fixture.name} getNearby keeps the exact contact whose 3D model owns the visual`, () => {
    // The handoff state: the fleet tick hid the sprite and showed the model.
    fixture.seed({
      billboardShow: false,
      models: [[ICAO, { ready: true, show: true, _gevPlacementReady: true }]],
    });
    assert.ok(
      nearbyIcaos(fixture.layer).includes(ICAO),
      'a model-owned contact must stay in the proximity cohort',
    );

    // A model belonging to a DIFFERENT aircraft must not rescue this one.
    fixture.seed({ billboardShow: false, models: [[OTHER, { show: true }]] });
    assert.ok(
      !nearbyIcaos(fixture.layer).includes(ICAO),
      'the model lookup must be keyed to the contact, not to any shown model',
    );
  });

  test(`${fixture.name} getNearby still drops a contact nothing is drawing`, () => {
    // Positive control: the same contact IS reachable when its sprite shows,
    // so the exclusions below cannot pass for an unrelated reason.
    fixture.seed({ billboardShow: true });
    assert.ok(nearbyIcaos(fixture.layer).includes(ICAO), 'a shown sprite is nearby');

    fixture.seed({ billboardShow: false });
    assert.ok(
      !nearbyIcaos(fixture.layer).includes(ICAO),
      'a hidden sprite with no model must stay excluded',
    );

    fixture.seed({ billboardShow: false, models: [[ICAO, { show: false }]] });
    assert.ok(
      !nearbyIcaos(fixture.layer).includes(ICAO),
      'a released (hidden) model must not resurrect a hidden contact',
    );

    fixture.seed({
      billboardShow: false,
      models: [[ICAO, {
        ready: false,
        show: true,
        scale: 0,
        _gevPlacementReady: false,
      }]],
    });
    assert.ok(
      !nearbyIcaos(fixture.layer).includes(ICAO),
      'a zero-scale loading model cannot claim proximity ownership',
    );
  });

  test(`${fixture.name} detection follows the visible 2D sprite and 3D model anchors`, () => {
    fixture.seed({ billboardShow: true });
    const spritePosition = detectionPosition(fixture.layer);
    assert.ok(spritePosition, 'the 2D sprite publishes a detection candidate');
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(spritePosition, contactBillboard(true).position, 0, 1e-6),
      'the 2D bracket stays welded to the billboard position',
    );

    const modelMatrix = Cesium.Matrix4.fromRotationTranslation(MODEL_ROTATION, MODEL_POSITION);
    fixture.seed({
      billboardShow: false,
      models: [[ICAO, {
        ready: true,
        show: true,
        _gevPlacementReady: true,
        modelMatrix,
        computedScale: COMPUTED_SCALE,
      }]],
    });
    const modelPosition = detectionPosition(fixture.layer);
    assert.ok(modelPosition, 'the 3D model publishes the same detection candidate');
    const expectedVisualCenter = Cesium.Matrix4.multiplyByPoint(
      modelMatrix,
      Cesium.Cartesian3.multiplyByScalar(
        fixture.visualCenterM,
        COMPUTED_SCALE,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(modelPosition, expectedVisualCenter, 0, 1e-6),
      'the 3D bracket stays on the normalized model origin at any rendered scale',
    );
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(modelPosition, MODEL_POSITION, 0, 1e-6),
      'origin-centred GLBs keep the bracket welded to the modelMatrix translation',
    );

    fixture.seed({
      billboardShow: true,
      models: [[ICAO, {
        ready: false,
        show: true,
        scale: 0,
        _gevPlacementReady: false,
        modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      }]],
    });
    const loadingPosition = detectionPosition(fixture.layer);
    assert.ok(loadingPosition, 'the billboard remains detectable while its model loads');
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(loadingPosition, contactBillboard(true).position, 0, 1e-6),
      'a shown-but-unready zero-scale model cannot steal the detection anchor',
    );
  });
}
