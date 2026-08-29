// src/data/meshFloorSampler.test.mjs — the rendered-mesh sampler driven through
// its REAL validation boundary (2026-08-21).
//
// The sampler's acceptance rule was previously covered only through
// `reportValidatedMeshFloorCell` directly, which proves the gate but not the
// decision that feeds it. These tests call `sampleMeshFloorCells` with a fake
// scene whose `sampleHeight` returns exactly what Cesium can return — a number,
// `undefined`, NaN, or a throw — and assert that a cell latches if and only if
// a REAL DEM prior exists and the sample fits its window.
//
// That requirement is the load-bearing one: this round built a tier that kept
// the reading when no prior existed, and measured it recording a coarse-LOD
// 20.6 m for ground that is really ~122 m (see meshFloorSampler.js). Without a
// prior there is nothing to tell a surface from a mis-hit, and `tilesLoaded`
// is not that signal.
//
// The DEM priors are seeded the same way `terrainHeights.test.mjs` does: a fake
// `globalThis.fetch` in front of the real resolver, so the module's own
// real-vs-fallback bookkeeping is exercised rather than stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { resolveEllipsoidalGround } from './terrainHeights.js';
import {
  cachedGroundFloor, cachedMeshFloor, setMeshFloorPreferred,
  _clearMeshFloorCellsForTest,
} from './groundFloor.js';

/** Distinct site per test — terrainHeights' cache is module-global and warm
 *  entries are permanent, so tests must not share coordinates. */
let siteLat = 40.0;
const nextSite = () => ({ lat: +(siteLat += 0.05).toFixed(3), lon: -97.66 });

/** Seeds a REAL ('reearth') DEM prior for a cell through the real resolver. */
async function seedDem(cell, ellipsoid) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ results: [{ ellipsoid }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    await resolveEllipsoidalGround([{ lat: cell.lat, lon: cell.lon }]);
  } finally {
    globalThis.fetch = original;
  }
}

/** A scene the sampler accepts: low camera, one visible tileset reporting
 *  tilesLoaded, and a `sampleHeight` under the test's control. */
function fakeScene(sampleHeight, { cameraHeightM = 900, tilesLoaded = true, show = true } = {}) {
  // instanceof-compatible without running Cesium's constructor; `tilesLoaded` is
  // a prototype getter, so it has to be shadowed with an own data property.
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  Object.defineProperty(tileset, 'tilesLoaded', { value: tilesLoaded, configurable: true });
  Object.defineProperty(tileset, 'show', { value: show, configurable: true });
  return {
    sampleHeight,
    camera: { positionCartographic: { height: cameraHeightM } },
    primitives: { length: 1, get: () => tileset },
  };
}

function reset() {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
}

test('sampler: a finite sample with NO DEM prior is stored NOWHERE', () => {
  reset();
  const cell = nextSite();
  sampleMeshFloorCells(fakeScene(() => 138.0), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'nothing may latch without a prior');
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), null, 'the shared choke point stays clean');
});

test('sampler: a finite sample WITH a fitting DEM prior latches and becomes the shared floor', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const scene = fakeScene(() => 137.0); // +17 m of mesh over bare earth — in window
  sampleMeshFloorCells(scene, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 137.0);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 137.0, 'and it is what every consumer reads');
});

test('sampler: a sample REJECTED against a real prior is stored nowhere', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const scene = fakeScene(() => 400.0); // a tower hit — far outside the +80 m window
  sampleMeshFloorCells(scene, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 120.0, 'the DEM prior still answers');
});

test('sampler: undefined, NaN and a throwing probe latch nothing and crash nothing', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  for (const bad of [() => undefined, () => Number.NaN, () => { throw new Error('mid-teardown'); }]) {
    sampleMeshFloorCells(fakeScene(bad), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
    assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'no negative latch, no throw');
  }
  sampleMeshFloorCells(fakeScene(() => 133.0), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 133.0, 'and a later good sample still lands');
});

test('sampler: a high camera or unloaded tiles produce no records at all', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  sampleMeshFloorCells(fakeScene(() => 138.0, { cameraHeightM: 90_000 }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'coarse LOD under a high camera');
  sampleMeshFloorCells(fakeScene(() => 138.0, { tilesLoaded: false }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'mid-stream tiles read coarse');
});

test('sampler: outside the google-3d regime nothing is sampled at all', () => {
  reset();
  const cell = nextSite();
  setMeshFloorPreferred(false);
  let calls = 0;
  sampleMeshFloorCells(fakeScene(() => { calls += 1; return 138.0; }), [cell],
    { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(calls, 0, 'on a globe stack the DEM IS the rendered surface');
  setMeshFloorPreferred(true);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
});
