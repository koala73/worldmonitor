// src/data/cctvViewshed.test.mjs — viewshed hue assignment + frustum volume
// geometry documented in docs/CURRENT-STATE.md.
//
// Locks:
//   - cameraHue is golden-angle spaced and deterministic (color identity is
//     stable across sessions for a stable catalog);
//   - nearby catalog indices get well-separated hues (the whole point: a local
//     cluster of neighbor cameras must be tellable-apart);
//   - frustumVolumeGeometryData is welded BY CONSTRUCTION to the wireframe:
//     its 5 vertices are exactly the caller's frustumCartesians positions and
//     its 18 indices only reference those 5 vertices (4 side faces + 2 cap
//     triangles) — no independent geometry recompute anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  cameraHue,
  viewshedColors,
  frustumVolumeGeometryData,
} from './cctvViewshed.js';

const GOLDEN_ANGLE = 137.50776405003785;

function circularDeltaDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

test('cameraHue: deterministic golden-angle spacing in [0, 360)', () => {
  assert.equal(cameraHue(0), 0);
  assert.ok(Math.abs(cameraHue(1) - GOLDEN_ANGLE) < 1e-9);
  for (let i = 0; i < 300; i++) {
    const hue = cameraHue(i);
    assert.ok(hue >= 0 && hue < 360, `hue ${hue} out of range at index ${i}`);
    assert.equal(hue, cameraHue(i), 'must be pure/deterministic');
  }
});

// NB: 20 points on a 360° wheel cap the best-possible min pairwise gap at 18°
// (pigeonhole), so "≥20°" is unachievable for any assignment. Golden-angle
// gives 12.4° min over the first 20 (measured) — assert ≥12° so a regression
// to a worse spacing scheme (e.g. raw id-hash clustering) fails loudly, and
// separately assert CONSECUTIVE indices (the likeliest co-visible neighbors)
// stay far apart.
test('cameraHue: first 20 indices pairwise separated by >= 12 degrees', () => {
  const hues = Array.from({ length: 20 }, (_, i) => cameraHue(i));
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const delta = circularDeltaDeg(hues[i], hues[j]);
      assert.ok(delta >= 12, `hue(${i})=${hues[i].toFixed(1)} vs hue(${j})=${hues[j].toFixed(1)} only ${delta.toFixed(1)}° apart`);
    }
  }
});

test('cameraHue: consecutive indices separated by >= 80 degrees', () => {
  for (let i = 0; i < 40; i++) {
    const delta = circularDeltaDeg(cameraHue(i), cameraHue(i + 1));
    assert.ok(delta >= 80, `consecutive hues ${i}/${i + 1} only ${delta.toFixed(1)}° apart`);
  }
});

test('viewshedColors: fill/line pairs with the designed alphas', () => {
  const colors = viewshedColors(210);
  for (const key of ['fill', 'fillActive', 'line', 'lineActive']) {
    assert.ok(colors[key] instanceof Cesium.Color, `${key} must be a Cesium.Color`);
  }
  assert.ok(Math.abs(colors.fill.alpha - 0.12) < 1e-6);
  assert.ok(Math.abs(colors.fillActive.alpha - 0.22) < 1e-6);
  assert.ok(Math.abs(colors.line.alpha - 0.85) < 1e-6);
  assert.ok(Math.abs(colors.lineActive.alpha - 1.0) < 1e-6);
  // Same hue family: fill and line of the same hue must not be gray.
  assert.ok(colors.line.red !== colors.line.green || colors.line.green !== colors.line.blue);
});

/** Minimal frustumCartesians-shaped fixture. */
function positionsFixture() {
  return {
    mount: new Cesium.Cartesian3(1000, 2000, 3000),
    tl: new Cesium.Cartesian3(1100, 2100, 3050),
    tr: new Cesium.Cartesian3(1200, 2050, 3050),
    br: new Cesium.Cartesian3(1200, 2050, 2950),
    bl: new Cesium.Cartesian3(1100, 2100, 2950),
  };
}

test('frustumVolumeGeometryData: 5 vertices are exactly the input Cartesians', () => {
  const positions = positionsFixture();
  const { positions: flat, indices } = frustumVolumeGeometryData(positions);
  assert.equal(flat.length, 15);
  assert.equal(indices.length, 18);
  const order = [positions.mount, positions.tl, positions.tr, positions.br, positions.bl];
  order.forEach((p, i) => {
    assert.equal(flat[i * 3], p.x);
    assert.equal(flat[i * 3 + 1], p.y);
    assert.equal(flat[i * 3 + 2], p.z);
  });
});

test('frustumVolumeGeometryData: indices form 4 side faces + 2 cap triangles over the 5 vertices', () => {
  const { indices } = frustumVolumeGeometryData(positionsFixture());
  const counts = new Map();
  for (const idx of indices) {
    assert.ok(idx >= 0 && idx <= 4, `index ${idx} out of vertex range`);
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  // Apex (0) appears in exactly the 4 side triangles; every corner in >= 2.
  assert.equal(counts.get(0), 4, 'apex must appear in exactly 4 side triangles');
  for (const corner of [1, 2, 3, 4]) {
    assert.ok(counts.get(corner) >= 2, `corner ${corner} underused`);
  }
  // 6 triangles, none degenerate (three distinct vertices each).
  for (let t = 0; t < indices.length; t += 3) {
    const tri = new Set([indices[t], indices[t + 1], indices[t + 2]]);
    assert.equal(tri.size, 3, `triangle at ${t} is degenerate`);
  }
});

test('frustumVolumeGeometryData: no NaN for a tight (probe-clamped) pyramid', () => {
  const near = {
    mount: new Cesium.Cartesian3(0, 0, 0),
    tl: new Cesium.Cartesian3(12, 1, 1),
    tr: new Cesium.Cartesian3(12, -1, 1),
    br: new Cesium.Cartesian3(12, -1, -1),
    bl: new Cesium.Cartesian3(12, 1, -1),
  };
  const { positions: flat } = frustumVolumeGeometryData(near);
  for (const v of flat) assert.ok(Number.isFinite(v));
});
