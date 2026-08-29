import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  applyHorizonCull,
  createFirmsHeatmapLayer,
  fireCullPosition,
} from './firmsHeatmap.js';
import { FIRE_ANCHOR_LIFT_M } from './fireAnchors.js';
import { FIRMS_AMBIENT_COHORT_LIMIT, FIRMS_OVERLAY_SOURCE_ID } from './firmsLabels.js';
import {
  _clearMeshFloorCellsForTest,
  reportMeshFloorCell,
  setMeshFloorPreferred,
} from './groundFloor.js';
import { unregisterSpriteCollection } from './spriteOrder.js';
import { isOverlayPointVisible, normalizeOverlayEntry } from '../overlays/worldOverlay.js';

const AUSTIN = { lon: -97.7, lat: 30.2 };
/** Antipode of Austin — as far behind the limb as a point on Earth can be. */
const ANTIPODE = { lon: 82.3, lat: -30.2 };
const TOKYO = { lon: 139.7, lat: 35.7 };
/** Reported repro altitude for the through-the-globe defect. */
const REPRO_HEIGHT_M = 1_500_000;
/**
 * Longitude offset east of Austin where the horizon test DIVERGES between a
 * sub-ellipsoid anchor and a lifted one: at 1.5 Mm a point here reads hidden
 * at −22 m but visible at +5/+12 m. Measured against Cesium's own occluder.
 */
const LIMB_DLON = 41.87;

/**
 * Billboard stub that records every write to `show` so the tests can assert
 * the pass does not dirty the collection's vertex buffer needlessly.
 */
function billboard(position, show = true) {
  return {
    position,
    _show: show,
    writes: 0,
    get show() { return this._show; },
    set show(value) { this._show = value; this.writes += 1; },
  };
}

/** Cesium BillboardCollection-shaped stub. */
function collection(items) {
  return { length: items.length, get: (i) => items[i] };
}

/** Horizon occluder for a camera directly above Austin at `heightM`. */
function occluderOverAustin(heightM) {
  return new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, heightM),
  );
}

// ---------------------------------------------------------------------------
// The pure cull predicate
// ---------------------------------------------------------------------------

test('applyHorizonCull: far-side fires are hidden, near-side fires stay visible', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const near = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0));
  const nearby = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon + 6, AUSTIN.lat + 4, 0));
  const far = billboard(Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, 0));
  const otherSide = billboard(Cesium.Cartesian3.fromDegrees(TOKYO.lon, TOKYO.lat, 0));

  const visible = applyHorizonCull(collection([near, nearby, far, otherSide]), occluder);

  assert.equal(near.show, true, 'the fire under the camera renders');
  assert.equal(nearby.show, true, 'a fire well inside the horizon renders');
  assert.equal(far.show, false, 'the antipodal fire must not shine through the planet');
  assert.equal(otherSide.show, false, 'Tokyo is beyond the limb from Austin at 1.5 Mm');
  assert.equal(visible, 2, 'returns the surviving count');
});

test('applyHorizonCull: raising the camera reveals fires the low camera hid', () => {
  const paris = () => billboard(Cesium.Cartesian3.fromDegrees(2.35, 48.86, 0));

  const low = paris();
  applyHorizonCull(collection([low]), occluderOverAustin(REPRO_HEIGHT_M));
  assert.equal(low.show, false, 'Paris is over the horizon from a 1.5 Mm Austin camera');

  const high = paris();
  applyHorizonCull(collection([high]), occluderOverAustin(35_000_000));
  assert.equal(high.show, true, 'from geostationary height the same fire is in view');
});

test('applyHorizonCull: a hidden fire is restored when it swings back into view', () => {
  const revealed = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0), false);
  applyHorizonCull(collection([revealed]), occluderOverAustin(REPRO_HEIGHT_M));
  assert.equal(revealed.show, true, 'the cull un-hides as well as hides');
  assert.equal(revealed.writes, 1);
});

test('applyHorizonCull: only flipped billboards are written (vertex-buffer churn)', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const stays = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0), true);
  const flips = billboard(Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, 0), true);

  applyHorizonCull(collection([stays, flips]), occluder);
  applyHorizonCull(collection([stays, flips]), occluder);

  assert.equal(stays.writes, 0, 'an already-visible billboard is never re-assigned');
  assert.equal(flips.writes, 1, 'a hidden billboard is written once, not once per pass');
});

test('applyHorizonCull: missing collection/occluder/holes are no-ops, not throws', () => {
  assert.equal(applyHorizonCull(null, occluderOverAustin(REPRO_HEIGHT_M)), 0);
  assert.equal(applyHorizonCull({ length: 3 }, occluderOverAustin(REPRO_HEIGHT_M)), 0, 'non-collection shape');
  const item = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0));
  assert.equal(applyHorizonCull(collection([item]), null), 0, 'no occluder → leave the layer alone');
  assert.equal(applyHorizonCull(collection([item]), {}), 0, 'occluder without isPointVisible');
  assert.equal(item.writes, 0, 'a skipped pass must not touch show');
  assert.equal(
    applyHorizonCull(collection([undefined, item]), occluderOverAustin(REPRO_HEIGHT_M)),
    1,
    'sparse slots are skipped, surviving neighbours still counted',
  );
});

// ---------------------------------------------------------------------------
// Sub-ellipsoid anchors: datum-correct render point, lifted CULL point
// ---------------------------------------------------------------------------

test('applyHorizonCull: an index-aligned cull position overrides the render anchor', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const sunken = billboard(Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, -22));
  const lifted = Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, 12);

  applyHorizonCull(collection([sunken]), occluder);
  assert.equal(sunken.show, false, 'baseline: the raw sub-ellipsoid anchor false-hides at the limb');

  applyHorizonCull(collection([sunken]), occluder, [lifted]);
  assert.equal(sunken.show, true, 'the lifted cull point keeps the near-limb fire on screen');
});

test('applyHorizonCull: a lifted cull point does NOT resurrect a genuinely far-side fire', () => {
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);
  const far = billboard(Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, -22));
  const lifted = Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, 12);
  applyHorizonCull(collection([far]), occluder, [lifted]);
  assert.equal(far.show, false, '12 m of lift must not defeat the actual horizon cull');
});

test('fireCullPosition: negative-geoid anchor renders at the datum but culls lifted', () => {
  const lat = 30.2;
  const lon = AUSTIN.lon + LIMB_DLON;
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, -27);
  try {
    const fire = { index: 1, lat, lon, frp: 10, position: null };
    const cull = fireCullPosition(fire);
    const render = fire.position;
    const renderCarto = Cesium.Cartographic.fromCartesian(render);
    assert.ok(
      Math.abs(renderCarto.height - (-27 + FIRE_ANCHOR_LIFT_M)) < 0.5,
      `render anchor stays datum-correct at ${-27 + FIRE_ANCHOR_LIFT_M} m, got ${renderCarto.height}`,
    );

    assert.notEqual(cull, render, 'a sub-ellipsoid anchor gets a separate cull point');
    const cullCarto = Cesium.Cartographic.fromCartesian(cull);
    assert.ok(Math.abs(cullCarto.height - 12) < 0.5, `cull point lifted to 12 m, got ${cullCarto.height}`);
    assert.equal(fireCullPosition(fire), cull, 'the lifted point is cached, not re-allocated per call');

    // The whole point: the datum-correct point would be culled here, the lifted one is not.
    const occluder = occluderOverAustin(REPRO_HEIGHT_M);
    assert.equal(occluder.isPointVisible(render), false, 'baseline defect: −22 m reads beyond the horizon');
    assert.equal(occluder.isPointVisible(cull), true, 'lifted cull point reads correctly as in view');
  } finally {
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

test('fireCullPosition: a healthy above-ellipsoid anchor is its own cull point', () => {
  const lat = 45.5;
  const lon = -122.6;
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, 900);
  try {
    const fire = { index: 2, lat, lon, frp: 10, position: null };
    const cull = fireCullPosition(fire);
    assert.equal(cull, fire.position, 'no second Cartesian is allocated for the common case');
  } finally {
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

// ---------------------------------------------------------------------------
// World-overlay host wiring (cards)
// ---------------------------------------------------------------------------

test('isOverlayPointVisible: horizon test prefers entry.cullPosition when present', () => {
  const viewport = { width: 800, height: 600 };
  const screen = { x: 400, y: 300 };
  const render = Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, -22);
  const lifted = Cesium.Cartesian3.fromDegrees(AUSTIN.lon + LIMB_DLON, AUSTIN.lat, 12);
  const occluder = occluderOverAustin(REPRO_HEIGHT_M);

  assert.equal(
    isOverlayPointVisible({ horizonCull: true }, render, screen, viewport, occluder),
    false,
    'baseline: the render anchor alone false-hides the card',
  );
  assert.equal(
    isOverlayPointVisible({ horizonCull: true, cullPosition: lifted }, render, screen, viewport, occluder),
    true,
    'the supplied cull position is what the horizon test uses',
  );
  assert.equal(
    isOverlayPointVisible(
      { horizonCull: true, cullPosition: Cesium.Cartesian3.fromDegrees(ANTIPODE.lon, ANTIPODE.lat, 12) },
      render,
      screen,
      viewport,
      occluder,
    ),
    false,
    'a far-side cull position still culls',
  );
});

test('normalizeOverlayEntry: carries a valid cullPosition, nulls a junk one', () => {
  const position = { x: 1, y: 2, z: 3 };
  const kept = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: { x: 4, y: 5, z: 6 } });
  assert.ok(kept.cullPosition instanceof Cesium.Cartesian3, 'stored as a host-owned Cartesian3');
  assert.deepEqual(
    [kept.cullPosition.x, kept.cullPosition.y, kept.cullPosition.z],
    [4, 5, 6],
  );
  const dropped = normalizeOverlayEntry('firms', { id: 'b', position, cullPosition: { x: NaN, y: 5, z: 6 } });
  assert.equal(dropped.cullPosition, null, 'a malformed cull point falls back to the render position');
  const notAnObject = normalizeOverlayEntry('firms', { id: 'b2', position, cullPosition: 42 });
  assert.equal(notAnObject.cullPosition, null, 'a non-object cull point is rejected');
  // Non-adopting sources keep their existing BEHAVIOUR and steady-frame
  // allocation profile; the normalized record does gain an enumerable
  // `cullPosition: null` field, which is why this asserts null rather than
  // absence.
  const absent = normalizeOverlayEntry('firms', { id: 'c', position });
  assert.equal(absent.cullPosition, null, 'sources that do not opt in resolve to no cull anchor');
});

test('normalizeOverlayEntry: the stored cull anchor is a snapshot, not the caller object', () => {
  const position = { x: 1, y: 2, z: 3 };
  const caller = new Cesium.Cartesian3(4, 5, 6);
  const normalized = normalizeOverlayEntry('firms', { id: 'a', position, cullPosition: caller });
  assert.notEqual(normalized.cullPosition, caller, 'the host must not retain the caller reference');

  // Sources legitimately recycle scratch vectors between publishes; a mutation
  // after normalization must never reach the per-frame occluder.
  caller.x = NaN;
  caller.y = 999;
  assert.deepEqual(
    [normalized.cullPosition.x, normalized.cullPosition.y, normalized.cullPosition.z],
    [4, 5, 6],
    'post-normalize mutation of the source vector has no effect',
  );
});

test('normalizeOverlayEntry: an accessor-backed cullPosition is read exactly once', () => {
  const position = { x: 1, y: 2, z: 3 };
  let reads = 0;
  const entry = {
    id: 'a',
    position,
    get cullPosition() {
      reads += 1;
      return new Cesium.Cartesian3(4, 5, 6);
    },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(reads, 1, 'one property read — not one per validated component');
  assert.deepEqual(
    [normalized.cullPosition.x, normalized.cullPosition.y, normalized.cullPosition.z],
    [4, 5, 6],
  );
});

test('normalizeOverlayEntry: a throwing cullPosition accessor does not abort normalization', () => {
  const position = { x: 1, y: 2, z: 3 };
  const entry = {
    id: 'a',
    position,
    title: 'still normalized',
    get cullPosition() { throw new Error('hostile accessor'); },
  };
  const normalized = normalizeOverlayEntry('firms', entry);
  assert.equal(normalized.cullPosition, null, 'the bad anchor degrades to null');
  assert.equal(normalized.title, 'still normalized', 'the rest of the entry survives');
  assert.equal(normalized.id, 'a');
});

// ---------------------------------------------------------------------------
// Layer integration: the three production hooks
// ---------------------------------------------------------------------------

class MockEvent {
  constructor() { this.listeners = new Set(); }
  addEventListener(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of [...this.listeners]) listener(); }
}

/** Canvas stub good enough for the pre-baked glow sprites. */
function canvasStub() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }),
      fillStyle: null,
      fillRect() {},
    }),
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
  };
}

/** Proxy-shaped FIRMS record (firmsCsv shape) for the fetch stub. */
function rawFire(lat, lon, frp) {
  return {
    lat,
    lon,
    frp,
    confidence: 'h',
    brightness: 340,
    daynight: 'D',
    acqDate: '2026-08-03',
    acqTime: '0412',
    instrument: 'VIIRS',
    satellite: 'N20',
  };
}

/**
 * Boots the REAL layer against a headless viewer stub with a REAL
 * Cesium.BillboardCollection, so the production hooks (not just the pure
 * predicate) are what the assertions exercise.
 */
function createHarness(rawFires) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalProject = Cesium.SceneTransforms.worldToWindowCoordinates;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ fires: rawFires, fetchedAt: Date.now() }),
  });
  globalThis.window = globalThis.window || {};
  globalThis.document = { createElement: () => canvasStub() };

  // Deterministic projection: every distinct world position gets its own
  // 200 px grid slot (well clear of LABEL_MIN_SEP_PX) inside a 2000×2000
  // canvas, so declutter geometry never decides these assertions.
  const slots = new Map();
  Cesium.SceneTransforms.worldToWindowCoordinates = (scene, position, result) => {
    if (!slots.has(position)) slots.set(position, slots.size);
    const slot = slots.get(position);
    const out = result || new Cesium.Cartesian2();
    out.x = 100 + (slot % 10) * 200;
    out.y = 100 + Math.floor(slot / 10) * 200;
    return out;
  };

  const preRender = new MockEvent();
  const moveEnd = new MockEvent();
  const primitives = [];
  const entryCalls = [];
  const viewer = {
    dataSources: { add: (value) => value, remove: () => {} },
    camera: {
      moveEnd,
      positionWC: Cesium.Cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, REPRO_HEIGHT_M),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      positionCartographic: { height: REPRO_HEIGHT_M },
    },
    scene: {
      canvas: { clientWidth: 2000, clientHeight: 2000 },
      preRender,
      primitives: {
        add: (value) => { primitives.push(value); return value; },
        remove: () => {},
        contains: () => false,
      },
      frameState: { mode: Cesium.SceneMode.SCENE3D, mapProjection: new Cesium.GeographicProjection() },
      mapProjection: new Cesium.GeographicProjection(),
    },
  };

  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    overlayHost: {
      setEntries: (sourceId, entries) => entryCalls.push(entries),
      setVisible: () => {},
      clearSource: () => {},
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });

  return {
    layer,
    viewer,
    preRender,
    moveEnd,
    /** The real BillboardCollection the layer created. */
    billboards: () => primitives[0],
    /** Latest entry list published to the overlay host. */
    latestEntries: () => entryCalls[entryCalls.length - 1] || [],
    /** `show` flags keyed by billboard pick id. */
    showById() {
      const bb = primitives[0];
      const out = new Map();
      for (let i = 0; i < bb.length; i += 1) out.set(bb.get(i).id, bb.get(i).show);
      return out;
    },
    moveCameraTo(lon, lat, height = REPRO_HEIGHT_M) {
      viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      viewer.camera.positionCartographic = { height };
    },
    cleanup() {
      layer.destroy(viewer);
      unregisterSpriteCollection('firms');
      Cesium.SceneTransforms.worldToWindowCoordinates = originalProject;
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
      if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    },
  };
}

test('layer: a detection rebuild culls its own freshly-added sprites', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(ANTIPODE.lat, ANTIPODE.lon, 900),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    // No camera event has fired — only renderDetections ran.
    const show = harness.showById();
    assert.equal(show.size, 3, 'all three detections were rendered');
    assert.equal(show.get('firms-0'), true, 'the Austin fire under the camera is visible');
    assert.equal(show.get('firms-1'), false, 'the antipodal fire is culled at build time');
    assert.equal(show.get('firms-2'), false, 'the Tokyo fire is culled at build time');
  } finally {
    harness.cleanup();
  }
});

test('layer: camera moveEnd re-culls without a rebuild', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    assert.equal(harness.showById().get('firms-1'), false, 'precondition: Tokyo hidden from Austin');

    harness.moveCameraTo(TOKYO.lon, TOKYO.lat);
    harness.moveEnd.emit();

    const show = harness.showById();
    assert.equal(show.get('firms-1'), true, 'Tokyo becomes visible once the camera is over it');
    assert.equal(show.get('firms-0'), false, 'Austin drops behind the limb');
  } finally {
    harness.cleanup();
  }
});

test('layer: the throttled preRender watcher re-culls on a camera move', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    harness.moveCameraTo(TOKYO.lon, TOKYO.lat);
    // The watcher is throttled to LOD_CHECK_MS (650 ms) against
    // performance.now(), whose value at this point depends on process
    // start-up — so emit, wait out the full throttle window, and emit again.
    // Whichever tick passes the gate, one of them must run the pass.
    harness.preRender.emit();
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    harness.preRender.emit();

    const show = harness.showById();
    assert.equal(show.get('firms-1'), true, 'Tokyo revealed by the preRender pass');
    assert.equal(show.get('firms-0'), false, 'Austin culled by the preRender pass');
  } finally {
    harness.cleanup();
  }
});

test('layer: re-enabling after the camera moved does not expose stale far-side sprites', async () => {
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(TOKYO.lat, TOKYO.lon, 800),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);
    assert.equal(harness.showById().get('firms-1'), false, 'precondition: Tokyo hidden from Austin');

    harness.layer.disable();
    // The camera moves while the layer is OFF: moveEnd is not being listened
    // to, and the preRender watcher is inert. Nothing re-culls on its own.
    harness.moveCameraTo(TOKYO.lon, TOKYO.lat);
    await harness.layer.enable(harness.viewer);

    // Assert with NO camera event fired and NO refetch (fires are already
    // loaded, so enable() does not reload): the enable path itself must have
    // re-culled before the collection went visible.
    const show = harness.showById();
    assert.equal(harness.billboards().show, true, 'the collection is visible again');
    assert.equal(show.get('firms-1'), true, 'the Tokyo fire is revealed at enable time');
    assert.equal(show.get('firms-0'), false, 'the Austin fire is NOT left shining through the planet');
  } finally {
    harness.cleanup();
  }
});

test('layer: a near-limb fire on a sub-ellipsoid anchor is not culled by its datum', async () => {
  const lat = AUSTIN.lat;
  const lon = AUSTIN.lon + LIMB_DLON;
  // Negative-geoid coastal cell: ground floor −27 m → anchor −22 m, which the
  // occluder reads as beyond the horizon even though the fire is in view.
  setMeshFloorPreferred(true);
  reportMeshFloorCell(lat, lon, -27);
  const harness = createHarness([
    rawFire(AUSTIN.lat, AUSTIN.lon, 120),
    rawFire(lat, lon, 90),
  ]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);

    const bb = harness.billboards();
    const sunken = bb.get(1);
    const carto = Cesium.Cartographic.fromCartesian(sunken.position);
    assert.ok(
      Math.abs(carto.height - (-27 + FIRE_ANCHOR_LIFT_M)) < 0.5,
      `the sprite still RENDERS at the datum-correct anchor, got ${carto.height}`,
    );
    assert.equal(sunken.show, true, 'the near-limb fire stays on screen (lifted cull anchor)');
    assert.equal(harness.showById().get('firms-0'), true, 'the camera-nadir fire is unaffected');
  } finally {
    harness.cleanup();
    _clearMeshFloorCellsForTest();
    setMeshFloorPreferred(false);
  }
});

test('layer: far-side candidates never displace near-side ambient cards', async () => {
  const near = [];
  for (let i = 0; i < 6; i += 1) near.push(rawFire(AUSTIN.lat + i * 0.4, AUSTIN.lon + i * 0.4, 100 - i));
  const far = [];
  for (let i = 0; i < 20; i += 1) far.push(rawFire(ANTIPODE.lat + i * 0.4, ANTIPODE.lon + i * 0.4, 900 - i));
  // Far-side fires are the STRONGEST, so they lead the FRP-ranked candidate
  // walk and would eat all 18 ambient slots without the horizon skip.
  const harness = createHarness([...near, ...far]);
  try {
    harness.layer.init(harness.viewer);
    await harness.layer.enable(harness.viewer);

    const ids = harness.latestEntries().map((entry) => entry.id);
    assert.ok(ids.length > 0, 'cards were published');
    assert.ok(ids.length <= FIRMS_AMBIENT_COHORT_LIMIT, 'the ambient cap still holds');
    // Card ids are `fire:firms:<lat>:<lon>:<acqMs>:<sat>` (the refetch-stable
    // detection key), so a card is matched back to its seed by coordinate.
    const nearCoords = new Set(near.map((fire) => `${fire.lat.toFixed(4)}:${fire.lon.toFixed(4)}`));
    const nearIds = ids.filter((id) => nearCoords.has(id.split(':').slice(2, 4).join(':')));
    assert.equal(nearIds.length, 6, 'every in-view fire gets a card');
    assert.equal(new Set(nearIds).size, 6, 'six distinct near-side detections, not one repeated');
    assert.equal(ids.length, 6, 'no slot is spent on a fire behind the planet');
    assert.equal(FIRMS_OVERLAY_SOURCE_ID, 'firms');
  } finally {
    harness.cleanup();
  }
});
