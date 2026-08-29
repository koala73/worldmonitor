import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  applyFirmsOverlayPolicy,
  buildFireCard,
  buildCellCard,
  buildSelectedFireCard,
  createFirmsHeatmapLayer,
} from './firmsHeatmap.js';
import {
  accentForSeverity,
  FIRMS_AMBIENT_COHORT_LIMIT,
  FIRMS_OVERLAY_SOURCE_ID,
} from './firmsLabels.js';
import { FIRE_ANCHOR_LIFT_M } from './fireAnchors.js';
import { reportMeshFloorCell, setMeshFloorPreferred } from './groundFloor.js';

const NOW = Date.UTC(2026, 6, 17, 4, 0);
const H = 3600000;

/** Minimal fire record in the layer's internal shape (post-adapt). */
function fire(overrides = {}) {
  return {
    index: 7,
    lat: 61.91435,
    lon: -122.94429,
    frp: 1520.27,
    confidence: 0.9,
    brightness: 340,
    night: false,
    acqMs: NOW - 2 * H,
    sensor: 'VIIRS',
    satellite: 'N20',
    contextEntity: null,
    position: null,
    ...overrides,
  };
}

test('buildFireCard: title carries FRP, detail carries conf/age/satellite', () => {
  const card = buildFireCard({ fire: fire(), position: { x: 1, y: 2, z: 3 } }, NOW);
  assert.equal(card.title, '▲ 1520 MW');
  assert.equal(card.details.length, 1);
  assert.equal(card.details[0], 'high · 2h · N20');
  assert.equal(card.selected, false);
  assert.equal(card.accent, accentForSeverity('red'), 'FRP 1520 is red-hot');
  assert.deepEqual(card.position, { x: 1, y: 2, z: 3 }, 'uses the candidate position untouched');
});

test('buildFireCard: missing acquisition time omits the age segment', () => {
  const card = buildFireCard({ fire: fire({ acqMs: 0 }), position: {} }, NOW);
  assert.equal(card.details[0], 'high · N20');
});

test('buildFireCard: SNPP satellite code renders as SNPP, weak fire is not red', () => {
  const card = buildFireCard({ fire: fire({ satellite: 'N', frp: 0.8, confidence: 0.3 }), position: {} }, NOW);
  assert.match(card.details[0], /SNPP$/);
  assert.equal(card.title, '▲ 0.8 MW');
  assert.notEqual(card.accent, accentForSeverity('red'));
});

test('buildSelectedFireCard: full detail card with coords, selected flag, no fade', () => {
  const card = buildSelectedFireCard(fire(), NOW);
  assert.equal(card.title, 'FIRE · 1520 MW');
  assert.equal(card.selected, true);
  assert.equal(card.details[0], 'high conf · 2h ago · VIIRS N20');
  assert.equal(card.details[1], '61.914°N 122.944°W');
});

test('buildSelectedFireCard: night detections are tagged', () => {
  const card = buildSelectedFireCard(fire({ night: true }), NOW);
  assert.match(card.details[1], / · NIGHT$/);
});

test('buildCellCard: plural noun, max FRP and newest age, accent passthrough', () => {
  const candidate = {
    cell: { count: 14, maxFrp: 210.4, newestAcqMs: NOW - 3 * H, night: 2 },
    position: { x: 0, y: 0, z: 0 },
    accent: accentForSeverity('orange'),
  };
  const card = buildCellCard(candidate, NOW);
  assert.equal(card.title, '14 FIRES');
  assert.equal(card.details[0], 'max 210 MW · new 3h');
  assert.equal(card.accent, accentForSeverity('orange'));
});

// Field finding 2026-07-21: anchors must sit on the DEM once the shared
// ground floor is warm — and the cached per-fire position must re-anchor when
// the floor lands AFTER the first (cold, height-0) render. Distinct coords
// from every other test in this file (module caches persist across tests).
test('fire anchor: cold floor renders at 0, then re-grounds when the floor warms', () => {
  const f = fire({ lat: 55.501, lon: -120.501 });
  const before = buildSelectedFireCard(f, NOW);
  const cartoBefore = Cesium.Cartographic.fromCartesian(before.position);
  assert.ok(Math.abs(cartoBefore.height) < 0.5, `cold floor anchors at ellipsoid 0, got ${cartoBefore.height}`);

  setMeshFloorPreferred(true);
  reportMeshFloorCell(55.501, -120.501, 900);
  const after = buildSelectedFireCard(f, NOW);
  const cartoAfter = Cesium.Cartographic.fromCartesian(after.position);
  assert.ok(
    Math.abs(cartoAfter.height - (900 + FIRE_ANCHOR_LIFT_M)) < 0.5,
    `warm floor re-anchors at floor + lift, got ${cartoAfter.height}`
  );
});

test('buildCellCard: singular noun and missing-age omission', () => {
  const candidate = { cell: { count: 1, maxFrp: 9.9, newestAcqMs: 0 }, position: {}, accent: undefined };
  const card = buildCellCard(candidate, NOW);
  assert.equal(card.title, '1 FIRE');
  assert.equal(card.details[0], 'max 9.9 MW');
  assert.equal(card.accent, accentForSeverity('yellow'), 'missing accent defaults to yellow');
});

test('FIRMS host policy keeps ambient cards bounded and selected cards protected', () => {
  const ambient = applyFirmsOverlayPolicy(buildFireCard({
    fire: fire(),
    position: new Cesium.Cartesian3(1, 2, 3),
  }, NOW), 4_500_000);
  assert.equal(ambient.variant, 'card');
  assert.equal(ambient.protected, false);
  assert.equal(ambient.collisionGroup, 'ambient-card');
  assert.equal(ambient.maxDistance, 4_500_000);
  assert.equal(ambient.distanceFadeStartRatio, 0.7);
  assert.equal(ambient.edgeFade, 'keyhole');
  assert.equal(ambient.cardStyle, 'tactical');
  assert.equal(ambient.verticalOnly, true);
  assert.equal(ambient.gapPx, Math.max(12, buildFireCard({ fire: fire(), position: {} }, NOW).gapPx + 8));
  assert.equal(ambient.leaderOffsetPx, ambient.gapPx - 6);

  const selected = applyFirmsOverlayPolicy(buildSelectedFireCard(fire(), NOW), 4_500_000);
  assert.equal(selected.variant, 'selected');
  assert.equal(selected.protected, true);
  assert.equal(selected.maxDistance, Number.POSITIVE_INFINITY);
});

class MockEvent {
  constructor() { this.listeners = new Set(); }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

test('real FIRMS lifecycle clears host entries on disable and destroy', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const calls = [];
  const preRender = new MockEvent();
  const moveEnd = new MockEvent();
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'no_key' }),
  });
  globalThis.window = new EventTarget();
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(value) { dataSources.push(value); return value; },
      remove(value) {
        const index = dataSources.indexOf(value);
        if (index >= 0) dataSources.splice(index, 1);
      },
    },
    camera: {
      moveEnd,
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 1_000_000),
      positionCartographic: { height: 1_000_000 },
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender,
      primitives: { contains() { return false; } },
    },
  };
  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    overlayHost: {
      setEntries: (...args) => calls.push(['entries', ...args]),
      setVisible: (...args) => calls.push(['visible', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  try {
    layer.init(viewer);
    await layer.enable(viewer);
    assert.deepEqual(calls.at(-1), ['visible', FIRMS_OVERLAY_SOURCE_ID, true]);
    layer.disable();
    assert.deepEqual(calls.slice(-2), [
      ['clear', FIRMS_OVERLAY_SOURCE_ID],
      ['visible', FIRMS_OVERLAY_SOURCE_ID, false],
    ]);
    await layer.enable(viewer);
    layer.destroy(viewer);
    assert.ok(calls.some(([type]) => type === 'clear'));
    assert.deepEqual(calls.slice(-2), [
      ['clear', FIRMS_OVERLAY_SOURCE_ID],
      ['visible', FIRMS_OVERLAY_SOURCE_ID, false],
    ]);
    const callCount = calls.length;
    await layer.enable(viewer);
    assert.equal(calls.length, callCount, 'destroyed FIRMS layers reject late enable work');
    assert.equal(FIRMS_AMBIENT_COHORT_LIMIT, 18);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
