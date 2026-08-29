// FIRMS click routes: sprite AND card must both select for detail and hand the
// camera over (pre-launch defect #4 + P1-3). Driven through the production
// click handler and the production card-render path; only the viewer, the
// event handler, the overlay host and the world→window projection are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer, applyFirmsOverlayPolicy, buildCellCard } from './firmsHeatmap.js';
import { fireDetectionKey } from './firmsLabels.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAYER_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'firmsHeatmap.js'),
  'utf8',
);

function makeFire(overrides = {}) {
  return {
    index: 7,
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    sensor: 'VIIRS',
    acqMs: 1_753_600_000_000,
    ...overrides,
  };
}

/**
 * Stand the layer up far enough to drive one click. `cardHit` is what the
 * overlay host reports under the click position — the real host only publishes
 * rects for `interactive` entries, so a stub hit is the contract a painted,
 * actionable card presents.
 */
function harness({
  fires = [makeFire()], picked = null, cardHit = null, cameraPosition = null,
  withDataSource = false,
} = {}) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  // Spread projections so the greedy screen-separation declutter accepts every
  // seeded detection; co-located fires would otherwise collide by design.
  let projected = 0;
  Cesium.SceneTransforms.worldToWindowCoordinates = () => {
    projected += 1;
    return { x: 200 * projected, y: 300 };
  };

  const published = [];
  let handler = null;
  const layer = createFirmsHeatmapLayer({
    id: 'firms-test',
    name: 'Fires',
    overlayHost: {
      setEntries: (sourceId, entries) => published.push(...entries),
      setVisible() {},
      clearSource() {},
      hitTest: () => (cardHit ? { sourceId: 'firms', entryId: cardHit } : null),
    },
    screenSpaceEventHandlerFactory: () => {
      handler = { click: null, setInputAction(cb) { this.click = cb; }, destroy() {} };
      return handler;
    },
  });

  const viewer = {
    scene: {
      pick: () => picked,
      canvas: { clientWidth: 1280, clientHeight: 800 },
      camera: cameraPosition ? { positionWC: cameraPosition } : undefined,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    dataSources: { add() {}, remove() {} },
  };
  // The LOD rebuild (and with it the context-registration sweep) is inert
  // without a data source, so tests that drive a real refresh need one.
  if (withDataSource) layer.init(viewer);
  layer._bindInteractionForTest(viewer, fires);

  const requests = [];
  windowTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, (e) => requests.push(e.detail));

  return {
    layer,
    viewer,
    windowTarget,
    requests,
    published,
    fires,
    click: () => handler.click({ position: { x: 400, y: 300 } }),
    cleanup() {
      Cesium.SceneTransforms.worldToWindowCoordinates = priorProjection;
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
    },
  };
}

test('fire detection key survives a refetch that renumbers the index', () => {
  const fire = makeFire();
  assert.equal(fireDetectionKey(fire), fireDetectionKey({ ...fire, index: 999 }));
  // Different pass over the same pixel is a different detection.
  assert.notEqual(fireDetectionKey(fire), fireDetectionKey({ ...fire, acqMs: fire.acqMs + 1 }));
  assert.notEqual(fireDetectionKey(fire), fireDetectionKey({ ...fire, lat: 31.0 }));
  assert.match(fireDetectionKey({}), /^firms:x:x:0:x$/);
});

test('two satellites over the same pixel at the same time stay distinct', () => {
  // The proxy merges SNPP + NOAA-20 + NOAA-21 without dedup and their orbits
  // overlap, so position and time alone are NOT unique. Collapsing them let a
  // restored selection land on the other satellite's record.
  const base = makeFire({ satellite: 'N20' });
  const twin = makeFire({ satellite: 'N21' });
  const suomi = makeFire({ satellite: 'N' });
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(twin));
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(suomi));
  assert.notEqual(fireDetectionKey(twin), fireDetectionKey(suomi));
  // Satellite naming variants normalize to one identity, not three.
  assert.equal(fireDetectionKey(base), fireDetectionKey(makeFire({ satellite: 'NOAA-20' })));
  assert.equal(fireDetectionKey(suomi), fireDetectionKey(makeFire({ satellite: 'Suomi NPP' })));
  // A record with no satellite falls back to its sensor, not to a shared blank.
  const sensorOnly = makeFire({ satellite: '', sensor: 'MODIS' });
  assert.notEqual(fireDetectionKey(sensorOnly), fireDetectionKey(makeFire({ satellite: '', sensor: 'VIIRS' })));
});

test('duplicate-coordinate detections get their own cards and focus targets', () => {
  const n20 = makeFire({ index: 0, satellite: 'N20' });
  const n21 = makeFire({ index: 1, satellite: 'N21' });
  const h = harness({
    fires: [n20, n21],
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: `fire:${fireDetectionKey(n21)}`,
  });
  try {
    const cardIds = h.published.filter((e) => e.id.startsWith('fire:')).map((e) => e.id);
    assert.equal(new Set(cardIds).size, 2, 'co-located detections must not collapse to one card');
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].id, fireDetectionKey(n21), 'the clicked card wins, not its twin');
  } finally {
    h.cleanup();
  }
});

test('selection restoration uses the same key the cards and focus use', () => {
  // Restoration ran on raw lat/lon/acqMs, which collapses co-located
  // detections from different satellites — the selection could come back on
  // the wrong record. Reachable only through the 30-minute refetch, so this is
  // a source contract; the key's own behavior is proven above.
  const match = LAYER_SOURCE.match(/function findMatchingFire\(previous\) \{([\s\S]*?)\n  \}\n/);
  assert.ok(match, 'findMatchingFire is missing');
  assert.match(match[1], /fireDetectionKey\(previous\)/);
  assert.match(match[1], /fireDetectionKey\(fire\) === key/);
  assert.doesNotMatch(match[1], /fire\.acqMs === previous\.acqMs/);
});

test('painted detection cards are keyed by the stable detection key', () => {
  const h = harness();
  try {
    const card = h.published.find((entry) => entry.id.startsWith('fire:'));
    assert.ok(card, 'a detection card was painted');
    assert.equal(card.id, `fire:${fireDetectionKey(h.fires[0])}`);
    assert.equal(card.interactive, true, 'a detection card must publish a hit rect');
    assert.match(card.accessibilityLabel, /^Focus fire detection /);
    assert.equal(card.activate(), true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].id, fireDetectionKey(h.fires[0]));
  } finally {
    h.cleanup();
  }
});

test('an aggregated cell card is never actionable — it is not one fire', () => {
  const cell = buildCellCard(
    { cell: { count: 14, maxFrp: 210, newestAcqMs: 0, latCell: 30, lonCell: -98 }, position: {} },
    Date.now(),
  );
  assert.equal(applyFirmsOverlayPolicy(cell, 1e6).interactive, false);
});

test('far-side detections cannot consume the bounded ambient-card cohort', () => {
  const front = makeFire({ index: 1, lat: 30.51, lon: -98.21, frp: 100 });
  const rear = makeFire({ index: 2, lat: -30.51, lon: 81.79, frp: 1000 });
  const cameraPosition = Cesium.Cartesian3.fromDegrees(front.lon, front.lat, 10_000_000);
  const h = harness({ fires: [rear, front], cameraPosition });
  try {
    const cardIds = h.published.filter((entry) => entry.id.startsWith('fire:')).map((entry) => entry.id);
    assert.deepEqual(cardIds, [`fire:${fireDetectionKey(front)}`]);
  } finally {
    h.cleanup();
  }
});

test('clicking a fire sprite selects it and requests the camera transfer', () => {
  const fire = makeFire();
  const h = harness({ fires: [fire], picked: { id: 'firms-7' } });
  try {
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].kind, 'fire');
    assert.equal(h.requests[0].id, fireDetectionKey(fire));
    assert.ok(h.requests[0].position, 'the transfer needs a world position');
  } finally {
    h.cleanup();
  }
});

test('clicking a fire CARD behaves exactly like clicking its sprite', () => {
  const fire = makeFire();
  // The click lands on the card, but the scene pick returns the 3D-Tiles
  // surface behind it — the case that used to clear the selection.
  const h = harness({
    fires: [fire],
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: `fire:${fireDetectionKey(fire)}`,
  });
  try {
    h.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].kind, 'fire');
    assert.equal(h.requests[0].id, fireDetectionKey(fire));
  } finally {
    h.cleanup();
  }
});

test('a click on neither sprite nor card clears without moving the camera', () => {
  const h = harness({ picked: { primitive: {}, content: {}, featureId: 0 } });
  try {
    h.click();
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

// Sibling layers surface heterogeneous pick shapes. Reading `picked.id`
// directly recognized only bare strings, so an AIS sprite (or satellite, or
// entity) under a fire card let BOTH layers issue a camera command.
const SIBLING_PICKS = [
  ['flights', 'a1b2c3', { id: 'a1b2c3' }],
  ['flights', 'a1b2c3', { primitive: { id: 'a1b2c3' } }],
  ['ais-live-vessels', '353136000', { id: { mmsi: '353136000', name: 'EVER GIVEN' } }],
  ['cctv', 'atx-cam-3', { id: { id: 'atx-cam-3', name: 'entity-like' } }],
  ['satellites', '25544', { id: 25544 }],
];

for (const [layerId, ownedId, picked] of SIBLING_PICKS) {
  test(`a ${layerId} pick shaped ${JSON.stringify(picked)} wins over a card hit`, () => {
    const fire = makeFire();
    registerPickOwner(layerId, (pickedId) => pickedId === ownedId);
    const h = harness({
      fires: [fire],
      picked,
      cardHit: `fire:${fireDetectionKey(fire)}`,
    });
    try {
      h.click();
      assert.equal(h.requests.length, 0, `the ${layerId} layer is already acting on this click`);
    } finally {
      h.cleanup();
      unregisterPickOwner(layerId);
    }
  });
}

test('a stale card id resolves to nothing instead of an arbitrary fire', () => {
  const h = harness({
    picked: { primitive: {}, content: {}, featureId: 0 },
    cardHit: 'fire:firms:1.0000:1.0000:1:N20',
  });
  try {
    h.click();
    assert.equal(h.requests.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a refresh that drops the selected fire emits an eviction the readout can act on', async () => {
  // Behavioral, not a source pin: the tag was present and correct while the
  // event never fired, because the LOD rebuild deletes the selected context
  // record first and the clear then fails its ownership guard silently.
  const kept = makeFire({ index: 0 });
  const dropped = makeFire({
    index: 1, lat: 31.77, lon: -99.02, acqMs: 1_753_600_100_000, satellite: 'N20',
  });
  const h = harness({
    fires: [dropped, kept],
    cardHit: `fire:${fireDetectionKey(dropped)}`,
    withDataSource: true,
  });
  const cleared = [];
  h.windowTarget.addEventListener('gev:entity-selection-cleared', (e) => cleared.push(e.detail));
  const priorFetch = globalThis.fetch;

  try {
    h.click();
    assert.equal(h.requests.length, 1, 'the click must select the fire we are about to drop');
    assert.equal(h.requests[0].id, fireDetectionKey(dropped));
    assert.deepEqual(cleared, [], 'selecting must not clear anything yet');

    // A normal, NON-EMPTY refresh that simply no longer carries that detection.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        fetchedAt: Date.now(),
        stale: false,
        fires: [{
          lat: kept.lat,
          lon: kept.lon,
          frp: kept.frp,
          confidence: 'h',
          brightness: 330,
          daynight: 'D',
          acqDate: '2025-07-27',
          acqTime: '0412',
          instrument: 'VIIRS',
          satellite: kept.satellite,
        }],
      }),
    });
    await h.layer.update();

    assert.equal(
      cleared.length,
      1,
      'a vanished selection must reach consumers as an event, not as silence',
    );
    assert.equal(cleared[0].layerId, 'firms-test');
    assert.equal(
      cleared[0].reason,
      'evicted',
      'the detection left the feed — it was not deselected',
    );
  } finally {
    if (priorFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = priorFetch;
    h.cleanup();
  }
});
