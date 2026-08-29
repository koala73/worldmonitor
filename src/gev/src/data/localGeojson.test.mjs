import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  GROUND_SAMPLE_MAX_ARMED_RETRIES,
  LOCAL_OVERLAY_COHORT_LIMIT,
  LOCAL_STEM_TIP_EPSILON_M,
  createLocalGeoJsonLayer,
  createLocalInfrastructureOverlayEntry,
  createLocalInfrastructureOverlayPublisher,
  localDatasetError,
  localInfrastructureOverlayCopy,
  selectLocalInfrastructureOverlayCohort,
} from './localGeojson.js';
import { layerFeedState } from './manager.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

class MockLayerEvent {
  constructor() {
    this.listeners = new Set();
    this.addCount = 0;
    this.removeCount = 0;
  }

  addEventListener(listener) {
    this.addCount++;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.removeCount++;
      this.listeners.delete(listener);
    };
  }

  raise(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.sampleHeightSupported] Scene height-sampling capability.
 * @param {Function} [options.sampleHeight] Initial scene.sampleHeight behavior
 *   (default: throws like a scene whose tiles are not sampleable yet).
 */
async function createRealLocalLayerHarness({
  sampleHeightSupported = false,
  sampleHeight = () => { throw new Error('tiles not sampleable yet'); },
} = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const preRender = new MockLayerEvent();
  const moveEnd = new MockLayerEvent();
  const dataSources = [];
  const hostCalls = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      type: 'Feature',
      id: 'real-dam',
      properties: { name: 'Runtime Dam', tags: { associated_river: 'Test River' } },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-97.70, 30.20],
          [-97.69, 30.20],
          [-97.69, 30.21],
          [-97.70, 30.20],
        ]],
      },
    }),
  });
  globalThis.window = { dispatchEvent() {} };
  let sampleHeightImpl = sampleHeight;
  const sampleCalls = { count: 0 };
  const overlayHost = {
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 100_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd,
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender,
      sampleHeightSupported,
      sampleHeight: (...args) => {
        sampleCalls.count += 1;
        return sampleHeightImpl(...args);
      },
      screenSpaceCameraController: { enableInputs: true },
      pick() { return null; },
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/runtime-dam.geojsonl',
    name: 'Runtime Dams',
    color: '#0088ff',
    overlayHost,
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  try {
    await layer.enable(viewer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    layer,
    viewer,
    dataSources,
    hostCalls,
    preRender,
    moveEnd,
    sampleCalls,
    /** Swap scene.sampleHeight mid-test (e.g. tiles finally arrive). */
    setSampleHeight(next) { sampleHeightImpl = next; },
    cleanup() {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('local infrastructure card copy uses the validated source fields', () => {
  assert.deepEqual(localInfrastructureOverlayCopy({
    tags: {
      name: 'DFW-1',
      operator: 'Example Cloud',
      'capacity:it_load': '27 MW',
    },
  }, 'local-datacenters'), {
    title: 'DFW-1',
    details: ['Example Cloud · 27 MW'],
  });

  assert.deepEqual(localInfrastructureOverlayCopy({
    name: 'Barrage Bin el Ouidane',
    tags: { associated_river: 'El Abid' },
  }, 'local-dams'), {
    title: 'Barrage Bin el Ouidane',
    details: ['El Abid'],
  });

  assert.deepEqual(localInfrastructureOverlayCopy({
    tags: { name: 'Amazon Web Services', operator: 'Amazon Web Services' },
  }, 'local-datacenters'), {
    title: 'Amazon Web Services',
    details: [],
  });
});

test('local infrastructure entries satisfy the shared presentation contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 2000);
  const entry = createLocalInfrastructureOverlayEntry({
    id: 'dc-42',
    layerId: 'local-datacenters',
    position,
    properties: { tags: { name: 'AUS-1', operator: 'Example Cloud' } },
    priority: 1180,
    accent: '#00ffff',
  });

  assert.equal(entry.id, 'dc-42');
  assert.equal(entry.source, 'local-datacenters');
  assert.equal(entry.position, position, 'entry stays attached to the mutable stem-tip Cartesian');
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, 'AUS-1');
  assert.deepEqual(entry.details, ['Example Cloud']);
  assert.equal(entry.priority, 1180);
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.interactive, false, 'point/stem picking remains Cesium-native');
  assert.equal(entry.maxDistance, 14_000_000);
  assert.equal(entry.distanceFadeStartRatio, 250_000 / 14_000_000);
  assert.deepEqual(entry.distanceScale, {
    near: 250_000,
    nearValue: 1,
    far: 9_000_000,
    farValue: 0.62,
  });
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
});

test('shipped local cohorts keep one grid winner plus bounded surplus contenders', () => {
  const makeRecord = (id, priority, x, y = 20) => ({
    id,
    priority,
    screen: { x, y },
    entry: { id },
  });
  const sameCell = [
    makeRecord('low', 1, 20),
    makeRecord('high', 3, 21),
    makeRecord('mid', 2, 22),
    makeRecord('offscreen', 100, -500),
  ];
  const selected = selectLocalInfrastructureOverlayCohort(sameCell, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 1440,
    height: 900,
    project: (record) => record.screen,
  });
  assert.deepEqual(selected.map(({ id }) => id), ['high', 'mid']);

  const field = Array.from({ length: 220 }, (_, index) => makeRecord(
    `record-${index}`,
    1000 - index,
    index * 140,
  ));
  const datacenters = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  const dams = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 900,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 132,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(datacenters.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(dams.length, LOCAL_OVERLAY_COHORT_LIMIT);

  const pairedCells = Array.from({ length: 120 }, (_, index) => [
    makeRecord(`primary-${index}`, 1000, index * 140),
    makeRecord(`surplus-${index}`, 900, index * 140 + 1),
  ]).flat();
  const hostBound = selectLocalInfrastructureOverlayCohort(pairedCells, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 20_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(hostBound.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(hostBound.filter(({ id }) => id.startsWith('primary-')).length, 120);
  assert.equal(hostBound.filter(({ id }) => id.startsWith('surplus-')).length, 40);
});

test('local overlay publisher owns add/remove/visibility lifecycle and becomes inert on destroy', () => {
  const calls = [];
  const publisher = createLocalInfrastructureOverlayPublisher({
    sourceId: 'local-datacenters',
    host: {
      setVisible: (...args) => calls.push(['visible', ...args]),
      setEntries: (...args) => calls.push(['entries', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
  });

  publisher.publish([{ id: 'ignored-before-show' }]);
  publisher.show();
  publisher.show();
  publisher.publish([{ id: 'dc-1' }]);
  publisher.publish([]);
  publisher.hide();
  publisher.show();
  publisher.publish([{ id: 'dc-2' }]);
  publisher.destroy();
  const countAtDestroy = calls.length;
  publisher.show();
  publisher.publish([{ id: 'zombie' }]);

  assert.equal(calls.length, countAtDestroy, 'destroyed publishers reject late source work');
  assert.deepEqual(calls[0], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[1].slice(0, 3), ['entries', 'local-datacenters', [{ id: 'dc-1' }]]);
  assert.deepEqual(calls[1][3], {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: 96,
    moving: false,
  });
  assert.deepEqual(calls[2].slice(0, 3), ['entries', 'local-datacenters', []]);
  assert.deepEqual(calls[3], ['visible', 'local-datacenters', false]);
  assert.deepEqual(calls[4], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[6], ['clear', 'local-datacenters']);
  assert.deepEqual(calls[7], ['visible', 'local-datacenters', false]);
});

test('real layer disable clears its published host entries and balances settle listeners', async () => {
  const env = await createRealLocalLayerHarness();
  env.preRender.raise();
  assert.ok(env.hostCalls.some(([type]) => type === 'entries'), 'real preRender path did not publish');

  env.layer.disable(env.viewer);
  assert.ok(
    env.hostCalls.some((call) => call[0] === 'clear' && call[1] === 'local-dams'),
    'real disable path must clear the host source',
  );
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.moveEnd.addCount, 1);
  assert.equal(env.moveEnd.removeCount, 1);

  await env.layer.enable(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(env.moveEnd.listeners.size, 1, 'repeated enable must retain one settle listener');
  env.layer.disable(env.viewer);
  assert.equal(env.moveEnd.addCount, 2);
  assert.equal(env.moveEnd.removeCount, 2);

  await env.layer.enable(env.viewer);
  env.layer.destroy(env.viewer);
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.moveEnd.addCount, 3);
  assert.equal(env.moveEnd.removeCount, 3);
  const addCountAtDestroy = env.moveEnd.addCount;
  await env.layer.enable(env.viewer);
  assert.equal(env.moveEnd.addCount, addCountAtDestroy, 'destroyed layer must stay permanently inert');
  env.cleanup();
});

test('unchanged moveEnds do not redefine stem constants and real tip changes update once', async () => {
  const env = await createRealLocalLayerHarness();
  env.preRender.raise();
  const entity = env.dataSources[0].entities.values[0];
  let positionSetCalls = 0;
  let polylineSetCalls = 0;
  let polylineDefinitionChanges = 0;
  const stemArrays = [];
  const initialStemArray = entity.polyline.positions.getValue();
  const originalPositionSet = entity.position.setValue.bind(entity.position);
  const originalPolylineSet = entity.polyline.positions.setValue.bind(entity.polyline.positions);
  const removeDefinitionListener = entity.polyline.definitionChanged.addEventListener(
    (_polyline, propertyName) => {
      if (propertyName === 'positions') polylineDefinitionChanges++;
    },
  );
  entity.position.setValue = (...args) => {
    positionSetCalls++;
    return originalPositionSet(...args);
  };
  entity.polyline.positions.setValue = (...args) => {
    polylineSetCalls++;
    stemArrays.push(args[0]);
    return originalPolylineSet(...args);
  };

  env.moveEnd.raise();
  env.preRender.raise();
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 0);
  assert.equal(polylineSetCalls, 0);
  assert.equal(polylineDefinitionChanges, 0);

  const camera = env.viewer.camera.positionWC;
  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(LOCAL_STEM_TIP_EPSILON_M / 10, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 0, 'sub-epsilon camera noise must not redefine the tip');
  assert.equal(polylineSetCalls, 0);
  assert.equal(polylineDefinitionChanges, 0, 'sub-epsilon jitter must not redefine the polyline');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(10_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 1);
  assert.equal(polylineSetCalls, 1);
  assert.equal(polylineDefinitionChanges, 1, 'one real tip change must emit one polyline notification');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(20_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 2);
  assert.equal(polylineSetCalls, 2);
  assert.equal(polylineDefinitionChanges, 2, 'each real tip change must emit exactly one notification');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(30_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 3);
  assert.equal(polylineSetCalls, 3);
  assert.equal(polylineDefinitionChanges, 3, 'third real tip change must emit exactly one notification');
  assert.notEqual(stemArrays[0], initialStemArray, 'first real update must select the alternate buffer');
  assert.equal(stemArrays[1], initialStemArray, 'second real update must return to the initial buffer');
  assert.equal(stemArrays[2], stemArrays[0], 'consecutive real updates must alternate buffer identity');
  assert.equal(
    new Set([initialStemArray, ...stemArrays]).size,
    2,
    'steady-state updates must allocate no stem arrays beyond the two preallocated buffers',
  );
  removeDefinitionListener();
  env.layer.destroy(env.viewer);
  env.cleanup();
});

test('a real enabled local layer has no native label graphics at runtime', async () => {
  const env = await createRealLocalLayerHarness();
  const entities = env.dataSources[0].entities.values;
  assert.ok(entities.length > 0, 'runtime guard requires a populated real data source');
  assert.ok(entities.every((entity) => entity.label === undefined));
  env.layer.destroy(env.viewer);
  env.cleanup();
});

test('local infrastructure creates no native labels or per-frame geometry callbacks', () => {
  const source = readFileSync(new URL('./localGeojson.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Cesium\.LabelGraphics/);
  assert.doesNotMatch(source, /new Cesium\.CallbackProperty/);
  assert.match(source, /feature\.position = tip/);
  assert.match(source, /record\.entity\.position\.setValue\(record\.tip\)/);
  assert.match(source, /const stemPositionBuffers = \[\[base, tip\], \[base, tip\]\]/);
  assert.match(source, /record\.entity\.polyline\.positions\.setValue\(stemPositions\)/);
  assert.match(source, /viewer\.camera\.moveEnd\.addEventListener/);
  assert.match(source, /if \(refreshStemGeometry\)/);
  assert.match(source, /now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS/);
});

// ─── Bundled-dataset failure surfacing (roadmap L7) ───────────
//
// These datasets ship with the build, so a failed load means a broken
// install. Before this contract the catch only logged: a dead layer and an
// empty one both reported {count: 0} and the manager painted a green ON chip.

/** Build the failing layer alone — the harness above owns the happy path. */
async function enableLayerWithFetch(fetchImpl, { dataSources, windowStub } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = windowStub || { dispatchEvent() {} };
  const viewer = {
    dataSources: dataSources || { add() {}, remove() { return true; } },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1000), moveEnd: new MockLayerEvent() },
    scene: { canvas: {}, preRender: new MockLayerEvent(), pick() { return null; } },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/missing.geojsonl',
    name: 'Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const enable = async () => {
    globalThis.fetch = fetchImpl;
    try {
      await layer.enable(viewer);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
  await enable();
  const cleanup = () => {
    layer.destroy(viewer);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  };
  return { layer, viewer, cleanup, enable };
}

test('a bundled-dataset failure reduces to a short, honest reason', () => {
  assert.equal(
    localDatasetError(new SyntaxError('Unexpected token < in JSON at position 0')),
    'dataset is malformed',
  );
  assert.equal(localDatasetError(new Error('HTTP 404')), 'dataset unavailable (HTTP 404)');
  assert.equal(localDatasetError(new Error('')), 'dataset unavailable');
  assert.equal(localDatasetError(undefined), 'dataset unavailable');
});

test('a missing dataset reports UNAVAILABLE instead of a silent empty layer', async () => {
  const { layer, cleanup } = await enableLayerWithFetch(async () => ({
    ok: false,
    status: 404,
    text: async () => '<!DOCTYPE html>',
  }));
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(stats.error, 'dataset unavailable (HTTP 404)');
  assert.equal(layerFeedState(stats), 'unavailable');
  cleanup();
});

test('a corrupt dataset line reports malformed rather than parsing into nothing', async () => {
  const { layer, cleanup } = await enableLayerWithFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"type":"Feature"\n',
  }));
  const stats = layer.getStats();
  assert.equal(stats.error, 'dataset is malformed');
  assert.equal(layerFeedState(stats), 'unavailable');
  cleanup();
});

// Polygon, like the harness above: Cesium builds Point features through a
// canvas pin builder, which needs a DOM these tests do not have.
const ONE_POLYGON_FEATURE = JSON.stringify({
  type: 'Feature',
  id: 'dam-1',
  properties: { name: 'Test Dam' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[-97.70, 30.20], [-97.69, 30.20], [-97.69, 30.21], [-97.70, 30.20]]],
  },
});

const serveOnePolygon = async () => ({
  ok: true,
  status: 200,
  text: async () => ONE_POLYGON_FEATURE,
});

/**
 * Scene collection with Cesium's real timing: DataSourceCollection.add()
 * returns a promise and inserts on a LATER microtask, so the source is not in
 * the collection when add() returns. A synchronous mock hides exactly the bug
 * this models.
 */
function asyncDataSources({ rejectAdd = false } = {}) {
  const added = [];
  return {
    added,
    add(dataSource) {
      if (rejectAdd) return Promise.reject(new Error('scene rejected the data source'));
      return Promise.resolve().then(() => {
        added.push(dataSource);
        return dataSource;
      });
    },
    remove(dataSource) {
      const index = added.indexOf(dataSource);
      if (index >= 0) added.splice(index, 1);
      return index >= 0;
    },
  };
}

/** A window whose context store throws once — an exception during post-processing. */
function windowThatFailsOnce() {
  let armed = true;
  let store;
  return {
    dispatchEvent() {},
    get __gevContextStore() {
      if (armed) {
        armed = false;
        throw new Error('post-processing failed');
      }
      return store;
    },
    set __gevContextStore(value) { store = value; },
  };
}

test('a post-processing failure after the scene accepts the source rolls it back, and the retry does not double-add', async () => {
  // The window between GeoJsonDataSource.load() and the end of entity
  // post-processing. Publishing early made every later enable() skip the
  // loader; rolling back before the add settled left Cesium to insert the
  // "removed" source afterwards, which the retry would then double up on.
  const scene = asyncDataSources();
  const { layer, cleanup, enable } = await enableLayerWithFetch(serveOnePolygon, {
    dataSources: scene,
    windowStub: windowThatFailsOnce(),
  });

  const failed = layer.getStats();
  assert.equal(failed.error, 'dataset unavailable (post-processing failed)');
  assert.equal(failed.count, 0);
  assert.equal(failed.lastUpdate, null);
  assert.equal(layerFeedState(failed), 'unavailable');
  assert.equal(scene.added.length, 0,
    'rollback must remove the source the scene already accepted');

  await enable();
  const retried = layer.getStats();
  assert.equal(retried.error, null, 'the retry must clear the error, not skip the loader');
  assert.equal(retried.count, 1);
  assert.ok(Number.isFinite(retried.lastUpdate));
  assert.equal(scene.added.length, 1, 'the retry must not leave two sources in the scene');
  cleanup();
});

test('a rejected scene add surfaces as an error instead of healthy stats', async () => {
  const scene = asyncDataSources({ rejectAdd: true });
  const { layer, cleanup } = await enableLayerWithFetch(serveOnePolygon, {
    dataSources: scene,
  });
  const stats = layer.getStats();
  assert.equal(stats.error, 'dataset unavailable (scene rejected the data source)');
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(scene.added.length, 0);
  cleanup();
});

test('a loaded dataset is distinguishable from a dead one', async () => {
  const env = await createRealLocalLayerHarness();
  const stats = env.layer.getStats();
  assert.equal(stats.error, null);
  assert.ok(stats.count > 0);
  assert.ok(Number.isFinite(stats.lastUpdate), 'a successful load must timestamp itself');
  assert.equal(layerFeedState(stats), 'nominal');
  env.layer.destroy(env.viewer);
  env.cleanup();
});

// ── Ground-sample retry vs the idle render governor ───────────────────────────
//
// These layers take NO continuous hold and have updateInterval 0, so nothing
// else ever asks for a frame. The stem grounding retry lives in preRender: if
// the first sample fails (tiles not yet sampleable) and no frame is scheduled,
// a parked camera never produces the retry frame and the stem stays at
// ellipsoid height — buried in, or floating over, the photoreal mesh until the
// user happens to move. main retried continuously; under the governor the
// retry must schedule its own frame. (perf rebase 2026-08-17)

/** Drop the camera to `altM` above the fixture dam so retries are in range. */
function setCameraAltitude(env, altM) {
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-97.695, 30.205, altM);
}

function governorReasons() {
  return getRenderGovernorDiagnostics().recentRequests.map((entry) => entry.reason);
}

test('a failed ground sample schedules the retry frame the idle governor would never produce', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  // Close enough that a retry could succeed, on a scene that CAN sample but
  // whose tiles are not sampleable yet — a camera parked over a dam while the
  // photoreal mesh is still streaming in.
  setCameraAltitude(env, 20_000);
  env.preRender.raise();

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    'the request must be DEFERRED by the retry window, not fired inline',
  );
  t.mock.timers.tick(2_100); // GROUND_SAMPLE_RETRY_MS (2000) + slack
  assert.ok(
    governorReasons().includes('local-ground-retry:local-dams'),
    `expected a scheduled retry render; saw ${JSON.stringify(governorReasons())}`,
  );
});

test('a far camera arms no retry render — the governor stays fully idle', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  // 400 km up: way beyond GROUND_SAMPLE_MAX_DISTANCE_M, so no retry can ever
  // succeed and asking for frames would just spin the governor forever.
  setCameraAltitude(env, 400_000);
  env.preRender.raise();
  t.mock.timers.tick(5_000);

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `a far camera must not request frames; saw ${JSON.stringify(governorReasons())}`,
  );
});

test('disable cancels a pending ground-retry render', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  env.layer.disable(env.viewer);
  t.mock.timers.tick(5_000);

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `a disabled layer must not wake the scene; saw ${JSON.stringify(governorReasons())}`,
  );
});

// ── The retry must be able to STOP (second review) ───────────────────────────
//
// The retry above arms itself off its own requested frame, so anything that
// makes the sample permanently impossible turns it into a perpetual-motion
// machine: every frame it asks for schedules the next 2 s timer, and the idle
// governor never gets to sleep. Two gates close that: the scene CAPABILITY
// (a scene that cannot sample heights must never arm) and a bounded budget of
// consecutive arms (a sampleable scene with no sampleable surface).

/** Freeze performance.now so the 450 ms visibility gate is under test control. */
function installFakeClock(t, startMs = 1_000_000) {
  const original = performance.now;
  let nowMs = startMs;
  performance.now = () => nowMs;
  t.after(() => { performance.now = original; });
  return { advance(ms) { nowMs += ms; } };
}

/**
 * Run the self-armed retry chain: each preRender walk arms a timer, the timer
 * asks the governor for a frame, and that frame is the next walk.
 */
function runArmedRetryChain(env, t, clock, cycles) {
  for (let i = 0; i < cycles; i += 1) {
    env.preRender.raise();
    clock.advance(2_100); // > GROUND_SAMPLE_RETRY_MS, in lockstep with the timers
    t.mock.timers.tick(2_100);
  }
}

/** Height of the (mutated-in-place) stem base — 0 until a sample lands. */
function baseHeightM(env) {
  const entity = env.dataSources[0].entities.values[0];
  return Cesium.Cartographic.fromCartesian(entity.__localBaseCartesian).height;
}

/**
 * Count Cartesian3.distance calls. The retry path costs one per ungrounded
 * record per walk; on a scene that cannot sample, every one of them is waste
 * (O(N) every 450 ms in a keyless scene that some other layer keeps awake).
 */
function countDistanceCalls(t) {
  const original = Cesium.Cartesian3.distance;
  const calls = { count: 0 };
  Cesium.Cartesian3.distance = (...args) => {
    calls.count += 1;
    return original(...args);
  };
  t.after(() => { Cesium.Cartesian3.distance = original; });
  return calls;
}

test('a scene that cannot sample heights never arms a retry — not even once', async (t) => {
  // Keyless/no-sampleable-surface scene: sampleHeightSupported === false, so a
  // retry can NEVER succeed. Arming here re-armed forever (one 2 s timer per
  // requested frame) and quietly defeated the idle governor.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: false });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000); // in range: the ONLY thing missing is the capability
  // Settle the one-off geometry refresh (that walk legitimately measures the
  // camera distance to size the stem), then measure the STEADY state.
  env.preRender.raise();
  clock.advance(2_100);
  const distances = countDistanceCalls(t);
  runArmedRetryChain(env, t, clock, 5);

  assert.equal(governorScene.renders, 0, 'an unsampleable scene must ask for no frames at all');
  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `no retry may be armed without the capability; saw ${JSON.stringify(governorReasons())}`,
  );
  assert.equal(env.sampleCalls.count, 0, 'and it must not even attempt the sample');
  assert.equal(
    distances.count,
    0,
    'nor spend a single per-record distance on a retry that cannot succeed',
  );
  assert.equal(baseHeightM(env), 0, 'records stay at ellipsoid height — the pre-perf behavior');
});

test('a sampleable scene still measures the retry distance it needs', async (t) => {
  // The mirror of the guard above: the capability check must gate the work, not
  // remove it — a scene that CAN sample still pays one distance per walk.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  clock.advance(2_100);
  const distances = countDistanceCalls(t);
  runArmedRetryChain(env, t, clock, 5);

  assert.ok(distances.count > 0, 'the retry path must still measure range when it can sample');
  assert.ok(env.sampleCalls.count > 0, 'and must still attempt the sample');
});

test('capability arriving late re-opens a spent budget without camera motion', async (t) => {
  // WebGL context restore / a tileset that only becomes sampleable later. A
  // parked camera has no moveEnd to re-open the budget, so the false→true edge
  // must do it — otherwise the layer stays permanently given-up.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES + 2);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'budget spent');

  // Context lost, then restored — with the camera never touched.
  env.viewer.scene.sampleHeightSupported = false;
  runArmedRetryChain(env, t, clock, 2);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'no arming while unsupported');

  env.viewer.scene.sampleHeightSupported = true;
  runArmedRetryChain(env, t, clock, 3);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES + 3,
    'the false→true edge must re-open the budget on a parked camera',
  );
});

test('a sampleable scene that keeps failing gives up after a bounded run of arms', async (t) => {
  // Supported, but nothing under the feature is sampleable: every retry fails.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'the chain must run its full budget before giving up',
  );

  // Budget spent: further parked frames retry the sample (free) but ask for
  // nothing more — the idle governor is allowed to sleep.
  runArmedRetryChain(env, t, clock, 10);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'past the cap the layer must stop arming instead of re-arming forever',
  );
});

test('after the cap a camera-motion frame still samples, and re-opens the budget', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES + 3);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'budget spent');
  assert.equal(baseHeightM(env), 0, 'still ungrounded while the tiles were missing');

  // The tiles finally arrive. Camera-motion frames are free (the user is
  // already paying for them), so the walk they trigger must still sample.
  env.setSampleHeight(() => 210);
  setCameraAltitude(env, 19_000);
  env.moveEnd.raise();
  clock.advance(2_100);
  env.preRender.raise();

  assert.ok(
    Math.abs(baseHeightM(env) - 210) < 1e-6,
    `the motion frame must ground the stem; base height ${baseHeightM(env)}`,
  );

  // Grounded, so there is nothing left to arm: no new frame requests either.
  runArmedRetryChain(env, t, clock, 5);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'a grounded record asks for no further frames',
  );
});
