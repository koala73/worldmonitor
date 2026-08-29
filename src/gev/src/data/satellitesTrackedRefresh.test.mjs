import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import {
  ISS_OVERLAY_SOURCE_OPTIONS,
  _applyPendingSatelliteTrackingRestoreForTest,
  _clearSatelliteLabelLifecycleForTest,
  _pendingSatelliteTrackingRestoreForTest,
  _removeSatelliteTrackingCandidateForTest,
  _runSatellitePreRenderForTest,
  _setSatelliteLabelLifecycleStateForTest,
  _setSatelliteTrackingRefreshOutcomeForTest,
  _setTrackedSatelliteRefreshStateForTest,
  _trackedFrameCartesianForTest,
  _trackIssForTest,
  createIssOverlayEntry,
} from './satellites.js';
import satellitesLayer from './satellites.js';
import { createTrackedOverlayEntry } from './trackedReadout.js';

const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

test('partial and dense catalogs do not make an early false missing decision', async () => {
  _setSatelliteTrackingRefreshOutcomeForTest({
    status: 'partial',
    failedGroups: ['stations.txt'],
  });
  const partial = await satellitesLayer.resolveTrackingRestoreTarget(987654);
  assert.equal(partial.status, 'source-unavailable');
  assert.match(partial.reason, /partial CelesTrak catalog/);

  let releaseDense;
  const densePromise = new Promise((resolve) => { releaseDense = resolve; });
  _setSatelliteTrackingRefreshOutcomeForTest({
    status: 'accepted',
    catalog: 'dense',
    densePromise,
  });
  let settled = false;
  const resolution = satellitesLayer.resolveTrackingRestoreTarget(987654)
    .then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, 'dense absence must wait for the dense catalog');
  releaseDense({ status: 'ready' });
  assert.equal((await resolution).status, 'missing');
  _setSatelliteTrackingRefreshOutcomeForTest({ status: 'accepted', catalog: 'core' });
});

test('satellite first update aborts every parallel catalog request', async () => {
  const realFetch = globalThis.fetch;
  const observedSignals = [];
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    observedSignals.push(options.signal);
    options.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const controller = new AbortController();
    const work = satellitesLayer.update({}, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignals.length > 1);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignals.every((signal) => signal?.aborted), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('selected satellite params survive delayed arrival and yield to newer explicit intent', () => {
  const point = {
    position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000),
    show: true,
    pixelSize: 12,
    color: Cesium.Color.RED,
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 2,
    disableDepthTestDistance: 0,
  };
  const viewer = {
    entities: new Cesium.EntityCollection(),
    trackedEntity: undefined,
    scene: {
      frameState: { frameNumber: 1 },
      primitives: { remove() {} },
    },
  };
  _setSatelliteLabelLifecycleStateForTest({
    viewer,
    satrec: twoline2satrec(L1, L2),
    point,
  });
  try {
    assert.doesNotThrow(() => satellitesLayer.setParams({ selectedSatTrackingId: 25544 }));
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);
    assert.equal(viewer.trackedEntity?.gevTrackedId, 'satellites:25544');

    satellitesLayer.stopTracking();
    _removeSatelliteTrackingCandidateForTest(25544);
    satellitesLayer.setParams(
      { selectedSatTrackingId: 25544 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 25544);
    _setSatelliteLabelLifecycleStateForTest({
      viewer,
      satrec: twoline2satrec(L1, L2),
      point,
      preservePending: true,
    });
    assert.equal(_applyPendingSatelliteTrackingRestoreForTest(), true);
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);

    satellitesLayer.setParams(
      { selectedSatTrackingId: 99999 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 99999);
    assert.equal(satellitesLayer.trackById(25544, { origin: 'user' }), true);
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);

    satellitesLayer.stopTracking();
    _removeSatelliteTrackingCandidateForTest(25544);
    satellitesLayer.setParams(
      { selectedSatTrackingId: 25544 },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 25544);
    satellitesLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');
    _setSatelliteLabelLifecycleStateForTest({
      viewer,
      satrec: twoline2satrec(L1, L2),
      point,
      preservePending: true,
    });
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, null);

    satellitesLayer.setParams(
      { selectedSatTrackingId: 50003 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 50003);
    satellitesLayer.setParams({ showPoints: true }, { origin: 'tool' });
    assert.equal(
      _pendingSatelliteTrackingRestoreForTest(),
      null,
      'a newer explicit non-selection option cancels stale restore',
    );
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, null);
  } finally {
    _clearSatelliteLabelLifecycleForTest();
  }
});

test('a tracked docked cluster consolidates its companions onto one card', () => {
  // ISS and everything berthed to it are separate real tracks at one position,
  // so their ambient labels stack underneath the tracked card. Product decision:
  // consolidate them as secondary info on that card, and suppress only those
  // members — never unrelated satellites that merely happen to be nearby.
  const entity = { gevLabelModel: { title: 'OLD', details: ['? km'] } };
  const point = { position: new Cesium.Cartesian3() };
  const viewer = { camera: null, scene: { frameState: { frameNumber: 1 } } };
  let nowMs = Date.UTC(2008, 8, 20, 12, 30);
  // The tracked satellite moves ~7.6 km/s, so neighbours are defined RELATIVE to
  // wherever it is at scan time rather than pinned to a stale sample.
  const near = (metres) => ({
    get position() {
      const tracked = _trackedFrameCartesianForTest();
      return new Cesium.Cartesian3(tracked.x + metres, tracked.y, tracked.z);
    },
  });

  _setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec: twoline2satrec(L1, L2),
    entity,
    point,
    viewer,
    now: () => nowMs,
    neighbours: [
      { noradId: 55555, name: 'PROGRESS-MS 34', point: near(120) },   // berthed
      { noradId: 55556, name: 'SOYUZ-MS 12', point: near(-90) },      // berthed
      { noradId: 99999, name: 'UNRELATED SAT', point: near(50_000) }, // 50 km away
    ],
  });

  _runSatellitePreRenderForTest();
  // The cluster scan is throttled, so advance past its interval before the frame
  // that must observe the cluster.
  nowMs += 2000;
  viewer.scene.frameState.frameNumber = 2;
  _runSatellitePreRenderForTest();

  const details = entity.gevLabelModel.details;
  // Class leads the detail block; the altitude line follows it, and the
  // consolidated companions stay last.
  assert.equal(details[0], 'STATION · ISS', 'the class line names what this is');
  assert.match(details[1], /NORAD 25544$/, 'the altitude line is unchanged');
  assert.equal(details[2], 'DOCKED · PROGRESS-MS 34 · +1',
    'companions are consolidated, named, and counted on the tracked card');

  // Scoping is encoded in that string: THREE neighbours were seeded but only two
  // are counted (the named one plus "+1"). The satellite 50 km away is not part
  // of the cluster and keeps its own identity and label — the owner's explicit
  // constraint that unrelated nearby satellites are never suppressed.
  assert.doesNotMatch(details[2], /UNRELATED/);
  assert.doesNotMatch(details[2], /\+2/);
});
test('satellite pre-render refreshes the tracked altitude on each propagated frame', () => {
  const entity = { gevLabelModel: { title: 'OLD', details: ['? km'] } };
  const point = { position: new Cesium.Cartesian3() };
  const viewer = {
    camera: null,
    scene: { frameState: { frameNumber: 1 } },
  };
  const epochs = [
    Date.UTC(2008, 8, 20, 12, 30),
    Date.UTC(2008, 8, 20, 13, 0),
  ];
  let epochIndex = 0;
  _setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec: twoline2satrec(L1, L2),
    entity,
    point,
    viewer,
    now: () => epochs[epochIndex],
  });

  _runSatellitePreRenderForTest();
  assert.equal(entity.gevLabelModel.title, 'ISS (ZARYA)');
  assert.equal(entity.gevLabelModel.details[0], 'STATION · ISS');
  assert.equal(entity.gevLabelModel.details[1], '353 km · NORAD 25544');

  epochIndex = 1;
  viewer.scene.frameState.frameNumber = 2;
  _runSatellitePreRenderForTest();
  assert.equal(entity.gevLabelModel.details[1], '366 km · NORAD 25544');
  assert.equal(entity.gevLabelModel.details[0], 'STATION · ISS',
    'the class line survives an altitude-only republish');
});

test('ISS ambient and tracked lifecycle uses cached host entries with no native labels or duplicate text', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const point = {
    position: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000),
    show: true,
    pixelSize: 12,
    color: Cesium.Color.RED,
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 2,
    disableDepthTestDistance: 0,
  };
  const viewer = {
    entities: new Cesium.EntityCollection(),
    trackedEntity: undefined,
    scene: {
      frameState: { frameNumber: 1 },
      primitives: { remove() {} },
    },
  };
  let cleaned = false;
  _setSatelliteLabelLifecycleStateForTest({
    viewer,
    satrec: twoline2satrec(L1, L2),
    point,
    overlayHost,
  });
  try {
    const ambientPublication = calls.find(([type]) => type === 'entries');
    assert.ok(ambientPublication);
    assert.equal(ambientPublication[1], 'satellites-iss');
    assert.deepEqual(ambientPublication[3], ISS_OVERLAY_SOURCE_OPTIONS);
    const ambient = ambientPublication[2][0];
    assert.equal(ambient.title, 'ISS');
    assert.equal(ambient.position(), point.position, 'ISS getter reads the existing point cache');
    assert.equal(point.label, undefined, 'ISS point primitive carries no label graphic');

    const trackedEntity = _trackIssForTest();
    assert.ok(trackedEntity);
    assert.equal(viewer.entities.values.length, 1, 'runtime guard requires a real tracked entity');
    assert.equal(trackedEntity.label, undefined);
    assert.ok(trackedEntity.point, 'tracked dot remains on the entity for camera framing');
    const trackedEntry = createTrackedOverlayEntry(trackedEntity);
    assert.ok(trackedEntry);
    assert.equal(trackedEntry.id, 'satellites:25544');
    assert.equal(trackedEntry.protected, true);
    assert.equal(trackedEntry.paintLane, 'tracked');
    assert.equal(
      calls.filter(([type, sourceId]) => type === 'entries' && sourceId === 'satellites-iss').length,
      2,
      'tracking may refresh before ownership changes but must not publish a second ISS entry',
    );
    assert.deepEqual(calls.slice(-2), [
      ['clear', 'satellites-iss'],
      ['visible', 'satellites-iss', false],
    ], 'tracked ISS suppresses ambient text so the tracked card is the only text surface');

    _clearSatelliteLabelLifecycleForTest();
    cleaned = true;
    assert.equal(viewer.entities.values.length, 0);
    assert.equal(
      calls.filter(([type, sourceId]) => type === 'entries' && sourceId === 'satellites-iss').length,
      3,
      'untracking republishes exactly one persistent ISS ambient entry before teardown',
    );
  } finally {
    if (!cleaned) _clearSatelliteLabelLifecycleForTest();
  }
});

test('ISS overlay entry retains the native distance scale and source text', () => {
  const position = new Cesium.Cartesian3(1, 2, 3);
  const entry = createIssOverlayEntry(() => position);
  assert.equal(entry.title, 'ISS');
  assert.equal(entry.position(), position);
  assert.deepEqual(entry.distanceScale, {
    near: 1_000_000,
    nearValue: 1,
    far: 30_000_000,
    farValue: 0.4,
  });
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});
