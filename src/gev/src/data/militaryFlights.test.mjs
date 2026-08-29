// src/data/militaryFlights.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import militaryFlightsLayer, {
  _addMilitaryTrackingCandidateForTest,
  _applyPendingMilitaryTrackingRestoreForTest,
  _pendingMilitaryTrackingRestoreForTest,
  _setMilitaryTrackingRefreshOutcomeForTest,
  _setTrackedMilitaryRefreshStateForTest,
  mapAnalystRecord,
} from './militaryFlights.js';
import {
  _setTrackedOverlayHostForTest,
  destroyTrackedReadout,
  initTrackedReadout,
} from './trackedReadout.js';

test('share-Follow absence requires an accepted adsb.lol snapshot', async () => {
  _setMilitaryTrackingRefreshOutcomeForTest({ status: 'source-unavailable' });
  assert.equal(
    (await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234')).status,
    'source-unavailable',
  );
  _setMilitaryTrackingRefreshOutcomeForTest({ status: 'accepted', ids: ['different'] });
  const missing = await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reason, 'target-absent-from-snapshot');
});

const FULL_INFO = {
  callsign: 'RCH451 ',
  registration: '05-8152',
  rawLat: 31.05,
  rawLon: -97.03,
  altitudeFt: 28000,
  speedMps: 231.5,
  track: 92.1,
  verticalRateMps: 5.08,
  onGround: false,
  klass: 'widebody',
  operator: 'United States Air Force',
};

test('military stats identify adsb.lol as the primary feed, not a fallback', () => {
  const stats = militaryFlightsLayer.getStats();
  assert.equal(stats.source, 'adsb.lol');
  assert.equal(stats.fallback, false);
});

test('military analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord('ae01ce', FULL_INFO);
  assert.deepEqual(r, {
    id: 'RCH451',
    icao24: 'ae01ce',
    callsign: 'RCH451',
    lat: 31.05,
    lon: -97.03,
    altitudeM: 28000 * 0.3048,
    speedMps: 231.5,
    heading: 92.1,
    verticalRateMps: 5.08,
    onGround: false,
    military: true,
    aircraftClass: 'widebody',
    originCountry: null,
    operator: 'United States Air Force',
    routeOrigin: null,
    routeDestination: null,
  });
});

test('military analyst record: military is ALWAYS true, routes/country always null', () => {
  const r = mapAnalystRecord('ae01ce', undefined);
  assert.equal(r.military, true);
  assert.equal(r.originCountry, null);
  assert.equal(r.routeOrigin, null);
  assert.equal(r.routeDestination, null);
});

test('military analyst record: no callsign falls back to registration, then icao24', () => {
  assert.equal(mapAnalystRecord('ae01ce', { ...FULL_INFO, callsign: '' }).id, '05-8152');
  assert.equal(mapAnalystRecord('ae01ce', { callsign: '', registration: ' ' }).id, 'ae01ce');
});

test('military analyst record: empty info yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord('ae01ce', {});
  assert.equal(r.altitudeM, null);
  assert.equal(r.onGround, false);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('military analyst record: output is JSON-safe (no Cesium types)', () => {
  const r = mapAnalystRecord('ae01ce', FULL_INFO);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('military first update forwards caller cancellation into the feed request', async () => {
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
    const work = militaryFlightsLayer.update({}, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignal);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nonempty adsb.lol payload with zero usable rows cannot prove share target absence', async () => {
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae1234',
    entity: { gevLabelModel: { title: 'WARM', details: [] } },
    billboard: { show: false },
    billboardCollection: { show: true, remove() {} },
    viewer: { camera: { positionCartographic: null }, scene: {} },
    meta: { rawLat: 31, rawLon: -97, onGround: false },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ac: [null, {}, { hex: 'ae1234' }] }),
  });
  try {
    await militaryFlightsLayer.update({ camera: { positionCartographic: null }, scene: {} });
    const resolution = await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234');
    assert.equal(resolution.status, 'source-unavailable');
    assert.match(militaryFlightsLayer.getStats().error, /Malformed adsb\.lol aircraft rows/);
    assert.equal(militaryFlightsLayer.getAnalystRecords().length, 1, 'warm aircraft data is preserved');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('military poll refreshes tracked callsign/altitude/kts and marks a missed poll STALE', async () => {
  const icao24 = 'ae01ce';
  const entity = { gevLabelModel: { title: 'OLD', details: [] } };
  const billboard = {
    position: Cesium.Cartesian3.fromDegrees(-97.0, 31.0, 8_000),
    color: Cesium.Color.WHITE,
    show: false,
  };
  const billboardCollection = { show: false, remove() {} };
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  _setTrackedMilitaryRefreshStateForTest({
    icao24,
    entity,
    billboard,
    billboardCollection,
    viewer,
    meta: {
      callsign: 'OLD2',
      type: 'C17',
      klass: 'widebody',
      registration: '05-8152',
      operator: 'USAF',
      altitudeFt: 25_000,
      renderAltitudeM: 7_650,
      speedMps: 180,
      track: 80,
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 31.0,
      rawLon: -97.0,
    },
  });

  const realFetch = globalThis.fetch;
  let poll = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ac: poll++ === 0 ? [{
        hex: icao24,
        lon: -96.9,
        lat: 31.1,
        alt_baro: 28_000,
        alt_geom: 28_100,
        track: 95,
        gs: 400,
        seen: 0,
        seen_pos: 0,
        flight: 'RCH451 ',
        t: 'C17',
        r: '05-8152',
        ownOp: 'United States Air Force',
      }] : [],
    }),
  });

  try {
    await militaryFlightsLayer.update(viewer);
    assert.equal(entity.gevLabelModel.title, 'RCH451');
    assert.match(entity.gevLabelModel.details.join(' · '), /28000 ft/);
    assert.match(entity.gevLabelModel.details.join(' · '), /400 kt/);

    await militaryFlightsLayer.update(viewer);
    assert.match(entity.gevLabelModel.title, /STALE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('real military track path creates no native label and publishes every cached host line', () => {
  const icao24 = 'ae01ce';
  const position = Cesium.Cartesian3.fromDegrees(-97.03, 31.05, 8_534.4);
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
      frameState: { frameNumber: 61, mode: Cesium.SceneMode.SCENE3D },
      preUpdate: new Cesium.Event(),
      screenSpaceCameraController: null,
    },
    isDestroyed: () => false,
  };
  viewer.scene.camera = viewer.camera;
  Object.defineProperty(viewer, 'trackedEntity', {
    get: () => trackedEntity,
    set(value) {
      trackedEntity = value;
      trackedEntityChanged.raiseEvent(value);
    },
  });
  const billboard = {
    position,
    rotation: 0.4,
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
    _setTrackedMilitaryRefreshStateForTest({
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
        velocity: 231.5,
        track: 92.1,
      }],
      meta: {
        ...FULL_INFO,
        type: 'C17',
        renderAltitudeM: 8_560,
        wasAirborne: true,
        turnRateDps: 0,
      },
    });

    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    const entity = viewer.trackedEntity;
    assert.ok(entity instanceof Cesium.Entity, 'trackById must create the real Cesium entity');
    assert.equal(entity.label, undefined);
    assert.ok(entities.values.every((candidate) => candidate.label === undefined));
    assert.deepEqual(entity.gevLabelModel, {
      title: 'RCH451',
      details: [
        'C17 · 05-8152',
        'United States Air Force · 28000 ft · 450 kt',
      ],
      accent: '#ffd166',
    });
    viewer.scene.preUpdate.raiseEvent();
    const initialAppliedFrames = appliedFrames;
    const initialCancelledFlights = cancelledFlights;
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(cancelledFlights, initialCancelledFlights, 'ordinary repeated tracking stays camera-idempotent');
    assert.equal(selectionEvents.at(-1)?.origin, 'user', 'same-target selection upgrades durable authority');
    assert.equal(entity.gevSelectionOrigin, 'user');
    assert.equal(militaryFlightsLayer.refocusTrackedById('different-flight'), false);
    assert.equal(militaryFlightsLayer.refocusTrackedById(icao24, { origin: 'voice' }), true);
    assert.equal(selectionEvents.at(-1)?.origin, 'voice', 'same-target refocus forwards explicit authority');
    assert.equal(militaryFlightsLayer.refocusTrackedById(icao24), true);
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

    militaryFlightsLayer.setParams(
      { selectedMilitaryTrackingId: 'late001' },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late001');
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _addMilitaryTrackingCandidateForTest({
      icao24: 'late001',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-96.9, 31.1, 8_000) },
      meta: { ...FULL_INFO, callsign: 'LATE1', rawLat: 31.1, rawLon: -96.9 },
      history: [],
    });
    _applyPendingMilitaryTrackingRestoreForTest();
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, icao24);

    militaryFlightsLayer.stopTracking();
    militaryFlightsLayer.setParams(
      { selectedMilitaryTrackingId: 'late002' },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late002');
    militaryFlightsLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');
    _addMilitaryTrackingCandidateForTest({
      icao24: 'late002',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-96.8, 31.2, 7_000) },
      meta: { ...FULL_INFO, callsign: 'LATE2', rawLat: 31.2, rawLon: -96.8 },
      history: [],
    });
    _applyPendingMilitaryTrackingRestoreForTest();
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, null);

    militaryFlightsLayer.setParams(
      { selectedMilitaryTrackingId: 'late003' },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late003');
    militaryFlightsLayer.setParams({ models3d: false }, { origin: 'voice' });
    assert.equal(
      _pendingMilitaryTrackingRestoreForTest(),
      null,
      'a newer explicit non-selection option cancels stale restore',
    );
    _addMilitaryTrackingCandidateForTest({
      icao24: 'late003',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.3, 30.6, 7_000) },
      meta: { ...FULL_INFO, callsign: 'LATE3', rawLat: 30.6, rawLon: -97.3 },
      history: [],
    });
    _applyPendingMilitaryTrackingRestoreForTest();
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, null);

    militaryFlightsLayer.setParams(
      { selectedMilitaryTrackingId: 'late004' },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late004');
    _addMilitaryTrackingCandidateForTest({
      icao24: 'late004',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-97.2, 30.7, 6_000) },
      meta: { ...FULL_INFO, callsign: 'LATE4', rawLat: 30.7, rawLon: -97.2 },
      history: [],
    });
    assert.equal(_applyPendingMilitaryTrackingRestoreForTest(), true);
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, 'late004');

    militaryFlightsLayer.setParams(
      { selectedMilitaryTrackingId: 'late005' },
      { origin: 'local-restore' },
    );
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    assert.equal(
      _pendingMilitaryTrackingRestoreForTest(),
      'late005',
      'passive autofocus cannot revoke the restored target still waiting for its feed row',
    );
    _addMilitaryTrackingCandidateForTest({
      icao24: 'late005',
      billboard: { ...billboard, position: Cesium.Cartesian3.fromDegrees(-96.6, 31.4, 5_000) },
      meta: { ...FULL_INFO, callsign: 'LATE5', rawLat: 31.4, rawLon: -96.6 },
      history: [],
    });
    assert.equal(_applyPendingMilitaryTrackingRestoreForTest(), true);
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, 'late005');
  } finally {
    militaryFlightsLayer.stopTracking();
    viewer.scene.preUpdate.raiseEvent();
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  }
});

/**
 * The tool instructions tell the model to look a contact up with analyst_query
 * and then hand that identity to track_entity. The analyst's `id` is a DISPLAY
 * label — callsign, else registration, else hex — while the lookup matched
 * callsigns and hex only, so a callsign-less contact came back as its tail
 * number and "Nothing matched" (field session 2026-08-21, 23:48: three
 * failed retries before a fallback stuck).
 */
test('a callsign-less contact is findable by the tail number the app displays', () => {
  const icao24 = 'ae7f01';
  _addMilitaryTrackingCandidateForTest({
    icao24,
    meta: {
      callsign: null,
      registration: '6606',
      type: 'UH60',
      operator: 'US Army',
      altitudeFt: 550,
      speedMps: 67,
      track: 210,
      klass: 'helicopter',
      onGround: false,
      rawLat: 40.71,
      rawLon: -74.01,
    },
    billboard: {
      position: Cesium.Cartesian3.fromDegrees(-74.01, 40.71, 167),
      color: Cesium.Color.WHITE,
      show: true,
    },
  });

  // The identity analyst_query hands back for this contact.
  const analystId = mapAnalystRecord(icao24, {
    callsign: null, registration: '6606', rawLat: 40.71, rawLon: -74.01,
  }).id;
  assert.equal(analystId, '6606', 'the analyst names a callsign-less contact by its tail');

  const found = militaryFlightsLayer.findByQuery(analystId);
  assert.equal(found?.icao24, icao24, 'and the tracker must resolve that same identity');
  assert.equal(militaryFlightsLayer.findByQuery('660')?.icao24, icao24, 'prefix match too');
  assert.equal(militaryFlightsLayer.findByQuery(icao24)?.icao24, icao24, 'hex still wins outright');
});

test('the analyst record carries the hex key the tracker keys on', () => {
  const record = mapAnalystRecord('ae7f01', {
    callsign: null, registration: '6606', rawLat: 40.71, rawLon: -74.01,
  });
  assert.equal(record.icao24, 'ae7f01', 'a resolvable key must ride along with the display label');
});

test('a registration never outranks another contact’s exact callsign', () => {
  // Feed order used to decide this: both identities landed in the same "exact"
  // bucket, so whichever contact the upstream Map listed first won and the same
  // spoken query could follow a different aircraft between polls.
  const billboardAt = (lon, lat) => ({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 3000),
    color: Cesium.Color.WHITE,
    show: true,
  });
  const base = {
    type: 'C17', operator: 'USAF', altitudeFt: 25000, speedMps: 180,
    track: 90, klass: 'widebody', onGround: false,
  };
  // Registered FIRST, so insertion order favours it.
  _addMilitaryTrackingCandidateForTest({
    icao24: 'ae0aa1',
    meta: { ...base, callsign: null, registration: 'ZULU777', rawLat: 31.0, rawLon: -97.0 },
    billboard: billboardAt(-97.0, 31.0),
  });
  _addMilitaryTrackingCandidateForTest({
    icao24: 'ae0bb2',
    meta: { ...base, callsign: 'ZULU777', registration: '05-9999', rawLat: 31.2, rawLon: -97.2 },
    billboard: billboardAt(-97.2, 31.2),
  });

  assert.equal(
    militaryFlightsLayer.findByQuery('ZULU777')?.icao24,
    'ae0bb2',
    'the contact whose CALLSIGN is ZULU777 wins, not the one listed first',
  );
  assert.equal(
    militaryFlightsLayer.findByQuery('059999')?.icao24,
    'ae0bb2',
    'and a separator-free registration still resolves',
  );
});

test('two contacts matching at the same strength resolve deterministically', () => {
  const billboardAt = (lon, lat) => ({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 3000),
    color: Cesium.Color.WHITE,
    show: true,
  });
  const base = {
    type: 'C130', operator: 'USAF', altitudeFt: 21000, speedMps: 150,
    track: 45, klass: 'turboprop', onGround: false,
  };
  // Both registrations begin with QQ7 — a same-tier prefix tie. Registered
  // highest-hex first so insertion order would pick the wrong one.
  _addMilitaryTrackingCandidateForTest({
    icao24: 'aef002',
    meta: { ...base, callsign: null, registration: 'QQ7-222', rawLat: 32.0, rawLon: -98.0 },
    billboard: billboardAt(-98.0, 32.0),
  });
  _addMilitaryTrackingCandidateForTest({
    icao24: 'aef001',
    meta: { ...base, callsign: null, registration: 'QQ7-111', rawLat: 32.1, rawLon: -98.1 },
    billboard: billboardAt(-98.1, 32.1),
  });

  const first = militaryFlightsLayer.findByQuery('QQ7')?.icao24;
  const second = militaryFlightsLayer.findByQuery('qq7')?.icao24;
  assert.equal(first, 'aef001', 'the stable key (lowest hex) wins, not the feed order');
  assert.equal(second, first, 'and the same query resolves the same way every time');
});
