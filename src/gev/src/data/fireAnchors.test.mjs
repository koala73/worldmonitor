// src/data/fireAnchors.test.mjs — DEM ground anchors for rendered FIRMS
// detections (field finding 2026-07-21: close-zoom fire dots read as
// buried under high terrain because anchors sat at ellipsoid height 0).
//
// Locks the module's two jobs:
//   fireAnchorHeight(lat, lon)      — synchronous warm-cache read: shared
//     ground floor + lift, or 0 when the floor isn't warm (the pre-fix anchor).
//   warmFireAnchorFloors(points)    — batched, sequential (never concurrent)
//     resolve of the cold floor cells behind a rendered detection set.
//     Resolves true only when at least one requested point actually gained a
//     warm floor — a failed resolve reports false so render → warm → re-render
//     chains terminate instead of looping against a down proxy.
//
// `fetch` is injected via `globalThis.fetch` (no real network), same pattern
// as terrainHeights.test.mjs. The terrainHeights/groundFloor module caches
// persist across tests in this file, so each test uses distinct coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_ANCHOR_LIFT_M,
  fireAnchorHeight,
  warmFireAnchorFloors,
  _resetFireAnchorsForTest,
} from './fireAnchors.js';
import { reportMeshFloorCell, setMeshFloorPreferred } from './groundFloor.js';

/** Installs a fake fetch for the duration of `fn`, restoring the original after. */
async function withFakeFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Parses the `points=lon,lat;…` query of a /api/terrain/heights request URL. */
function parsePoints(url) {
  const raw = decodeURIComponent(String(url).split('points=')[1] || '');
  return raw.split(';').filter(Boolean).map((pair) => {
    const [lon, lat] = pair.split(',').map(Number);
    return { lon, lat };
  });
}

/** Fake proxy answering ellipsoid = lon + lat per requested point. */
function echoFetch(log) {
  return async (url) => {
    const points = parsePoints(url);
    log.push(points);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: points.map(({ lon, lat }) => ({ lon, lat, elevation: 0, geoid: 0, ellipsoid: lon + lat })),
      }),
    };
  };
}

test('fireAnchorHeight: unknown floor anchors at 0 (pre-fix behavior preserved)', () => {
  _resetFireAnchorsForTest();
  assert.equal(fireAnchorHeight(10.001, 10.001), 0);
});

test('fireAnchorHeight: warm shared ground floor anchors at floor + lift', () => {
  _resetFireAnchorsForTest();
  setMeshFloorPreferred(true);
  // Seed via the mesh-cell path — proves fires read the SAME choke point
  // (cachedGroundFloor) every other ground-adjacent consumer uses.
  reportMeshFloorCell(51.301, -122.401, 1400);
  assert.equal(fireAnchorHeight(51.3012, -122.4008), 1400 + FIRE_ANCHOR_LIFT_M);
});

test('warmFireAnchorFloors: one batched request, deduped to coarse cells', async () => {
  _resetFireAnchorsForTest();
  const log = [];
  await withFakeFetch(echoFetch(log), async () => {
    const warmed = await warmFireAnchorFloors([
      { lat: 20.0001, lon: 30.0001 }, // same ~111 m cell as the next point
      { lat: 20.0004, lon: 30.0004 },
      { lat: 20.101, lon: 30.101 },   // distinct cell
    ]);
    assert.equal(warmed, true);
    assert.equal(log.length, 1, 'one network request for the whole batch');
    assert.equal(log[0].length, 2, 'two unique coarse cells, not three points');
  });
  // The warm floor is immediately readable at full precision…
  assert.equal(fireAnchorHeight(20.0001, 30.0001), 50 + FIRE_ANCHOR_LIFT_M);
  // …and for every other detection sharing the cell.
  assert.equal(fireAnchorHeight(20.0004, 30.0004), 50 + FIRE_ANCHOR_LIFT_M);
});

test('warmFireAnchorFloors: warm cells never refetch (one lookup per fire ever)', async () => {
  _resetFireAnchorsForTest();
  const log = [];
  await withFakeFetch(echoFetch(log), async () => {
    await warmFireAnchorFloors([{ lat: 21.001, lon: 31.001 }]);
    assert.equal(log.length, 1);
    const warmedAgain = await warmFireAnchorFloors([
      { lat: 21.001, lon: 31.001 },
      { lat: 21.0012, lon: 31.0011 }, // same cell, different detection
    ]);
    assert.equal(warmedAgain, false, 'nothing was cold, so nothing warmed');
    assert.equal(log.length, 1, 'no second network request');
  });
});

test('warmFireAnchorFloors: overlapping calls run sequentially, never concurrently', async () => {
  _resetFireAnchorsForTest();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let concurrent = 0;
  let maxConcurrent = 0;
  const log = [];
  await withFakeFetch(async (url) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const points = parsePoints(url);
    log.push(points);
    await gate;
    concurrent -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: points.map(({ lon, lat }) => ({ lon, lat, elevation: 0, geoid: 0, ellipsoid: lon + lat })),
      }),
    };
  }, async () => {
    const first = warmFireAnchorFloors([{ lat: 40.001, lon: 50.001 }]);
    // Second call arrives while the first is in flight: overlaps the first
    // cell and adds one new one.
    const second = warmFireAnchorFloors([
      { lat: 40.001, lon: 50.001 },
      { lat: 41.201, lon: 51.201 },
    ]);
    release();
    const [warmedFirst, warmedSecond] = await Promise.all([first, second]);
    assert.equal(warmedFirst, true);
    assert.equal(warmedSecond, true, 'the new cell warmed in the follow-up batch');
    assert.equal(maxConcurrent, 1, 'batches never overlap on the wire');
    assert.equal(log.length, 2);
    assert.equal(log[1].length, 1, 'follow-up batch re-filters: only the still-cold cell goes out');
  });
});

test('warmFireAnchorFloors: proxy failure reports false (re-render chain terminates)', async () => {
  _resetFireAnchorsForTest();
  let calls = 0;
  await withFakeFetch(async () => {
    calls += 1;
    throw new Error('proxy down');
  }, async () => {
    const warmed = await warmFireAnchorFloors([{ lat: 22.501, lon: 32.501 }]);
    assert.equal(warmed, false, 'geoid fallback is NOT a warm floor for anchoring');
    assert.ok(calls >= 1);
  });
  assert.equal(fireAnchorHeight(22.501, 32.501), 0, 'anchor stays at 0 until a real floor lands');
});
