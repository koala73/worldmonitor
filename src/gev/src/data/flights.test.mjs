// src/data/flights.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import flightsLayer, {
  _addFlightTrackingCandidateForTest,
  _applyPendingFlightTrackingRestoreForTest,
  _armFlightTrackingRestoreForTest,
  _militaryLayerSuppressesForTest,
  _pendingFlightTrackingRestoreForTest,
  _setFlightTrackingRefreshOutcomeForTest,
  _setTrackedFlightRefreshStateForTest,
  _floorGroundedDisplayPositionForTest,
  _clearDisplayFloorStateForTest,
  mapAnalystRecord,
} from './flights.js';
import { setMilitaryLayerActive } from './militaryRegistry.js';
import {
  GROUND_FLOOR_LIFT_M, reportMeshFloorCell,
  setMeshFloorPreferred, _clearMeshFloorCellsForTest,
} from './groundFloor.js';
import {
  _setTrackedOverlayHostForTest,
  destroyTrackedReadout,
  initTrackedReadout,
} from './trackedReadout.js';

test('share-Follow absence requires an accepted OpenSky snapshot', async () => {
  _setFlightTrackingRefreshOutcomeForTest({ status: 'source-unavailable' });
  assert.equal(
    (await flightsLayer.resolveTrackingRestoreTarget('abc123')).status,
    'source-unavailable',
  );
  _setFlightTrackingRefreshOutcomeForTest({ status: 'accepted', ids: ['different'] });
  const missing = await flightsLayer.resolveTrackingRestoreTarget('abc123');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reason, 'target-absent-from-snapshot');
});

const FULL_INFO = {
  callsign: 'SWA696  ',
  rawLat: 30.1945,
  rawLon: -97.6699,
  altitude: 1234.5,
  velocity: 210.2,
  true_track: 187.4,
  verticalRate: -4.5,
  onGround: false,
  klass: 'airliner',
  originCountry: 'United States',
  airline: 'Southwest Airlines',
  route: { origin: { code: 'AUS' }, destination: { code: 'LAX' } },
};

test('flights analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord('a1b2c3', FULL_INFO, { military: false, routeOk: true });
  assert.deepEqual(r, {
    id: 'SWA696',
    icao24: 'a1b2c3',
    callsign: 'SWA696',
    lat: 30.1945,
    lon: -97.6699,
    altitudeM: 1234.5,
    speedMps: 210.2,
    heading: 187.4,
    verticalRateMps: -4.5,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    originCountry: 'United States',
    operator: 'Southwest Airlines',
    routeOrigin: 'AUS',
    routeDestination: 'LAX',
  });
});

test('flights analyst record: implausible route is suppressed (routeOk=false)', () => {
  const r = mapAnalystRecord('a1b2c3', FULL_INFO, { routeOk: false });
  assert.equal(r.routeOrigin, null);
  assert.equal(r.routeDestination, null);
});

test('flights analyst record: empty info yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord('abc123', undefined);
  assert.equal(r.id, 'abc123'); // callsign fallback
  assert.equal(r.callsign, null);
  assert.equal(r.onGround, false);
  assert.equal(r.military, false);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('flights analyst record: no callsign falls back to registration, then icao24', () => {
  const r = mapAnalystRecord('abc123', { ...FULL_INFO, callsign: '   ' });
  assert.equal(r.id, 'abc123'); // FULL_INFO carries no registration
  assert.equal(r.callsign, null);
  assert.equal(mapAnalystRecord('abc123', { ...FULL_INFO, callsign: '', registration: 'N123AB' }).id, 'N123AB');
  assert.equal(mapAnalystRecord('abc123', { callsign: '', registration: ' ' }).id, 'abc123');
});

test('flights analyst record: NaN kinematics become null, military flag passes through', () => {
  const r = mapAnalystRecord('ae01ce', {
    ...FULL_INFO, velocity: NaN, true_track: undefined, verticalRate: null,
  }, { military: true });
  assert.equal(r.speedMps, null);
  assert.equal(r.heading, null);
  assert.equal(r.verticalRateMps, null);
  assert.equal(r.military, true);
});

test('flights analyst record: output is JSON-safe (no Cesium types)', () => {
  const r = mapAnalystRecord('a1b2c3', FULL_INFO, { routeOk: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('flights first update forwards caller cancellation into the feed request', async () => {
  const realFetch = globalThis.fetch;
  let observedSignal = null;
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    options.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const controller = new AbortController();
    const work = flightsLayer.update({ camera: { positionCartographic: null }, scene: {} }, {
      signal: controller.signal,
    });
    await Promise.resolve();
    assert.ok(observedSignal);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nonempty OpenSky payload with zero usable rows cannot prove share target absence', async () => {
  _setTrackedFlightRefreshStateForTest({
    icao24: 'abc123',
    entity: { gevLabelModel: { title: 'WARM', details: [] } },
    billboard: { show: false },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    meta: { rawLat: 30.2, rawLon: -97.7, onGround: false },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ states: [null, {}, ['abc123', null, null, null, null, null, null]] }),
  });
  try {
    await flightsLayer.update({ camera: { positionCartographic: null }, scene: {} });
    const resolution = await flightsLayer.resolveTrackingRestoreTarget('abc123');
    assert.equal(resolution.status, 'source-unavailable');
    assert.match(flightsLayer.getStats().error, /Malformed OpenSky aircraft rows/);
    assert.equal(flightsLayer.getAnalystRecords().length, 1, 'warm aircraft data is preserved');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('flights poll refreshes tracked callsign/FL/kts and marks a missed poll STALE', async () => {
  const icao24 = 'a1b2c3';
  const entity = { gevLabelModel: { title: 'OLD', details: [] } };
  const billboard = {
    position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 9_000),
    color: Cesium.Color.WHITE,
    show: false,
  };
  const billboardCollection = { show: false, remove() {} };
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  _setTrackedFlightRefreshStateForTest({
    icao24,
    entity,
    billboard,
    billboardCollection,
    viewer,
    meta: {
      callsign: 'OLD1',
      altitude: 9_000,
      renderAltitudeM: 9_050,
      velocity: 180,
      true_track: 80,
      klass: 'airliner',
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 30.2,
      rawLon: -97.7,
    },
  });

  const realFetch = globalThis.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  let openskyPoll = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/api/gev/opensky')) {
      return { ok: true, status: 200, json: async () => ({ ac: [] }) };
    }
    const states = openskyPoll++ === 0
      ? [[
        icao24, 'DAL123 ', 'United States', nowSec, nowSec,
        -97.6, 30.3, 10_668, false, 250, 95, 5, null, 10_700,
        null, null, null, 5,
      ]]
      : [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ time: nowSec, states }),
    };
  };

  try {
    await flightsLayer.update(viewer);
    assert.equal(entity.gevLabelModel.title, 'DAL123');
    assert.match(entity.gevLabelModel.details.join(' · '), /FL350/);
    assert.match(entity.gevLabelModel.details.join(' · '), /486 kts/);

    await flightsLayer.update(viewer);
    assert.match(
      [entity.gevLabelModel.title, ...entity.gevLabelModel.details].join(' · '),
      /STALE/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('real civil track path creates no native label and publishes every cached host line', async () => {
  const icao24 = 'civ001';
  const position = Cesium.Cartesian3.fromDegrees(-97.6699, 30.1945, 10_668);
  const now = Cesium.JulianDate.now();
  const entities = new Cesium.EntityCollection();
  const trackedEntityChanged = new Cesium.Event();
  let trackedEntity;
  let cancelledFlights = 0;
  let appliedFrames = 0;
  const viewer = {
    entities,
    trackedEntityChanged,
    clock: { currentTime: now },
    camera: {
      cancelFlight() { cancelledFlights += 1; },
      position: new Cesium.Cartesian3(0, -10_000, 7_000),
      positionWC: new Cesium.Cartesian3(0, -10_000, 7_000),
      direction: Cesium.Cartesian3.UNIT_Y,
      transform: Cesium.Matrix4.IDENTITY,
      viewMatrix: Cesium.Matrix4.IDENTITY,
      frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
      lookAtTransform() { appliedFrames += 1; },
    },
    scene: {
      canvas: { clientWidth: 1600, clientHeight: 900 },
      frameState: { frameNumber: 41, mode: Cesium.SceneMode.SCENE3D },
      preUpdate: new Cesium.Event(),
      screenSpaceCameraController: null,
    },
    isDestroyed: () => false,
  };
  Object.defineProperty(viewer, 'trackedEntity', {
    get: () => trackedEntity,
    set(value) {
      trackedEntity = value;
      trackedEntityChanged.raiseEvent(value);
    },
  });
  viewer.scene.camera = viewer.camera;
  const billboard = {
    position,
    rotation: 0.3,
    show: true,
    width: 20,
    height: 20,
    color: Cesium.Color.WHITE,
    scale: 1,
  };
  const publications = [];
  const host = {
    setEntries(sourceId, entries, options) {
      publications.push({ sourceId, entries, options });
    },
    setVisible() {},
    clearSource() {},
  };
  const realWindow = globalThis.window;
  const realFetch = globalThis.fetch;
  globalThis.window = new EventTarget();
  const selectionEvents = [];
  globalThis.window.addEventListener('gev:awareness-subject-selected', (event) => {
    selectionEvents.push(event.detail);
  });
  globalThis.fetch = async () => ({ ok: false });
  _setTrackedOverlayHostForTest(host);
  try {
    initTrackedReadout(viewer);
    _setTrackedFlightRefreshStateForTest({
      icao24,
      entity: null,
      billboard,
      billboardCollection: { show: true, remove() {} },
      viewer,
      tracked: false,
      history: [{
        time: now,
        epochMs: Date.now(),
        position,
        velocity: 250,
        track: 95,
      }],
      meta: {
        callsign: 'N12345',
        altitude: 10_668,
        renderAltitudeM: 10_700,
        velocity: 250,
        true_track: 95,
        verticalRate: 0,
        klass: 'airliner',
        onGround: false,
        wasAirborne: true,
        turnRateDps: 0,
        rawLat: 30.1945,
        rawLon: -97.6699,
        airline: 'TEST AIR',
        typeName: 'A320',
        route: {
          origin: { code: 'AUS', lat: 30.1975, lon: -97.6664 },
          destination: { code: 'LAX', lat: 33.9416, lon: -118.4085 },
        },
      },
    });

    assert.equal(flightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    const entity = viewer.trackedEntity;
    assert.ok(entity instanceof Cesium.Entity, 'trackById must create the real Cesium entity');
    assert.equal(entity.label, undefined);
    assert.ok(entities.values.every((candidate) => candidate.label === undefined));
    assert.deepEqual(entity.gevLabelModel, {
      title: 'N12345 · FL350 · 486 kts',
      details: ['TEST AIR · A320', 'AUS → LAX'],
      accent: '#39d0ff',
    });
    viewer.scene.preUpdate.raiseEvent();
    const initialAppliedFrames = appliedFrames;
    const initialCancelledFlights = cancelledFlights;
    assert.equal(flightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(cancelledFlights, initialCancelledFlights, 'ordinary repeated tracking stays camera-idempotent');
    assert.equal(selectionEvents.at(-1)?.origin, 'user', 'same-target selection upgrades durable authority');
    assert.equal(entity.gevSelectionOrigin, 'user');
    assert.equal(flightsLayer.refocusTrackedById('different-flight'), false);
    assert.equal(flightsLayer.refocusTrackedById(icao24, { origin: 'voice' }), true);
    assert.equal(selectionEvents.at(-1)?.origin, 'voice', 'same-target refocus forwards explicit authority');
    assert.equal(flightsLayer.refocusTrackedById(icao24), true);
    viewer.scene.preUpdate.raiseEvent();
    assert.equal(viewer.trackedEntity, entity, 'refocus must retain the exact tracked entity');
    assert.equal(appliedFrames, initialAppliedFrames + 1, 'repeated refocus keeps one camera-frame owner');
    assert.equal(cancelledFlights, initialCancelledFlights + 2, 'only explicit refocus requests cancel camera flights');
    const publication = publications.at(-1);
    assert.equal(publication.sourceId, 'tracked');
    const entry = publication.entries[0];
    assert.equal(entry.protected, true);
    assert.equal(entry.paintLane, 'tracked');
    assert.equal(entry.title, entity.gevLabelModel.title);
    assert.deepEqual(entry.details, entity.gevLabelModel.details);

    const display = entity.position.getValue(now);
    assert.ok(display, 'tracked position callback must seed its frame cache');
    assert.equal(entry.position(), display, 'host must reuse the exact cached display Cartesian');

    flightsLayer.setParams(
      { selectedFlightsTrackingId: 'late001' },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late001');
    assert.equal(flightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(_pendingFlightTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _addFlightTrackingCandidateForTest({
      icao24: 'late001',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.5, 30.4, 9_000) },
      meta: { ...FULL_INFO, callsign: 'LATE1', rawLat: 30.4, rawLon: -97.5 },
      history: [],
    });
    _applyPendingFlightTrackingRestoreForTest();
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, icao24);

    flightsLayer.stopTracking();
    flightsLayer.setParams(
      { selectedFlightsTrackingId: 'late002' },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late002');
    flightsLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingFlightTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');
    _addFlightTrackingCandidateForTest({
      icao24: 'late002',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.4, 30.5, 8_000) },
      meta: { ...FULL_INFO, callsign: 'LATE2', rawLat: 30.5, rawLon: -97.4 },
      history: [],
    });
    _applyPendingFlightTrackingRestoreForTest();
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, null);

    flightsLayer.setParams(
      { selectedFlightsTrackingId: 'late003' },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late003');
    flightsLayer.setParams({ models3d: false }, { origin: 'user' });
    assert.equal(
      _pendingFlightTrackingRestoreForTest(),
      null,
      'a newer explicit non-selection option cancels stale restore',
    );
    _addFlightTrackingCandidateForTest({
      icao24: 'late003',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.3, 30.6, 7_000) },
      meta: { ...FULL_INFO, callsign: 'LATE3', rawLat: 30.6, rawLon: -97.3 },
      history: [],
    });
    _applyPendingFlightTrackingRestoreForTest();
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, null);

    flightsLayer.setParams(
      { selectedFlightsTrackingId: 'late004' },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late004');
    _addFlightTrackingCandidateForTest({
      icao24: 'late004',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.2, 30.7, 6_000) },
      meta: { ...FULL_INFO, callsign: 'LATE4', rawLat: 30.7, rawLon: -97.2 },
      history: [],
    });
    assert.equal(_applyPendingFlightTrackingRestoreForTest(), true);
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, 'late004');

    flightsLayer.setParams(
      { selectedFlightsTrackingId: 'late005' },
      { origin: 'share-restore' },
    );
    assert.equal(flightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    assert.equal(
      _pendingFlightTrackingRestoreForTest(),
      'late005',
      'passive autofocus cannot revoke the shared target still waiting for its feed row',
    );
    _addFlightTrackingCandidateForTest({
      icao24: 'late005',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.1, 30.8, 5_000) },
      meta: { ...FULL_INFO, callsign: 'LATE5', rawLat: 30.8, rawLon: -97.1 },
      history: [],
    });
    assert.equal(_applyPendingFlightTrackingRestoreForTest(), true);
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, 'late005');
  } finally {
    flightsLayer.stopTracking();
    viewer.scene.preUpdate.raiseEvent();
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  }
});

// ---------------------------------------------------------------------------
// Label convention: callsign → registration → icao24
//
// A callsign-less civil contact used to read as its raw ICAO hex ("ae1fa4")
// even once adsbdb enrichment had supplied a registration ("N123AB"). The
// military layer already resolved callsign → registration → hex; these lock
// the civil layer to the same chain across EVERY public label surface, and
// pin the invariant that identity stays icao24 (the `id`/`icao24`/`sourceId`
// keys that tracking, declutter and the Context cohorts actually key on).
// ---------------------------------------------------------------------------

const LABEL_ICAO = 'ae1fa4';
const LABEL_POSITION = Cesium.Cartesian3.fromDegrees(-97.71, 30.21, 10_668);

/** Seed one civil contact through the production refresh seam. */
function seedLabelContact({ callsign, registration, tracked = false }) {
  _setTrackedFlightRefreshStateForTest({
    icao24: LABEL_ICAO,
    entity: null,
    billboard: { position: LABEL_POSITION, color: Cesium.Color.WHITE, show: true },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    tracked,
    meta: {
      callsign,
      registration,
      altitude: 10_668,
      renderAltitudeM: 10_700,
      velocity: 250,
      true_track: 95,
      verticalRate: 0,
      klass: 'airliner',
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 30.21,
      rawLon: -97.71,
    },
  });
}

/** Every public label string the civil layer publishes for one contact. */
function labelsFor({ callsign, registration }) {
  seedLabelContact({ callsign, registration, tracked: false });
  const nearby = flightsLayer.getNearby(LABEL_POSITION, 250_000, 50)[0];
  const detected = flightsLayer.getDetectableObjects({ maxCount: 50 })[0];
  const all = flightsLayer.getAllPositions(50)[0];
  seedLabelContact({ callsign, registration, tracked: true });
  const subject = flightsLayer.getTrackedSubject();
  return {
    getNearby: nearby?.id,
    getDetectableObjects: detected?.id,
    getAllPositions: all?.label,
    getTrackedSubject: subject?.label,
    analyst: mapAnalystRecord(LABEL_ICAO, { callsign, registration }).id,
    // Identity keys — these must NOT move with the label.
    _identity: {
      nearby: nearby?.icao24,
      detected: detected?.sourceId,
      all: all?.id,
      subject: subject?.id,
    },
  };
}

test('civil label chain: a callsign wins on every label surface', () => {
  const labels = labelsFor({ callsign: 'SWA696 ', registration: 'N123AB' });
  for (const [surface, value] of Object.entries(labels)) {
    if (surface === '_identity') continue;
    assert.equal(value, 'SWA696', `${surface} must show the callsign`);
  }
});

test('civil label chain: a blank callsign falls back to the registration, not the ICAO hex', () => {
  const labels = labelsFor({ callsign: '   ', registration: 'N123AB ' });
  for (const [surface, value] of Object.entries(labels)) {
    if (surface === '_identity') continue;
    assert.equal(value, 'N123AB', `${surface} must show the registration, not ${LABEL_ICAO}`);
  }
});

test('civil label chain: no callsign and no registration still reads as the ICAO hex', () => {
  for (const registration of [undefined, null, '   ']) {
    const labels = labelsFor({ callsign: null, registration });
    for (const [surface, value] of Object.entries(labels)) {
      if (surface === '_identity') continue;
      assert.equal(value, LABEL_ICAO, `${surface} must fall through to the hex`);
    }
  }
});

test('civil label chain: the cockpit descriptor exposes a trimmed registration', () => {
  // ui.js builds the Cockpit callsign readout as
  // `info.callsign || info.registration || info.icao24` off getTrackedInfo(),
  // so an untrimmed " N123AB " would render with its padding and a
  // whitespace-only value would win over the hex.
  seedLabelContact({ callsign: '  ', registration: ' N123AB ', tracked: true });
  assert.equal(flightsLayer.getTrackedInfo()?.registration, 'N123AB');
  seedLabelContact({ callsign: '  ', registration: '   ', tracked: true });
  assert.equal(flightsLayer.getTrackedInfo()?.registration, null);
});

test('civil label chain: identity stays icao24 while the label moves', () => {
  for (const fixture of [
    { callsign: 'SWA696', registration: 'N123AB' },
    { callsign: '   ', registration: 'N123AB' },
    { callsign: null, registration: null },
  ]) {
    const { _identity } = labelsFor(fixture);
    for (const [key, value] of Object.entries(_identity)) {
      assert.equal(value, LABEL_ICAO, `${key} identity must remain the ICAO hex`);
    }
  }
});

// The `labelsFor` sweep above reads only the RETURNED label surfaces. The
// selection EVENT is a separate publication path (`_publishTrackedSelection`
// → `gev:awareness-subject-selected`), consumed by Context/awareness, and it
// regressed to a raw `callsign || icao24` while every returned surface stayed
// green. Observe the event itself so the chain cannot rot on that seam again.
/** Capture the awareness selection event emitted for one seeded contact. */
function selectionEventFor({ callsign, registration }) {
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const events = [];
  globalThis.window.addEventListener(
    'gev:awareness-subject-selected',
    (event) => events.push(event.detail),
  );
  try {
    seedLabelContact({ callsign, registration, tracked: true });
    flightsLayer.trackById(LABEL_ICAO, { origin: 'user' });
    return events.at(-1) || null;
  } finally {
    globalThis.window = realWindow;
  }
}

test('civil label chain: the awareness selection EVENT uses the canonical chain', () => {
  for (const [fixture, expected] of [
    [{ callsign: 'SWA696 ', registration: 'N123AB' }, 'SWA696'],
    // The regression: a callsign-less enriched contact must publish its
    // registration, never the raw ICAO hex.
    [{ callsign: '   ', registration: ' N123AB ' }, 'N123AB'],
    [{ callsign: null, registration: 'N123AB' }, 'N123AB'],
    // Only a contact with neither falls through to the hex.
    [{ callsign: null, registration: null }, LABEL_ICAO],
    [{ callsign: '  ', registration: '   ' }, LABEL_ICAO],
  ]) {
    const detail = selectionEventFor(fixture);
    assert.ok(detail, `no selection event for ${JSON.stringify(fixture)}`);
    assert.equal(
      detail.label,
      expected,
      `selection event label for ${JSON.stringify(fixture)}`,
    );
    // Identity must NOT move with the label.
    assert.equal(detail.id, LABEL_ICAO, 'selection event identity stays the ICAO hex');
    assert.equal(detail.layerId, 'flights');
  }
});

test('civil tracked readout: a callsign-less enriched contact reads as its registration', async () => {
  const entity = { gevLabelModel: { title: 'OLD', details: [] } };
  seedLabelContact({ callsign: '  ', registration: ' N123AB ', tracked: true });
  _setTrackedFlightRefreshStateForTest({
    icao24: LABEL_ICAO,
    entity,
    billboard: { position: LABEL_POSITION, color: Cesium.Color.WHITE, show: false },
    billboardCollection: { show: false, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    meta: {
      callsign: '  ',
      registration: ' N123AB ',
      altitude: 10_668,
      renderAltitudeM: 10_700,
      velocity: 250,
      true_track: 95,
      klass: 'airliner',
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 30.21,
      rawLon: -97.71,
    },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: 0, states: [] }),
  });
  try {
    await flightsLayer.update({ camera: { positionCartographic: null }, scene: {} });
    assert.match(entity.gevLabelModel.title, /^N123AB\b/);
    assert.doesNotMatch(
      [entity.gevLabelModel.title, ...entity.gevLabelModel.details].join(' · '),
      /ae1fa4/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Military suppression must not fake a feed failure.
//
// `acceptedSnapshotIcaos` is built BEFORE the military-suppression `continue`,
// so a mil-registry hex is provably present in a healthy snapshot while having
// no billboard. `trackById` then fails and the share restore reported
// "could not be restored — feed unavailable" about a feed that was fine.
// This layer still OWNS a contact it is holding on its restore latch, so that
// contact is exempt from suppression exactly like the tracked one.
// ---------------------------------------------------------------------------

const MIL_HEX = 'ae1234';

test('military suppression exempts the contact this layer is still restoring', () => {
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    _armFlightTrackingRestoreForTest(null);

    setMilitaryLayerActive(false);
    assert.equal(
      _militaryLayerSuppressesForTest(MIL_HEX),
      false,
      'nothing is suppressed while the Military layer is off',
    );

    setMilitaryLayerActive(true);
    assert.equal(
      _militaryLayerSuppressesForTest(MIL_HEX),
      true,
      'an ordinary mil-registry duplicate is suppressed',
    );

    // The regression: a pending restore target was suppressed, so it could
    // never render, never track, and reported a feed failure instead.
    _armFlightTrackingRestoreForTest(MIL_HEX);
    assert.equal(
      _militaryLayerSuppressesForTest(MIL_HEX),
      false,
      'a contact held on the restore latch must still render in this layer',
    );
    assert.equal(
      _militaryLayerSuppressesForTest('bb9999'),
      true,
      'the exemption is scoped to the pending target only',
    );

    _armFlightTrackingRestoreForTest(null);
    assert.equal(_militaryLayerSuppressesForTest(MIL_HEX), true);
  } finally {
    setMilitaryLayerActive(false);
    _armFlightTrackingRestoreForTest(null);
    globalThis.window = realWindow;
  }
});

// ---------------------------------------------------------------------------
// Display-time ground floor (2026-08-19 — qa-floor-verify FAIL at KAUS).
//
// A grounded contact's renderAltitudeM is chosen ONCE per poll from the floor
// of the FIX's coarse cell. What actually renders is the dead-reckoned display
// position, which drifts across cells for the whole 30 s segment and, while a
// stale ground contact coasts, for up to 300 s / several hundred metres. On a
// graded apron (KAUS spans ~119–140 m ellipsoidal) the sprite then renders
// under the mesh it drifted over — measured to −15.5 m. These pin the fix at
// the point of DISPLAY: read-only against the shared floor cache, grounded
// contacts only, never when a 3D model owns the visual (T7 one-shot).
// ---------------------------------------------------------------------------

const _floorCarto = (pos) => Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84);

test('display floor: a grounded contact that drifted onto a higher cell is lifted', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Fix cell floor was 124.7; the display has taxied into a 140.2 m cell.
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false);
  const c = _floorCarto(out);
  assert.ok(Math.abs(c.height - (140.2 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `height ${c.height} should be 140.2 + lift`);
  // Lifted straight up — the drifted lat/lon is preserved exactly.
  assert.ok(Math.abs(Cesium.Math.toDegrees(c.latitude) - 30.2004) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(c.longitude) + 97.6604) < 1e-6);
});

test('display floor: an AIRBORNE contact over the same cell is never lifted', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: false }, pos, false);
  assert.equal(out, pos, 'airborne display positions pass through untouched');
});

test('display floor: T7 — a model-owned grounded contact keeps its billboard datum', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, true);
  assert.equal(out, pos, 'moving it would drag groundSnap past its 50 m re-sample threshold');
});

test('display floor: a contact already above the floor is passed through unchanged', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 124.7);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 140.2);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false);
  assert.equal(out, pos, 'no rebuild when nothing needs lifting');
});

test('display floor: a cold display cell leaves the contact where it is', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false);
  assert.equal(out, pos, 'no floor data → no clamp (never invent a surface)');
});

test('display floor: mesh cells are ignored outside the google-3d regime', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  setMeshFloorPreferred(false); // globe stack: the DEM IS the rendered terrain
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false);
  assert.equal(out, pos);
  setMeshFloorPreferred(true);
});

// --- F6: cell-boundary hysteresis, end to end ------------------------------

test('display floor: jitter across a cell edge does not alternate the floor', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Two neighbouring cells with a 6 m step between their floors.
  reportMeshFloorCell(30.2004, -97.6604, 140);
  reportMeshFloorCell(30.2014, -97.6604, 146);
  const at = (lat) => {
    const out = _floorGroundedDisplayPositionForTest(
      { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, lat, 120), false, 'jitter',
    );
    return _floorCarto(out).height;
  };
  const settled = at(30.2004); // squarely inside the low cell
  assert.ok(Math.abs(settled - (140 + GROUND_FLOOR_LIFT_M)) < 0.05, `settled ${settled}`);
  // 30.2006 belongs to the HIGH cell but is only ~11 m past the boundary.
  assert.ok(Math.abs(at(30.2006) - settled) < 0.05, 'held the low cell across the edge');
  assert.ok(Math.abs(at(30.2004) - settled) < 0.05, 'and back again — no pop');
});

test('display floor: a real crossing does adopt the next cell', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140);
  reportMeshFloorCell(30.2014, -97.6604, 146);
  const at = (lat) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, lat, 120), false, 'crossing',
  )).height;
  at(30.2004);
  const crossed = at(30.2014); // properly into the next cell
  assert.ok(Math.abs(crossed - (146 + GROUND_FLOOR_LIFT_M)) < 0.05, `crossed ${crossed}`);
});

// --- F7: no rebuild when nothing changed -----------------------------------
// A clamped stationary contact (parked, or coasting on a zero-velocity fix)
// hits the clamp at fleet-tick rate forever. The "no rebuild" claim was false
// for exactly that case: its raw height stays below the floor, so every tick
// rebuilt an identical Cartesian.

test('display floor: a clamped stationary contact reuses its previous output', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 120);
  const first = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'parked');
  const second = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'parked');
  assert.notEqual(first, pos, 'it really is clamped (not the pass-through case)');
  assert.equal(second, first, 'same input + same floor ⇒ the very same object, no rebuild');
});

test('display floor: the cached output is dropped when the floor changes under it', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 120);
  const before = _floorCarto(_floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'warming')).height;
  // A late mesh sample raises this cell (a fresh module state stands in for the
  // one-shot latch, which never overwrites).
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2004, -97.6604, 175);
  const after = _floorCarto(_floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'warming')).height;
  assert.ok(Math.abs(before - 141.5) < 0.05, `before ${before}`);
  assert.ok(Math.abs(after - 176.5) < 0.05, `after ${after} — a stale cache would still read 141.5`);
});

// --- F8: hold the last known floor through a floor-data gap ----------------
//
// Field incident 2026-08-21: four `[terrain-heights-proxy] refresh incomplete`
// events in a row (Re:Earth timing out), and a parked contact at a Texas field
// popped BELOW the photoreal mesh for a few seconds. A cold cell used to mean
// "no clamp", which is only safe if the un-clamped height is a real reading —
// and for a grounded contact reporting no altitude it is the geoid, tens of
// metres under the mesh inland. The product must hold the last known altitude
// until fresh floor evidence arrives.

test('display floor: a cold cell HOLDS the last floor that resolved for this contact', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  // On the warm cell: clamped onto the floor as usual.
  const warm = _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7), false, 'held',
  );
  assert.ok(Math.abs(_floorCarto(warm).height - (140.2 + GROUND_FLOOR_LIFT_M)) < 0.05);
  // Taxis ~550 m onto a cell nothing has resolved, still at the geoid-ish
  // height the poll path handed it. Pre-fix this passed straight through —
  // buried.
  const cold = _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2054, 124.7), false, 'held',
  );
  const h = _floorCarto(cold).height;
  assert.ok(Math.abs(h - (140.2 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `held ${h} — a cold cell must hold 140.2 + lift, never the 124.7 it arrived with`);
});

test('display floor: with NO prior anywhere the contact is left exactly where it is', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const out = _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'fresh');
  assert.equal(out, pos, 'nothing measured anywhere ⇒ nothing invented — same object, no clamp');
});

test('display floor: a fresh contact on a cold cell adopts a resolved NEIGHBOUR', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Two adjacent cells resolved; the contact stands on the unresolved one
  // between them. The LOWER neighbour wins — a high reading next to a cold
  // cell is as likely to be a roof as ground, and only a low one is inert.
  reportMeshFloorCell(30.2014, -97.6604, 141.0);
  reportMeshFloorCell(30.1994, -97.6604, 152.0);
  const out = _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7), false, 'neighbour',
  );
  const h = _floorCarto(out).height;
  assert.ok(Math.abs(h - (141.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `neighbour hold ${h} — expected the lower of the two resolved neighbours`);
});

// Drives a stationary contact at the production 80 ms fleet cadence and reports
// the largest DOWNWARD step any single tick produced, plus where it settled.
// `mutate` runs before the tick at that index, so a target can be moved
// mid-approach.
function _driveEase(id, pos, fromMs, ticks, mutate = () => {}) {
  let previous = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, id, fromMs,
  )).height;
  const opened = previous;
  let maxStepM = 0;
  for (let i = 1; i <= ticks; i += 1) {
    mutate(i);
    const h = _floorCarto(_floorGroundedDisplayPositionForTest(
      { onGround: true }, pos, false, id, fromMs + i * 80,
    )).height;
    maxStepM = Math.max(maxStepM, previous - h);
    previous = h;
  }
  return { opened, settled: previous, maxStepM };
}

test('display floor: a hold released onto a LOWER floor eases down, never snaps', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  // Holds 200 m borrowed from the warm neighbours (the lowest of the pair).
  reportMeshFloorCell(30.2014, -97.6604, 200.0);
  reportMeshFloorCell(30.1994, -97.6604, 240.0);
  const r = _driveEase('ease', pos, 1000, 60, (i) => {
    if (i === 1) reportMeshFloorCell(30.2004, -97.6604, 160.0); // its own cell resolves lower
  });
  const totalDropM = r.opened - (160.0 + GROUND_FLOOR_LIFT_M);
  assert.ok(Math.abs(r.opened - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05, `opened at ${r.opened}`);
  assert.ok(r.maxStepM <= totalDropM * 0.25,
    `largest single-tick drop ${r.maxStepM.toFixed(1)} m of ${totalDropM.toFixed(1)} m — a snap is the whole drop at once`);
  assert.ok(Math.abs(r.settled - (160.0 + GROUND_FLOOR_LIFT_M)) < 0.05, `settled at ${r.settled}`);
});

test('display floor: a hold released onto a HIGHER floor rises immediately', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const at = (ms) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, 'rise', ms,
  )).height;
  reportMeshFloorCell(30.2014, -97.6604, 160.0);
  reportMeshFloorCell(30.1994, -97.6604, 190.0);
  assert.ok(Math.abs(at(1000) - (160.0 + GROUND_FLOOR_LIFT_M)) < 0.05);
  reportMeshFloorCell(30.2004, -97.6604, 205.0);
  // No easing UP: an eased rise is time spent under the mesh, which is the
  // whole failure this path exists to prevent.
  assert.ok(Math.abs(at(1001) - (205.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    'the next tick is already on the higher floor');
});

// --- F9: the hold is a live state machine, not a one-shot ------------------
// Both were reproduced against an earlier cut of this change. A parked contact
// never moves and its cell never warms, so an input-keyed memo returned the
// unresolved answer forever; and the hold outlived the grounded-billboard
// regime that owns it.

test('display floor: a STATIONARY unresolved contact still adopts a floor that arrives later', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  const at = (ms) => _floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, 'parked-cold', ms,
  );
  assert.equal(at(1000), pos, 'nothing anywhere yet — passes through');
  // The poll's warm batch lands the cells NEXT DOOR (this contact's own cell
  // is still cold, so only the hold chain can see them).
  reportMeshFloorCell(30.2014, -97.6604, 138.0);
  reportMeshFloorCell(30.1994, -97.6604, 160.0);
  const adopted = _floorCarto(at(1600)).height; // past the probe throttle
  assert.ok(Math.abs(adopted - (138.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `stationary contact ${adopted} — a memoized unresolved answer would still read 124.7`);
});

test('display floor: a stationary contact FOLLOWS the neighbourhood as it fills in', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  const at = (ms) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, 'upgrade', ms,
  )).height;
  reportMeshFloorCell(30.2014, -97.6604, 200.0);
  reportMeshFloorCell(30.1994, -97.6604, 240.0);
  assert.ok(Math.abs(at(1000) - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05);
  // A third neighbour warms BELOW the pair — the first two were the terminal
  // side, this is the apron. A borrowed floor is never owned: the contact must
  // follow rather than keep its first answer.
  reportMeshFloorCell(30.2004, -97.6614, 120.0);
  let h = 0;
  for (let ms = 1600; ms <= 6000; ms += 80) h = at(ms);
  assert.ok(Math.abs(h - (120.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `followed to ${h} — a borrowed floor must not outlive a better one`);
});

test('display floor: an on_ground FLAP mid-takeoff-roll never dips below the runway', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // JFK: ~4 m MSL field, geoid N ~ -32.5 m, so the runway is ~-28.5 m
  // ellipsoidal and the geoid is 4 m UNDER it. OpenSky's on_ground flag flaps
  // through a rotation, and at the same moment the fix's height source switches
  // from the resolved surface to baro + geoid N — which at a sea-level field IS
  // the geoid. Deleting the hold on the airborne poll made that switch visible:
  // the contact came back grounded with no prior, outrunning its own floor
  // cells at 23 m/s, and sat under the runway (field observation, VIR138M).
  const GROUND = -28.5, GEOID = -32.5, LON = -73.78;
  reportMeshFloorCell(40.64, LON, GROUND); // only the cell it STARTED on is warm
  let lat = 40.64;
  const grounded = [];
  for (let i = 0; i <= 22; i += 1) {
    const onGround = i !== 10; // one airborne poll mid-roll
    const out = _floorGroundedDisplayPositionForTest(
      { onGround }, Cesium.Cartesian3.fromDegrees(LON, lat, GEOID), false, 'VIR138M', 1000 + i * 80,
    );
    if (onGround) grounded.push(_floorCarto(out).height);
    lat += 0.00021; // ~23 m per tick at 45 kt
  }
  const dipped = grounded.filter((h) => h < GROUND - 0.05);
  assert.deepEqual(dipped, [],
    `${dipped.length} of ${grounded.length} grounded ticks rendered below the runway`);
  assert.ok(Math.abs(grounded[grounded.length - 1] - (GROUND + GROUND_FLOOR_LIFT_M)) < 0.05,
    'and it is still standing on the floor it held, not on nothing');
});

test('display floor: the rehydration seed EXPIRES on its own age, with NO calls in between', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const field = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2014, -97.6604, 200.0);
  reportMeshFloorCell(30.1994, -97.6604, 240.0);
  assert.ok(Math.abs(_floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, field, false, 'longhaul', 1000,
  )).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05, 'holding 200 m before departure');
  // ONE airborne tick parks the seed, and then this contact is not seen again
  // for 198 s: off the poll on a cruise, outside the corridor radius, tab
  // hidden. Nothing runs in between, so the retire path never gets a second
  // chance to expire it — the age has to be judged where it comes BACK.
  // An earlier cut checked expiry only on the retire path and cleared
  // `retiredMs` before validating it, so this reused the 200 m floor.
  _floorGroundedDisplayPositionForTest({ onGround: false }, field, false, 'longhaul', 2000);
  _clearMeshFloorCellsForTest(); // a different airport: nothing warm here
  const back = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  assert.equal(
    _floorGroundedDisplayPositionForTest({ onGround: true }, back, false, 'longhaul', 200000), back,
    'an expired seed is gone — no floor is invented from a 198-second-old measurement',
  );
});

test('display floor: the seed expires the same way when the contact keeps reporting', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const field = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2014, -97.6604, 200.0);
  reportMeshFloorCell(30.1994, -97.6604, 240.0);
  _floorGroundedDisplayPositionForTest({ onGround: true }, field, false, 'cruise', 1000);
  // The other half of the same clock: an airborne contact that IS still being
  // ticked. The window is the window either way.
  _floorGroundedDisplayPositionForTest({ onGround: false }, field, false, 'cruise', 2000);
  _floorGroundedDisplayPositionForTest({ onGround: false }, field, false, 'cruise', 200000);
  _clearMeshFloorCellsForTest();
  const back = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  assert.equal(
    _floorGroundedDisplayPositionForTest({ onGround: true }, back, false, 'cruise', 201000), back,
    'no memory of the departure field survives the grace window',
  );
});

// --- The seed is a MEMORY, and ranks below anything freshly measured ---------
// It exists for the flap window, where a rotation outruns its own floor cells
// and nothing nearby is warm either. The moment the neighbourhood CAN answer,
// it is the neighbourhood that knows where the ground is.

test('display floor: a rehydrated seed ranks BELOW fresh neighbour evidence', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const departed = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 50);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  assert.ok(Math.abs(_floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, departed, false, 'short-hop', 1000,
  )).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05, 'standing on its own 200 m cell');
  _floorGroundedDisplayPositionForTest({ onGround: false }, departed, false, 'short-hop', 2000);
  // Re-grounds 0.56 km away — INSIDE HELD_FLOOR_MAX_DRIFT_KM, so the drift
  // bound does not save us here; the tier order has to. Its own cell is cold,
  // but two adjacent cells have since resolved, and they are 100 m of ground.
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2044, -97.6604, 100.0);
  reportMeshFloorCell(30.2064, -97.6604, 105.0);
  const moved = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2054, 50);
  const rendered = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, moved, false, 'short-hop', 3000,
  )).height;
  assert.ok(Math.abs(rendered - (100.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `rendered at ${rendered} — a seed that outranked the neighbourhood read 201.5, 100 m in the air`);
});

test('display floor: with nothing fresh to contradict it, the seed still answers', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // The other side of the same rule, and the reason the seed exists: the flap
  // window, where the contact has outrun its own cells and no neighbour has
  // warmed either. Demoting the seed must not mean discarding it.
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 50);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'flap', 1000);
  _floorGroundedDisplayPositionForTest({ onGround: false }, pos, false, 'flap', 2000);
  _clearMeshFloorCellsForTest(); // the whole neighbourhood goes cold
  const held = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2014, 50), false, 'flap', 3000,
  )).height;
  assert.ok(Math.abs(held - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `held ${held} — with no measurement anywhere the seed is the best thing available`);
});

test('display floor: re-measuring its own cell makes a seeded contact authoritative again', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pad = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2004, -97.6604, 300.0);
  _floorGroundedDisplayPositionForTest({ onGround: true }, pad, false, 'relatch', 1000);
  _floorGroundedDisplayPositionForTest({ onGround: false }, pad, false, 'relatch', 2000);
  // Re-grounds on its own, still-warm 300 m cell: that is a live reading, so the
  // demotion is over and the ordinary tier order applies again.
  assert.ok(Math.abs(_floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pad, false, 'relatch', 3000,
  )).height - (300.0 + GROUND_FLOOR_LIFT_M)) < 0.05, 'back on its own measured cell');
  // It now taxis 220 m onto a cold cell whose two adjacent cells read 100 m. An
  // own floor it measured while standing here outranks a borrowed one — the
  // seed flag has to have been cleared by that reading, or the contact drops
  // 200 m onto someone else's ground.
  reportMeshFloorCell(30.2014, -97.6604, 100.0);
  reportMeshFloorCell(30.2034, -97.6604, 100.0);
  const taxied = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2024, 100), false, 'relatch', 4000,
  )).height;
  assert.ok(Math.abs(taxied - (300.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `taxied at ${taxied} — a still-seeded contact would have taken the 100 m neighbours`);
});

test('display floor: taking off and landing elsewhere does NOT inherit the old field floor', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const field = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  // 1. grounded on a 200 m floor.
  assert.ok(Math.abs(_floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, field, false, 'trip', 1000,
  )).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05);
  // 2. it taxis ~330 m onto ground nothing has resolved, so 200 m is now being
  //    HELD — this is the state that must not survive the trip.
  const heldAt = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2034, 124.7);
  assert.ok(Math.abs(_floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, heldAt, false, 'trip', 1500,
  )).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05, 'the hold is active before takeoff');
  // 3. airborne — the hold belongs to the grounded-billboard regime, not to the
  //    contact, so leaving that regime must retire it.
  _floorGroundedDisplayPositionForTest({ onGround: false }, heldAt, false, 'trip', 2000);
  // 4. lands at another field on a real 100 m floor.
  reportMeshFloorCell(31.5004, -97.6604, 100.0);
  const landed = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 31.5004, 60), false, 'trip', 3000,
  )).height;
  assert.ok(Math.abs(landed - (100.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `landed at ${landed} — a stale hold would arrive at 201.5 and ease down from it`);
});

test('display floor: a model-owned interval retires the hold too', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'handoff', 1000);
  // It moves onto unresolved ground, so 200 m is being HELD.
  const heldAt = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2034, 124.7);
  _floorGroundedDisplayPositionForTest({ onGround: true }, heldAt, false, 'handoff', 1500);
  // T7: the 3D model takes the visual. Our state is retired (nothing visual is
  // touched — groundSnap's one-shot input is untouched either way).
  _floorGroundedDisplayPositionForTest({ onGround: true }, heldAt, true, 'handoff', 2000);
  // The billboard resumes over ground that has since resolved LOWER. A stale
  // heldActive would read this as a hold release and ease; it is a fresh start.
  reportMeshFloorCell(30.2034, -97.6604, 150.0);
  const back = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, heldAt, false, 'handoff', 3000,
  )).height;
  assert.ok(Math.abs(back - (150.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `resumed at ${back} — no ease, because there was no hold to release`);
});

test('display floor: a model handoff back onto a COLD cell takes the neighbourhood, not the seed', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Same handoff as above with the FAVOURABLE half removed: the cell the
  // billboard resumes on is still cold, so the live read cannot overrule the
  // seed and the tier order is the only thing standing between the contact and
  // a floor it measured 330 m ago. Two adjacent cells have resolved at 150 m.
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  _floorGroundedDisplayPositionForTest({ onGround: true }, pos, false, 'cold-handoff', 1000);
  const heldAt = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2034, 124.7);
  _floorGroundedDisplayPositionForTest({ onGround: true }, heldAt, false, 'cold-handoff', 1500);
  _floorGroundedDisplayPositionForTest({ onGround: true }, heldAt, true, 'cold-handoff', 2000);
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2024, -97.6604, 150.0);
  reportMeshFloorCell(30.2044, -97.6604, 155.0);
  const back = _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, heldAt, false, 'cold-handoff', 3000,
  )).height;
  assert.ok(Math.abs(back - (150.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `resumed at ${back} — a seed that outranked the neighbourhood would resume at 201.5`);
});

// --- F10: no contact waits on another --------------------------------------
// A probe is eight synchronous Map reads against the shared floor cache — no
// fetch, no sampleHeight, nothing async — so there is no shared resource to
// ration. An earlier draft added a global per-tick budget with a fairness queue
// anyway; it protected ~2 ms of cache reads (measured: 200 synchronised
// all-cold contacts = 2.1 ms, 2.6% of one 80 ms fleet tick) and cost two
// starvation defects. This pins the property that replaced it.

test('display floor: every grounded contact is floored on the tick it asks', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const N = 85; // the fleet size the old scheduler was measured starving at
  const latOf = (i) => 30.2 + i * 0.003;
  for (let i = 0; i < N; i += 1) {
    reportMeshFloorCell(latOf(i) + 0.001, -97.66, 300 + i);
    reportMeshFloorCell(latOf(i) - 0.001, -97.66, 340 + i); // the pair's high side
  }
  const heights = [];
  for (let i = 0; i < N; i += 1) {
    heights.push(_floorCarto(_floorGroundedDisplayPositionForTest(
      { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.66, latOf(i), 100), false, `q${i}`, 1000,
    )).height);
  }
  const unfloored = heights
    .map((h, i) => (Math.abs(h - (300 + i + GROUND_FLOOR_LIFT_M)) < 0.05 ? null : i))
    .filter((i) => i != null);
  assert.deepEqual(unfloored, [],
    'a global budget would leave the tail of the fleet on the geoid for later ticks');
});

test('display floor: a re-probe that finds a LOWER neighbour eases down, never snaps', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2014, -97.6604, 200.0);
  reportMeshFloorCell(30.1994, -97.6604, 240.0); // borrowed floor = the low one, 200 m
  // A third neighbour warms far below — the apron beside the terminal. The
  // borrowed floor recomputes to 120 m. An 80 m drop, and not a step.
  const target = 120.0 + GROUND_FLOOR_LIFT_M;
  const r = _driveEase('relatch', pos, 1000, 80, (i) => {
    if (i === 8) reportMeshFloorCell(30.2004, -97.6614, 120.0); // past the 500 ms probe throttle
  });
  const totalDropM = r.opened - target;
  assert.ok(r.maxStepM <= totalDropM * 0.25,
    `largest single-tick drop ${r.maxStepM.toFixed(1)} m of ${totalDropM.toFixed(1)} m`);
  assert.ok(Math.abs(r.settled - target) < 0.05, `settled at ${r.settled}, expected ${target}`);
});

test('display floor: a SECOND lower re-latch mid-approach retargets without a jump', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2014, -97.6604, 400.0);
  reportMeshFloorCell(30.1994, -97.6604, 440.0); // borrowed floor = 400 m
  // Two lower neighbours arrive in sequence, the second while the approach to
  // the first is still running. A from/duration ease re-evaluated against a
  // moved target jumps by the eased fraction of the change — measured at 100 m
  // in one tick. An approach from the DISPLAYED value has no such seam.
  const target = 100.0 + GROUND_FLOOR_LIFT_M;
  const r = _driveEase('retarget', pos, 1000, 120, (i) => {
    if (i === 8) reportMeshFloorCell(30.2004, -97.6614, 300.0); // -> 300 m
    if (i === 16) reportMeshFloorCell(30.2004, -97.6594, 100.0); // -> 100 m, mid-approach
  });
  const totalDropM = r.opened - target;
  assert.ok(r.maxStepM <= totalDropM * 0.25,
    `largest single-tick drop ${r.maxStepM.toFixed(1)} m of ${totalDropM.toFixed(1)} m — the retarget must not be a seam`);
  assert.ok(Math.abs(r.settled - target) < 0.05, `settled at ${r.settled}, expected ${target}`);
});

test('display floor: a DELAYED tick cannot close more of the gap than a prompt one', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  const at = (ms) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, 'stall', ms,
  )).height;
  reportMeshFloorCell(30.2014, -97.6604, 400.0);
  reportMeshFloorCell(30.1994, -97.6604, 440.0); // borrowed floor = 400 m
  const opened = at(1000);
  reportMeshFloorCell(30.2004, -97.6604, 100.0); // own cell resolves 300 m lower
  const totalDropM = opened - (100.0 + GROUND_FLOOR_LIFT_M);
  // A hidden tab, a long frame, a GC pause: the tick after the drop arrives
  // late. The exponential alone would close 28% at 120 ms and 75% after a
  // 500 ms stall — the snap this approach exists to prevent, reintroduced by
  // the schedule rather than by the code.
  let previous = opened;
  let maxStepM = 0;
  let clock = 1000;
  for (const dt of [120, 500, 2000, 80, 80, 80, 80, 80]) {
    clock += dt;
    const h = at(clock);
    maxStepM = Math.max(maxStepM, previous - h);
    previous = h;
  }
  assert.ok(maxStepM <= totalDropM * 0.25,
    `largest step ${maxStepM.toFixed(1)} m of ${totalDropM.toFixed(1)} m across a stalled schedule`);
  assert.ok(previous < opened, 'and it is still making progress downward');
});

test('display floor: a floor rising MID-APPROACH is taken whole, on that tick', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  const pos = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 100);
  reportMeshFloorCell(30.2014, -97.6604, 400.0);
  reportMeshFloorCell(30.1994, -97.6604, 440.0); // borrowed floor = 400 m
  const at = (ms) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, pos, false, 'riseMid', ms,
  )).height;
  at(1000);
  reportMeshFloorCell(30.2004, -97.6604, 150.0); // own cell resolves far below
  let h = 0;
  for (let i = 1; i <= 4; i += 1) h = at(1000 + i * 80); // approach is under way
  assert.ok(h < 400.0 && h > 160.0, `mid-approach at ${h}`);
  // Now the floor RISES above where the contact is currently drawn. Easing up
  // would leave it under the mesh for the duration; it must arrive at once.
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2004, -97.6604, 500.0);
  const risen = at(1000 + 5 * 80);
  assert.ok(Math.abs(risen - (500.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    `rose to ${risen} — an eased rise is time spent under the mesh`);
});

test('display floor: a held floor is dropped once the contact leaves the ground it describes', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  const at = (lat, ms) => _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, lat, 124.7), false, 'drift', ms,
  );
  assert.ok(Math.abs(_floorCarto(at(30.2004, 1000)).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05);
  // ~670 m on: cold cell, but that is inside one poll's rollout. Hold stands.
  assert.ok(Math.abs(_floorCarto(at(30.2064, 2000)).height - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    'inside the drift bound the held floor still describes the ground');
  // ~3.3 km on: the held value is no longer a measurement of anywhere this
  // contact has been, so it is dropped rather than stretched.
  const far = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2304, 124.7);
  assert.equal(
    _floorGroundedDisplayPositionForTest({ onGround: true }, far, false, 'drift', 3000), far,
    'past the drift bound: back to no clamp, not a stretched one',
  );
});

test('display floor: an ordinary cell-to-cell floor DROP keeps its existing timing', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // Both cells resolved throughout — no hold is ever in play, so the release
  // ease must stay out of it. Only a RELEASE eases; the everyday path is
  // untouched by this round.
  reportMeshFloorCell(30.2004, -97.6604, 200.0);
  reportMeshFloorCell(30.2044, -97.6604, 160.0);
  const at = (lat, ms) => _floorCarto(_floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, lat, 124.7), false, 'plain', ms,
  )).height;
  assert.ok(Math.abs(at(30.2004, 1000) - (200.0 + GROUND_FLOOR_LIFT_M)) < 0.05);
  assert.ok(Math.abs(at(30.2044, 1050) - (160.0 + GROUND_FLOOR_LIFT_M)) < 0.05,
    'the very next tick is on the new cell — no ease was introduced here');
});

test('display floor: the hold never applies to an airborne contact or a modelled one', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140.2);
  const on = Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 124.7);
  _floorGroundedDisplayPositionForTest({ onGround: true }, on, false, 'gates');
  const cold = Cesium.Cartesian3.fromDegrees(-97.6704, 30.2104, 124.7);
  assert.equal(
    _floorGroundedDisplayPositionForTest({ onGround: false }, cold, false, 'gates'), cold,
    'airborne heights belong to the fix-time clamp, held floor or not',
  );
  assert.equal(
    _floorGroundedDisplayPositionForTest({ onGround: true }, cold, true, 'gates'), cold,
    'T7: a model-owned contact keeps its billboard datum, held floor or not',
  );
});

test('display floor: two contacts on the same cell get their own outputs', () => {
  _clearDisplayFloorStateForTest();
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2004, -97.6604, 140);
  const a = _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.6604, 30.2004, 120), false, 'A',
  );
  const b = _floorGroundedDisplayPositionForTest(
    { onGround: true }, Cesium.Cartesian3.fromDegrees(-97.66041, 30.20041, 121), false, 'B',
  );
  assert.notEqual(a, b, 'a shared scratch would hand both contacts the same object');
  assert.ok(Math.abs(_floorCarto(a).height - _floorCarto(b).height) < 0.05);
});
