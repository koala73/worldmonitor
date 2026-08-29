import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approximateSurfaceDistanceM,
  classifyGoogleMilitaryPlace,
  installationSourceLabel,
  installationResponseSaturated,
  installationSurfaceHeightM,
  installationWithinViewport,
} from './militaryInstallations.js';
import militaryInstallationsLayer from './militaryInstallations.js';
import {
  _clearMeshFloorCellsForTest,
  cachedGroundFloor,
  FLOOR_RESOLVE_DEADLINE_MS,
  reportMeshFloorCell,
  setMeshFloorPreferred,
} from './groundFloor.js';
import { _resetFireAnchorsForTest } from './fireAnchors.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import * as Cesium from 'cesium';

test('cheap installation distance prefilter is local and antimeridian-safe', () => {
  const oneDegree = approximateSurfaceDistanceM(0, 0, 0, 1);
  assert.ok(oneDegree > 111000 && oneDegree < 111300);
  const acrossDateline = approximateSurfaceDistanceM(
    Cesium.Math.toRadians(10),
    Cesium.Math.toRadians(179.9),
    10,
    -179.9,
  );
  assert.ok(acrossDateline > 21000 && acrossDateline < 23000);
});

test('keeps generic Places hits distinct from explicitly typed military facilities', () => {
  assert.equal(classifyGoogleMilitaryPlace({ primaryType: 'military_base' }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ types: ['point_of_interest', 'military_base'] }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Army Recruiting Office', types: ['government_office'] }), 'places_candidate');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Military Museum', types: ['museum'] }), 'places_candidate');
});

test('reports the record source instead of attributing Places records to OpenStreetMap', () => {
  assert.equal(installationSourceLabel({ sources: [{ name: 'Google Maps Places' }] }), 'Google Maps Places');
  assert.equal(installationSourceLabel({ sources: [{ name: 'OpenStreetMap' }, { name: 'OpenStreetMap' }] }), 'OpenStreetMap');
});

test('places installation anchors on the shared cached rendered floor', () => {
  setMeshFloorPreferred(true);
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2, -97.7, 182.25);
  assert.equal(installationSurfaceHeightM({ latitude: 30.2, longitude: -97.7 }), 183.75);
  _clearMeshFloorCellsForTest();
});

test('real enabled installation entities carry no native label graphics', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const canvas = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/gev/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [{ ellipsoid: 100 }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'fresh',
        retrievedAt: '2026-08-02T00:00:00.000Z',
        elements: [{
          type: 'node',
          id: 42,
          lat: 30.2,
          lon: -97.7,
          tags: { military: 'base', name: 'Runtime Installation' },
        }],
      }),
    };
  };
  const moveEndListeners = new Set();
  const dataSources = [];
  const viewer = {
    camera: {
      moveEnd: {
        addEventListener(listener) {
          moveEndListeners.add(listener);
          return () => moveEndListeners.delete(listener);
        },
      },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();
    const entities = dataSources[0].entities.values;
    assert.ok(entities.length > 0, 'runtime guard requires rendered installation records');
    assert.ok(entities.every((entity) => entity.label === undefined));
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

const VIEWPORT = { south: 30, west: -98, north: 31, east: -97 };

test('Context focus past the render cap selects for real instead of flying blind', async () => {
  // Context navigation walks the FULL nearby cohort; only the first 700 records
  // get entities. Focusing item 701+ used to fly the camera, find no entity,
  // silently drop the selection, and report success — so the Context subject
  // stayed stale and NEXT offered the same installation forever.
  const elements = Array.from({ length: 760 }, (_, index) => ({
    type: 'node',
    id: 1000 + index,
    lat: 30.1 + (index % 40) * 0.002,
    lon: -97.9 + Math.floor(index / 40) * 0.002,
    tags: { military: 'base', name: `Installation ${index}` },
  }));
  const run = await runInstallationLoad({ elements });
  const flights = [];
  try {
    const renderedIds = new Set(run.entities().map((entity) => entity.id));
    assert.equal(renderedIds.size, 700, 'the ambient paint stays capped');

    const cohort = militaryInstallationsLayer.getNearby(
      Cesium.Cartesian3.fromDegrees(-97.8, 30.15, 0),
      Number.POSITIVE_INFINITY,
      5000,
    );
    assert.ok(cohort.length > 700, 'the cohort reaches past the render cap');
    const beyondCap = cohort.find((record) => !renderedIds.has(record.id));
    assert.ok(beyondCap, 'a cohort item exists outside the rendered window');

    const focused = militaryInstallationsLayer.focusById(beyondCap.id);
    assert.equal(focused, true, 'focus succeeds');
    // The proof: a real entity now backs the selection, so the Context subject
    // actually changes rather than the camera moving over a stale subject.
    const nowRendered = run.entities().find((entity) => entity.id === beyondCap.id);
    assert.ok(nowRendered, 'the focused record was rendered on demand');
    assert.equal(
      run.contextLabels().at(-1),
      beyondCap.name,
      'the selection reached the context store',
    );
  } finally {
    void flights;
    run.restore();
  }
});

/**
 * Drive one real `update()` of the layer against a stubbed proxy, and expose
 * what actually reached the map and the context store.
 */
async function runInstallationLoad({
  elements = [],
  saturated = false,
  exactElements = null,
  exactSaturated = false,
  legacyPayload = false,
  failWith = null,
}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const contextEvents = [];
  _resetRenderGovernorForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = {
    dispatchEvent(event) {
      if (event?.detail?.label) contextEvents.push(event.detail.label);
    },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/gev/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    requests.push(href);
    if (failWith) {
      return { ok: false, status: 503, json: async () => ({ error: failWith }) };
    }
    const exact = href.includes('exact=1');
    const payload = {
      status: 'fresh',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      elements: exact && exactElements ? exactElements : elements,
      elementCap: 700,
    };
    // A pre-fix cached entry carries no `saturated` field at all.
    if (!legacyPayload) payload.saturated = exact ? exactSaturated : saturated;
    return { ok: true, status: 200, json: async () => payload };
  };
  const dataSources = [];
  const cameraFlights = [];
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      flyToBoundingSphere(sphere, options) { cameraFlights.push({ sphere, options }); },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(VIEWPORT.south),
          west: Cesium.Math.toRadians(VIEWPORT.west),
          north: Cesium.Math.toRadians(VIEWPORT.north),
          east: Cesium.Math.toRadians(VIEWPORT.east),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
      // Enough surface for the real render governor to drive this viewer, so
      // one-shot render requests are observable.
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  militaryInstallationsLayer.init(viewer);
  installRenderGovernor(viewer);
  militaryInstallationsLayer.enable();
  await militaryInstallationsLayer.update();

  return {
    requests,
    cameraFlights,
    entities: () => dataSources[0]?.entities?.values || [],
    contextLabels: () => contextEvents,
    stats: () => militaryInstallationsLayer.getStats(),
    renderRequests: () => getRenderGovernorDiagnostics().recentRequests.map((item) => item.reason),
    restore() {
      militaryInstallationsLayer.destroy(viewer);
      _resetRenderGovernorForTest();
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('viewport membership keeps intersecting footprints and drops the snap ring', () => {
  const inside = { osmType: 'node', latitude: 30.5, longitude: -97.5, footprint: null };
  const outside = { osmType: 'node', latitude: 30.5, longitude: -96.5, footprint: null };
  assert.equal(installationWithinViewport(inside, VIEWPORT), true);
  assert.equal(installationWithinViewport(outside, VIEWPORT), false);

  // A large base whose CENTRE sits just outside but whose footprint overlaps
  // was always returned by the bbox query and must keep rendering.
  const straddling = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.95,
    footprint: [[-97.05, 30.4], [-96.9, 30.4], [-96.9, 30.6], [-97.05, 30.6]],
  };
  assert.equal(installationWithinViewport(straddling, VIEWPORT), true);

  const farWithFootprint = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.5,
    footprint: [[-96.6, 30.4], [-96.4, 30.4], [-96.4, 30.6], [-96.6, 30.6]],
  };
  assert.equal(installationWithinViewport(farWithFootprint, VIEWPORT), false);
  assert.equal(installationWithinViewport(null, VIEWPORT), false);
  assert.equal(installationWithinViewport(inside, null), false);
});

test('extended features with unknown extent are kept, not centre-tested', () => {
  // Relations carry geometry on their members and ways over MAX_FOOTPRINT_POINTS
  // are normalized without one, so their true extent is unknown here. Overpass
  // already proved they intersect the queried bbox; centre-testing them would
  // erase exactly the biggest installations.
  const relation = { osmType: 'relation', latitude: 30.5, longitude: -96.99, footprint: null };
  const hugeWay = { osmType: 'way', latitude: 29.5, longitude: -97.5, footprint: null };
  assert.equal(installationWithinViewport(relation, VIEWPORT), true);
  assert.equal(installationWithinViewport(hugeWay, VIEWPORT), true);
  // A node IS its geometry, so excluding it on centre loses nothing.
  assert.equal(
    installationWithinViewport({ osmType: 'node', latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT),
    false,
  );
  // Unknown provenance is treated inclusively, same as an extended feature.
  assert.equal(installationWithinViewport({ latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT), true);
});

test('a footprint-less relation just outside the viewport still renders', async () => {
  const harness = await runInstallationLoad({
    elements: [
      // A relation whose CENTER sits outside the viewport and whose geometry
      // lives on members Overpass did not inline. It was returned because it
      // intersects the queried bbox, so it must survive the viewport filter.
      { type: 'relation', id: 91, center: { lat: 30.5, lon: -96.995 }, tags: { military: 'range', name: 'Straddling Range' } },
      // A NODE at the same off-view spot has no extent and must still be cut.
      { type: 'node', id: 92, lat: 30.5, lon: -96.995, tags: { military: 'range', name: 'Off View Node' } },
    ],
  });
  try {
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Straddling Range'],
    );
  } finally {
    harness.restore();
  }
});

test('a legacy cached response with no saturation flag still triggers the exact retry', () => {
  const atCap = { elements: new Array(700).fill({ type: 'node' }), elementCap: 700 };
  assert.equal(installationResponseSaturated(atCap), true, 'derived from the reported cap');
  assert.equal(
    installationResponseSaturated({ elements: new Array(699).fill({ type: 'node' }), elementCap: 700 }),
    false,
  );
  // An explicit flag always wins over the derivation.
  assert.equal(installationResponseSaturated({ ...atCap, saturated: false }), false);
  assert.equal(installationResponseSaturated({ elements: [], saturated: true }), true);
  // Nothing to derive from: do not invent saturation.
  assert.equal(installationResponseSaturated({ elements: new Array(700).fill({}) }), false);
  assert.equal(installationResponseSaturated(null), false);
});

test('a legacy-shaped payload at the cap fires the exact-viewport retry end to end', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 3000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    // Pre-fix cache shape: no `saturated` field at all, but at the cap.
    legacyPayload: true,
    exactElements: [
      { type: 'node', id: 8, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued From Legacy' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'a legacy entry must not skip the retry');
    assert.equal(harness.requests[1].includes('exact=1'), true);
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued From Legacy'],
    );
  } finally {
    harness.restore();
  }
});

test('a failed load buys the frame its status change needs', async () => {
  const harness = await runInstallationLoad({ failWith: 'Installation feed HTTP 503' });
  try {
    assert.equal(harness.stats().status, 'unavailable');
    assert.ok(
      harness.renderRequests().some((reason) => reason === 'installations-status'),
      'an idle governor would otherwise leave the last healthy readout on screen',
    );
  } finally {
    harness.restore();
  }
});

test('off-viewport records from the snapped superset never render or enter context', async () => {
  const harness = await runInstallationLoad({
    // The snapped bbox reaches ~5.5 km beyond the viewport; this node sits a
    // full degree outside it.
    elements: [
      { type: 'node', id: 1, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'In View' } },
      { type: 'node', id: 2, lat: 30.5, lon: -96.2, tags: { military: 'range', name: 'Off View' } },
    ],
  });
  try {
    const titles = harness.entities().map((entity) => entity.gevLabelModel?.title);
    assert.deepEqual(titles, ['In View'], 'only the in-viewport site renders');
    assert.equal(harness.contextLabels().includes('Off View'), false, 'and none enters context');
    assert.equal(harness.stats().count, 1);
  } finally {
    harness.restore();
  }
});

test('a saturated snapped tile refetches the exact viewport before rendering', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    // A saturated snapped response full of OFF-viewport sites: the in-view ones
    // were crowded out upstream.
    elements.push({ type: 'node', id: 1000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    saturated: true,
    exactElements: [
      { type: 'node', id: 7, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'saturation triggers exactly one retry');
    assert.equal(harness.requests[0].includes('exact=1'), false, 'first ask uses the shared snapped tile');
    assert.equal(harness.requests[1].includes('exact=1'), true, 'retry opts out of the snap');
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued'],
      'the in-viewport site is no longer starved by off-view ones',
    );
  } finally {
    harness.restore();
  }
});

test('an unsaturated response never pays for a second upstream ask', async () => {
  const harness = await runInstallationLoad({
    elements: [{ type: 'node', id: 3, lat: 30.5, lon: -97.5, tags: { military: 'range' } }],
  });
  try {
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.stats().saturated, false);
  } finally {
    harness.restore();
  }
});

test('a still-saturated exact viewport is reported honestly instead of implied complete', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 2000 + index, lat: 30.5, lon: -97.5, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({ elements, saturated: true, exactSaturated: true });
  try {
    assert.equal(harness.stats().saturated, true);
    assert.match(harness.stats().error, /Too many mapped sites/);
  } finally {
    harness.restore();
  }
});

test('a floor that lands after the render deadline lifts the dots off the ellipsoid', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  // A cell no other test in this file warms, so the assertion is about THIS
  // load, not a cache another test left behind.
  const lat = 44.123;
  const lon = -110.456;
  let terrainCalls = 0;
  setMeshFloorPreferred(false);
  _clearMeshFloorCellsForTest();
  _resetFireAnchorsForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/gev/terrain/heights')) {
      terrainCalls += 1;
      // The production failure: the bounded pre-render resolve gives up before
      // Re:Earth answers, so the first paint has no floor to stand on.
      if (terrainCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, FLOOR_RESOLVE_DEADLINE_MS + 200));
      }
      return { ok: true, status: 200, json: async () => ({ results: [{ ellipsoid: 2400 }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'fresh',
        retrievedAt: '2026-08-18T00:00:00.000Z',
        elements: [{ type: 'node', id: 77, lat, lon, tags: { military: 'range' } }],
      }),
    };
  };
  const dataSources = [];
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(44),
          west: Cesium.Math.toRadians(-111),
          north: Cesium.Math.toRadians(45),
          east: Cesium.Math.toRadians(-110),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  const heightOf = (entity) => Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    await militaryInstallationsLayer.update();

    const buried = dataSources[0].entities.values[0];
    assert.ok(buried, 'the cold-floor pass still renders the record');
    assert.ok(Math.abs(heightOf(buried)) < 1, 'a cold floor anchors at the ellipsoid, as before');

    // The warm chain resolves out of band; wait for the floor to land.
    for (let attempt = 0; attempt < 50 && cachedGroundFloor(lat, lon) == null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cachedGroundFloor(lat, lon), 2400, 'the late floor landed in the shared cache');

    const lifted = dataSources[0].entities.values[0];
    assert.ok(
      Math.abs(heightOf(lifted) - 2401.5) < 0.5,
      `re-render must lift the dot onto the resolved floor, got ${heightOf(lifted)}`,
    );
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    _resetFireAnchorsForTest();
    setMeshFloorPreferred(true);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('reports bounded installation requests as loading and clears on settlement', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let resolveInstallations;
  const installationsResponse = new Promise((resolve) => { resolveInstallations = resolve; });
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/gev/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    return installationsResponse;
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: { add(value) { return value; }, remove() { return true; } },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const update = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    assert.equal(
      militaryInstallationsLayer.getStats().loadingLabel,
      'loading mapped installation context',
    );
    resolveInstallations({
      ok: true,
      status: 200,
      json: async () => ({ status: 'fresh', elements: [] }),
    });
    await update;
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('zoom-out aborts an active installation request and returns non-loading guidance', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let globalView = false;
  let observedSignal;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (_url, options = {}) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return globalView ? null : {
          south: Cesium.Math.toRadians(30),
          west: Cesium.Math.toRadians(-98),
          north: Cesium.Math.toRadians(31),
          east: Cesium.Math.toRadians(-97),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
    },
    dataSources: { add(value) { return value; }, remove() { return true; } },
  };

  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const pending = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    globalView = true;
    await militaryInstallationsLayer.update();
    await pending;
    assert.equal(observedSignal.aborted, true);
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
    assert.equal(militaryInstallationsLayer.getStats().status, 'zoom-in');
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

// The unavailable-state retry: 'temporarily unavailable' must mean temporarily.
// Fetches otherwise fire only on enable and on camera moveEnd, so a parked
// camera whose first request failed stayed unavailable forever while the proxy
// sat healthy — observed in the field as a layer stuck reporting unavailable
// while its own endpoint served hundreds of features. The backoff progression
// is a pure exported helper so it pins without booting the layer (the full
// layer needs a Cesium viewer and interaction handlers); the wiring is pinned
// by source probes against the shipped file, the same technique the HUD datum
// tests use where a full boot is impractical.
import { installationRetryDelayMs } from './militaryInstallations.js';
import fs from 'node:fs';

const installationsSource = fs.readFileSync(
  new URL('./militaryInstallations.js', import.meta.url), 'utf8');

test('the unavailable retry backs off 30s to a 240s ceiling and restarts clean', () => {
  assert.equal(installationRetryDelayMs(0), 30000, 'first failure retries in 30s');
  assert.equal(installationRetryDelayMs(undefined), 30000, 'no prior delay means the minimum');
  assert.equal(installationRetryDelayMs(30000), 60000, 'each failure doubles');
  assert.equal(installationRetryDelayMs(60000), 120000);
  assert.equal(installationRetryDelayMs(120000), 240000, 'the ceiling is four minutes');
  assert.equal(installationRetryDelayMs(240000), 240000, 'and it stays there');
  assert.equal(installationRetryDelayMs(-5), 30000, 'garbage restarts at the minimum');
});

test('the retry is wired to every lifecycle edge, not just declared', () => {
  assert.match(installationsSource,
    /setInstallationStatus\('unavailable',[^]*?\);\n\s*scheduleUnavailableRetry\(\);/,
    'a failed load schedules the retry immediately after reporting unavailable');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\(\n?\s*state\.records\.length/,
    'a successful load clears the pending retry and resets the backoff');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\('zoom-in'/,
    'zooming out of range cancels the retry — moveEnd owns re-entry there');
  assert.match(installationsSource, /disable\(\) \{[^]*?clearUnavailableRetry\(\);/,
    'disabling the layer cancels the retry');
  assert.match(installationsSource,
    /function scheduleLoad\(\) \{[^]*?clearUnavailableRetry\(\{ resetBackoff: false \}\)/,
    'a user-driven load supersedes the retry without resetting the backoff step');
  assert.match(installationsSource,
    /state\.enabled && !state\.loading\) loadInstallations\(\)/,
    'the fired retry re-checks enablement and never races an in-flight load');
});
