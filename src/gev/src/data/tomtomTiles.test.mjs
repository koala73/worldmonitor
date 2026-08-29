// src/data/tomtomTiles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTileCoord,
  lonLatToTile,
  tileToBBox,
  tilesForBounds,
  utcDayKey,
  normalizeBudget,
  isOverBudget,
} from './tomtomTiles.js';

// Downtown Austin — the verified TomTom fixture tile (z12 x935 y1686).
const AUSTIN = { lat: 30.2672, lon: -97.7431 };

// ── Tile coordinate validation ──────────────────────────────

test('isValidTileCoord accepts the supported zoom range [8,16]', () => {
  assert.equal(isValidTileCoord(8, 0, 0), true);
  assert.equal(isValidTileCoord(12, 935, 1686), true);
  assert.equal(isValidTileCoord(16, 2 ** 16 - 1, 2 ** 16 - 1), true);
});

test('isValidTileCoord rejects out-of-range zoom', () => {
  assert.equal(isValidTileCoord(7, 0, 0), false);
  assert.equal(isValidTileCoord(17, 0, 0), false);
  assert.equal(isValidTileCoord(-1, 0, 0), false);
});

test('isValidTileCoord rejects x/y outside [0, 2^z - 1]', () => {
  assert.equal(isValidTileCoord(12, -1, 0), false);
  assert.equal(isValidTileCoord(12, 0, -1), false);
  assert.equal(isValidTileCoord(12, 4096, 0), false); // 2^12 = 4096
  assert.equal(isValidTileCoord(12, 0, 4096), false);
  assert.equal(isValidTileCoord(12, 4095, 4095), true);
});

test('isValidTileCoord rejects non-integer inputs', () => {
  assert.equal(isValidTileCoord(12.5, 100, 100), false);
  assert.equal(isValidTileCoord(12, 100.2, 100), false);
  assert.equal(isValidTileCoord(12, 100, NaN), false);
  assert.equal(isValidTileCoord('12', 100, 100), false);
});

// ── Slippy tile math ────────────────────────────────────────

test('lonLatToTile: downtown Austin @ z12 -> x935 y1686 (matches fixture)', () => {
  const t = lonLatToTile(AUSTIN.lon, AUSTIN.lat, 12);
  assert.equal(t.x, 935);
  assert.equal(t.y, 1686);
});

test('tileToBBox: fixture tile bbox contains downtown Austin', () => {
  const bbox = tileToBBox(12, 935, 1686);
  assert.ok(bbox.west <= AUSTIN.lon && AUSTIN.lon <= bbox.east, `lon outside [${bbox.west}, ${bbox.east}]`);
  assert.ok(bbox.south <= AUSTIN.lat && AUSTIN.lat <= bbox.north, `lat outside [${bbox.south}, ${bbox.north}]`);
  assert.ok(bbox.north > bbox.south && bbox.east > bbox.west);
});

test('tileToBBox <-> lonLatToTile roundtrip at the bbox center', () => {
  const bbox = tileToBBox(12, 935, 1686);
  const center = { lon: (bbox.west + bbox.east) / 2, lat: (bbox.south + bbox.north) / 2 };
  const t = lonLatToTile(center.lon, center.lat, 12);
  assert.deepEqual({ x: t.x, y: t.y }, { x: 935, y: 1686 });
});

test('lonLatToTile clamps poles and antimeridian into valid range', () => {
  for (const [lon, lat] of [[-180, 89.9], [180, -89.9], [179.9999, 0]]) {
    const t = lonLatToTile(lon, lat, 12);
    assert.equal(isValidTileCoord(12, t.x, t.y), true, `invalid tile for ${lon},${lat}: ${t.x},${t.y}`);
  }
});

// ── tilesForBounds ──────────────────────────────────────────

test('tilesForBounds: clamped Austin viewport covers the fixture tile', () => {
  const bounds = {
    south: AUSTIN.lat - 0.025, north: AUSTIN.lat + 0.025,
    west: AUSTIN.lon - 0.025, east: AUSTIN.lon + 0.025,
  };
  const tiles = tilesForBounds(bounds, 12);
  assert.ok(tiles.length >= 1 && tiles.length <= 4, `tile count ${tiles.length}`);
  assert.ok(
    tiles.some((t) => t.z === 12 && t.x === 935 && t.y === 1686),
    `fixture tile missing from ${JSON.stringify(tiles)}`
  );
});

test('tilesForBounds: bounds straddling a tile edge return both tiles', () => {
  const bbox = tileToBBox(12, 935, 1686);
  const bounds = {
    south: (bbox.south + bbox.north) / 2 - 0.001,
    north: (bbox.south + bbox.north) / 2 + 0.001,
    west: bbox.east - 0.001,
    east: bbox.east + 0.001, // spills into x=936
  };
  const tiles = tilesForBounds(bounds, 12);
  assert.equal(tiles.length, 2);
  const xs = tiles.map((t) => t.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [935, 936]);
});

test('tilesForBounds: default zoom is 12 and every tile is valid', () => {
  const bounds = { south: 51.49, north: 51.52, west: -0.14, east: -0.10 }; // London
  const tiles = tilesForBounds(bounds);
  assert.ok(tiles.length >= 1);
  for (const t of tiles) {
    assert.equal(t.z, 12);
    assert.equal(isValidTileCoord(t.z, t.x, t.y), true);
  }
});

test('tilesForBounds: runaway bounds are truncated by the safety cap', () => {
  const tiles = tilesForBounds({ south: -60, north: 60, west: -170, east: 170 }, 12, { maxTiles: 16 });
  assert.ok(tiles.length <= 16, `got ${tiles.length}`);
});

// ── Budget accounting ───────────────────────────────────────

test('utcDayKey formats as YYYY-MM-DD in UTC', () => {
  assert.equal(utcDayKey(Date.UTC(2026, 6, 16, 23, 59, 59)), '2026-07-16');
  assert.equal(utcDayKey(Date.UTC(2026, 6, 17, 0, 0, 1)), '2026-07-17');
});

test('normalizeBudget: same-day state passes through untouched', () => {
  const state = { date: '2026-07-16', count: 123 };
  assert.equal(normalizeBudget(state, '2026-07-16'), state);
});

test('normalizeBudget: day rollover resets the counter', () => {
  const rolled = normalizeBudget({ date: '2026-07-16', count: 39999 }, '2026-07-17');
  assert.deepEqual(rolled, { date: '2026-07-17', count: 0 });
});

test('normalizeBudget: missing/corrupt state starts fresh', () => {
  assert.deepEqual(normalizeBudget(null, '2026-07-16'), { date: '2026-07-16', count: 0 });
  assert.deepEqual(normalizeBudget({ date: '2026-07-16', count: NaN }, '2026-07-16'), { date: '2026-07-16', count: 0 });
  assert.deepEqual(normalizeBudget({ count: 5 }, '2026-07-16'), { date: '2026-07-16', count: 0 });
  assert.deepEqual(normalizeBudget({ date: '2026-07-16', count: -3 }, '2026-07-16'), { date: '2026-07-16', count: 0 });
});

test('isOverBudget: at or above the limit is over, below is not', () => {
  assert.equal(isOverBudget({ date: 'x', count: 39999 }, 40000), false);
  assert.equal(isOverBudget({ date: 'x', count: 40000 }, 40000), true);
  assert.equal(isOverBudget({ date: 'x', count: 40001 }, 40000), true);
});

test('isOverBudget: non-positive or invalid limit never blocks', () => {
  assert.equal(isOverBudget({ date: 'x', count: 1e9 }, 0), false);
  assert.equal(isOverBudget({ date: 'x', count: 1e9 }, NaN), false);
});
