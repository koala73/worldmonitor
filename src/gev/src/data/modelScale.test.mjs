// Regression test for the giant-military-jet bug: MODEL_SCALE must put every
// rendered aircraft at REAL-WORLD size, whatever the GLB's native scale is.
//
// airplane.glb and jet.glb are both transform-applied at real-world size and
// render with MODEL_SCALE 1. The airplane previously relied on a runtime ×24
// calibration; that factor is now baked into its geometry so future consumers
// cannot miss it. The original military bug came from copying scale 24 onto the
// already meter-scale jet, rendering military models ~600–1000 m
// across — invisible at the ~6 km follow range where minimumPixelSize
// dominates, but zoom below ~1 km and the camera ends up INSIDE the model.
//
// The layer modules pull the full Cesium engine and don't export their
// constants, so (as in modelMatrix.test.mjs) we don't import them: constants
// are read from source, and each GLB's native bounding radius is computed from
// its POSITION accessor min/max with the node hierarchy's transforms applied
// (both legacy GLBs are now transform-applied, but the hierarchy-aware reader
// guards future asset updates). For jet.glb this yields 29.83 — Cesium's
// Model.boundingSphere.radius / scale measured in-app (2026-07-02).
import { test } from 'node:test';
import * as Cesium from 'cesium';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASS_SCALE_3D, CLASS_MODEL_URL, CLASS_MODEL_REAL } from './aircraftClass.js';
import {
  MODEL_TRAIL_ANCHOR_NATIVE,
  MODEL_VISUAL_CENTER_NATIVE,
  modelVisualAnchor,
  trailAnchorForModel,
  trailHeadStart,
  modelAnchorWorld,
} from './modelVisualAnchor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every class's rendered bounding radius (m) must land in this envelope —
 *  bigger than any clamped-down light aircraft, smaller than the largest real
 *  heavy (A380/An-124 bounding radius ~45 m), nowhere near the 500–1000 m of
 *  the scale-24 jet.glb bug. */
const WORLD_RADIUS_MIN_M = 10;
const WORLD_RADIUS_MAX_M = 60;

test('model-space anchors honor Cesium minimum-pixel computed scale', () => {
  const matrix = [
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 1, 0,
    100, 200, 300, 1,
  ];
  const result = { x: 0, y: 0, z: 0 };
  modelVisualAnchor(matrix, [2, 3, -4], 7, result);
  assert.deepEqual(result, { x: 79, y: 214, z: 272 });
});

// --- minimal GLB bounds reader ---------------------------------------------

function glbJson(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file}: not a GLB`);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${file}: first chunk not JSON`);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

// Column-major 4×4 helpers (glTF matrix layout).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const rot = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  return mul(
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1],
    mul(rot, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]),
  );
}
function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Scene-space AABB over all mesh primitives' POSITION bounds, node transforms applied. */
function nativeBounds(file) {
  const gltf = glbJson(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (idx, parent) => {
    const node = gltf.nodes[idx];
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh != null) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION];
        if (!acc?.min || !acc?.max) continue;
        for (let i = 0; i < 8; i++) {
          const corner = transformPoint(m, [
            (i & 1) ? acc.max[0] : acc.min[0],
            (i & 2) ? acc.max[1] : acc.min[1],
            (i & 4) ? acc.max[2] : acc.min[2],
          ]);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], corner[a]);
            max[a] = Math.max(max[a], corner[a]);
          }
        }
      }
    }
    for (const child of node.children || []) visit(child, m);
  };
  for (const n of gltf.scenes[gltf.scene ?? 0].nodes) visit(n, IDENTITY);
  assert.ok(Number.isFinite(min[0]), `${file}: no POSITION bounds found`);
  return { min, max };
}

// --- real mesh reader (vertices + triangles, not just accessor bounds) ------
//
// The bounds reader above is enough to size a model, but NOT to site a point on
// it: an AABB corner is empty space. These read the POSITION buffers themselves
// so the trail anchor can be checked against actual triangles.

const GLB_COMPONENT_READERS = {
  5120: (buf, o) => buf.readInt8(o),
  5121: (buf, o) => buf.readUInt8(o),
  5122: (buf, o) => buf.readInt16LE(o),
  5123: (buf, o) => buf.readUInt16LE(o),
  5125: (buf, o) => buf.readUInt32LE(o),
  5126: (buf, o) => buf.readFloatLE(o),
};
const GLB_COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GLB_TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** JSON chunk plus the binary chunk of a GLB. */
function glbChunks(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let bin = null;
  for (let off = 20 + jsonLen; off + 8 <= buf.length;) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x004e4942) { bin = buf.subarray(off + 8, off + 8 + len); break; }
    off += 8 + len;
  }
  assert.ok(bin, `${file}: no BIN chunk`);
  return { gltf, bin };
}

/** One accessor's elements, honouring bufferView byteStride. */
function glbAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  assert.ok(!acc.sparse, 'sparse accessors are not used by the bundled assets');
  const read = GLB_COMPONENT_READERS[acc.componentType];
  const size = GLB_COMPONENT_BYTES[acc.componentType];
  const n = GLB_TYPE_COMPONENTS[acc.type];
  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || size * n;
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    const el = [];
    for (let c = 0; c < n; c++) el.push(read(bin, o + c * size));
    out.push(el);
  }
  return out;
}

/**
 * Every mesh vertex in Cesium model-local space, plus the triangle index list.
 * Same glTF Y-up → Cesium Z-up mapping the anchors are expressed in.
 */
function nativeMesh(file) {
  const { gltf, bin } = glbChunks(file);
  assert.ok(
    !(gltf.extensionsRequired || []).some((e) => e.toLowerCase().includes('draco')),
    `${file}: Draco-compressed assets would need a decoder here`,
  );
  const verts = [];
  const tris = [];
  const visit = (idx, parent) => {
    const node = gltf.nodes[idx];
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh != null) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const pIdx = prim.attributes?.POSITION;
        if (pIdx == null) continue;
        const start = verts.length;
        for (const p of glbAccessor(gltf, bin, pIdx)) {
          // RAW glTF axes, deliberately: the anchor table stores raw glTF and
          // lets Cesium's own axis correction do the rest (modelAnchorWorld).
          // Converting here would re-introduce the second, hand-maintained
          // convention whose half-correction put the anchor on the wrong axis.
          verts.push(transformPoint(m, p));
        }
        if (prim.indices != null) {
          const ind = glbAccessor(gltf, bin, prim.indices).map((e) => e[0]);
          for (let i = 0; i + 2 < ind.length; i += 3) {
            tris.push([start + ind[i], start + ind[i + 1], start + ind[i + 2]]);
          }
        } else {
          for (let i = start; i + 2 < verts.length; i += 3) tris.push([i, i + 1, i + 2]);
        }
      }
    }
    for (const child of node.children || []) visit(child, m);
  };
  for (const n of gltf.scenes[gltf.scene ?? 0].nodes) visit(n, IDENTITY);
  assert.ok(verts.length && tris.length, `${file}: no triangles found`);
  return { verts, tris };
}

/** AABB over real vertices (Cesium model-local). */
function vertexBounds(verts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      if (v[a] < min[a]) min[a] = v[a];
      if (v[a] > max[a]) max[a] = v[a];
    }
  }
  return { min, max };
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Closest point of triangle abc to p (Ericson, Real-Time Collision Detection). */
function closestOnTriangle(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den; const w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** How far a point lies from the nearest triangle of the mesh. */
function distanceToSurface(p, verts, tris) {
  let best = Infinity;
  for (const [i, j, k] of tris) {
    const d = dist3(p, closestOnTriangle(p, verts[i], verts[j], verts[k]));
    if (d < best) best = d;
  }
  return best;
}

/** The hull's longitudinal cross-section: where triangles cross the y = 0 plane. */
function centrelineProfile(verts, tris) {
  const pts = [];
  for (const [i, j, k] of tris) {
    const t = [verts[i], verts[j], verts[k]];
    for (let e = 0; e < 3; e++) {
      const a = t[e]; const b = t[(e + 1) % 3];
      if (a[2] === 0) pts.push(a);
      if ((a[2] < 0 && b[2] > 0) || (a[2] > 0 && b[2] < 0)) {
        const s = a[2] / (a[2] - b[2]);
        pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, 0]);
      }
    }
  }
  return pts;
}

/** Closest point of the centreline profile to `target` (segment-exact). */
function closestProfilePoint(target, profile, tris, verts) {
  // Walk the profile as the segments the slice actually produced, so the answer
  // can fall between two vertices the way the real surface does.
  const segs = [];
  for (const [i, j, k] of tris) {
    const t = [verts[i], verts[j], verts[k]];
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = t[e]; const b = t[(e + 1) % 3];
      if (a[2] === 0) pts.push(a);
      if ((a[2] < 0 && b[2] > 0) || (a[2] > 0 && b[2] < 0)) {
        const s = a[2] / (a[2] - b[2]);
        pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, 0]);
      }
    }
    if (pts.length >= 2) segs.push([pts[0], pts[1]]);
  }
  let best = null; let bestD = Infinity;
  for (const [a, b] of segs) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const den = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let q = a;
    if (den > 0) {
      let s = ((target[0] - a[0]) * ab[0] + (target[1] - a[1]) * ab[1] + (target[2] - a[2]) * ab[2]) / den;
      s = Math.max(0, Math.min(1, s));
      q = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
    }
    const d = dist3(target, q);
    if (d < bestD) { bestD = d; best = q; }
  }
  assert.ok(best, 'the centreline slice produced no segments');
  assert.ok(profile.length > 0, 'the centreline profile is empty');
  return best;
}

/** Native bounding radius: half-diagonal of the scene-space AABB. */
function nativeBoundingRadius(file) {
  const { min, max } = nativeBounds(file);
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
}

/** How far the glTF origin sits above the model's lowest vertex (glTF is Y-up;
 *  Cesium maps that to local up). This is the native "belly depth" the grounded-
 *  model snap must lift by so the model rests on its gear/belly, not its origin. */
function nativeOriginAboveLowestVertex(file) {
  return -nativeBounds(file).min[1];
}

/** Scene-AABB centre converted from glTF Y-up to Cesium model-local Z-up. */
function nativeVisualCenter(file) {
  const { min, max } = nativeBounds(file);
  const gltfCenter = min.map((value, axis) => (value + max[axis]) / 2);
  return [gltfCenter[0], -gltfCenter[2], gltfCenter[1]];
}

// --- per-layer constants, read from source (see header) --------------------

function layerConstants(sourceFile) {
  const src = fs.readFileSync(path.join(ROOT, sourceFile), 'utf8');
  const scale = src.match(/\bconst MODEL_SCALE = ([\d.]+);/);
  assert.ok(scale, `${sourceFile}: MODEL_SCALE not found`);
  const belly = src.match(/\bconst MODEL_BELLY_OFFSET_NATIVE = ([\d.]+);/);
  assert.ok(belly, `${sourceFile}: MODEL_BELLY_OFFSET_NATIVE not found`);
  return { modelScale: Number(scale[1]), bellyOffsetNative: Number(belly[1]) };
}

function normalBillboardScaleByDistance(sourceFile) {
  const src = fs.readFileSync(path.join(ROOT, sourceFile), 'utf8');
  const fn = src.match(/function _normalBillboardScaleByDistance\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, `${sourceFile}: _normalBillboardScaleByDistance not found`);
  const scalar = fn[1].match(/NearFarScalar\((\d+), ([\d.]+), (\d+), ([\d.]+)\)/);
  assert.ok(scalar, `${sourceFile}: billboard NearFarScalar not found`);
  return scalar.slice(1).map(Number);
}

const LAYERS = [
  {
    name: 'flights',
    source: 'src/data/flights.js',
    // All classes share one GLB today (see CLASS_MODEL_URL) — assert that, so
    // a real per-class asset drop-in forces this test to grow with it.
    asset: (() => {
      const urls = new Set(Object.values(CLASS_MODEL_URL));
      assert.equal(urls.size, 1, 'CLASS_MODEL_URL: expected a single shared GLB');
      return [...urls][0];
    })(),
  },
  {
    name: 'military',
    source: 'src/data/militaryFlights.js',
    asset: (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src/data/militaryFlights.js'), 'utf8');
      const m = src.match(/\bconst JET_MODEL_URL = '([^']+)';/);
      assert.ok(m, 'militaryFlights.js: JET_MODEL_URL not found');
      return m[1];
    })(),
  },
];

const measured = LAYERS.map((layer) => {
  const { modelScale, bellyOffsetNative } = layerConstants(layer.source);
  const assetPath = path.join(ROOT, 'public', layer.asset);
  const nativeRadius = nativeBoundingRadius(assetPath);
  return {
    ...layer, modelScale, bellyOffsetNative, nativeRadius,
    baseWorldRadius: nativeRadius * modelScale,
    originAboveBelly: nativeOriginAboveLowestVertex(assetPath),
  };
});

// --- the invariants ---------------------------------------------------------

for (const layer of measured) {
  test(`${layer.name}: every class renders at real-world aircraft scale (${layer.asset} native r=${layer.nativeRadius.toFixed(2)} × MODEL_SCALE ${layer.modelScale})`, () => {
    for (const [klass, mult] of Object.entries(CLASS_SCALE_3D)) {
      const worldRadius = layer.baseWorldRadius * mult;
      assert.ok(
        worldRadius >= WORLD_RADIUS_MIN_M && worldRadius <= WORLD_RADIUS_MAX_M,
        `${klass}: world bounding radius ${worldRadius.toFixed(1)} m outside ` +
        `[${WORLD_RADIUS_MIN_M}, ${WORLD_RADIUS_MAX_M}] m — MODEL_SCALE is calibrated ` +
        `for a different asset's native scale`,
      );
    }
  });
}

// Grounded-model belly offset (ground-3D, 2026-07-03): each layer's
// MODEL_BELLY_OFFSET_NATIVE must equal the GLB's actual origin-above-lowest-vertex
// height, else ground-snapped models sink into (const too small) or hover above
// (too big) the sampled tile skin. Absolute tolerance = 2% of the native bounding
// radius (sub-decimeter at world scale for both assets).
for (const layer of measured) {
  test(`${layer.name}: MODEL_BELLY_OFFSET_NATIVE matches ${layer.asset}'s origin height above its belly`, () => {
    const tol = layer.nativeRadius * 0.02;
    assert.ok(
      Math.abs(layer.bellyOffsetNative - layer.originAboveBelly) <= tol,
      `MODEL_BELLY_OFFSET_NATIVE ${layer.bellyOffsetNative} vs measured ` +
      `${layer.originAboveBelly.toFixed(3)} (tol ${tol.toFixed(3)}) — the constant was ` +
      'calibrated for a different asset; re-measure the GLB (glTF Y-up AABB, node transforms applied)',
    );
  });
}

test('flights and military models render at matching world sizes (cross-layer parity)', () => {
  const [flights, military] = measured;
  const ratio = flights.baseWorldRadius / military.baseWorldRadius;
  assert.ok(
    ratio > 1 / 1.5 && ratio < 1.5,
    `base world radii differ ×${(ratio >= 1 ? ratio : 1 / ratio).toFixed(1)} ` +
    `(flights ${flights.baseWorldRadius.toFixed(1)} m vs military ${military.baseWorldRadius.toFixed(1)} m) — ` +
    'the layers render side by side, so a class must read the same size in both',
  );
});

// --- 2026-08-15 Hangar fleet: real per-class GLBs ---------------------------
// CLASS_MODEL_REAL assets are vertex-baked to REAL-WORLD METERS in the
// airplane.glb axis convention and render at scale 1, so the class-envelope
// test above does not apply to them; instead each registry entry's radiusM
// and bellyM must MATCH the shipped GLB (the layers consume these numbers for
// pixel-cap math and grounded-model lift). Envelope: a real C172 (r≈7.1 m)
// up to a real 787-9 (r≈44.1 m) — nothing clamped, nothing monstrous.
const REAL_RADIUS_MIN_M = 5;
const REAL_RADIUS_MAX_M = 60;
for (const [klass, spec] of Object.entries(CLASS_MODEL_REAL)) {
  test(`hangar fleet: ${klass} registry pins match the shipped GLB (${spec.url})`, () => {
    const assetPath = path.join(ROOT, 'public', spec.url);
    const radius = nativeBoundingRadius(assetPath);
    const belly = nativeOriginAboveLowestVertex(assetPath);
    assert.ok(
      radius >= REAL_RADIUS_MIN_M && radius <= REAL_RADIUS_MAX_M,
      `${klass}: bounding radius ${radius.toFixed(2)} m outside the real-aircraft ` +
      `envelope [${REAL_RADIUS_MIN_M}, ${REAL_RADIUS_MAX_M}] m — the GLB is not baked to meters`,
    );
    const tol = radius * 0.02;
    assert.ok(
      Math.abs(radius - spec.radiusM) <= tol,
      `${klass}: registry radiusM ${spec.radiusM} vs measured ${radius.toFixed(3)} ` +
      `(tol ${tol.toFixed(3)}) — re-measure the GLB and update CLASS_MODEL_REAL`,
    );
    assert.ok(
      Math.abs(belly - spec.bellyM) <= tol,
      `${klass}: registry bellyM ${spec.bellyM} vs measured ${belly.toFixed(3)} ` +
      `(tol ${tol.toFixed(3)}) — grounded models would sink or hover; update CLASS_MODEL_REAL`,
    );
  });
}

// militaryFlights renders airplane.glb for its heavy classes with duplicated
// PLANE_* constants — pin them to the measured meter-scale GLB + flights'
// calibration so the copies cannot drift.
test('military layer airplane.glb constants match the measured GLB and flights calibration', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/data/militaryFlights.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`\\bconst ${name} = ([\\d.]+);`));
    assert.ok(m, `militaryFlights.js: ${name} not found`);
    return Number(m[1]);
  };
  const [flights] = measured;
  assert.equal(grab('PLANE_MODEL_SCALE'), flights.modelScale, 'PLANE_MODEL_SCALE must match flights MODEL_SCALE');
  assert.ok(
    Math.abs(grab('PLANE_NATIVE_RADIUS_M') - flights.nativeRadius) <= flights.nativeRadius * 0.02,
    `PLANE_NATIVE_RADIUS_M vs measured ${flights.nativeRadius.toFixed(3)}`,
  );
  assert.ok(
    Math.abs(grab('PLANE_BELLY_OFFSET_NATIVE') - flights.originAboveBelly) <= flights.nativeRadius * 0.02,
    `PLANE_BELLY_OFFSET_NATIVE vs measured ${flights.originAboveBelly.toFixed(3)}`,
  );
});

test('shared-model visual-centre metadata matches the shipped GLBs', () => {
  for (const [url, expected] of Object.entries(MODEL_VISUAL_CENTER_NATIVE)) {
    const measuredCenter = nativeVisualCenter(path.join(ROOT, 'public', url));
    measuredCenter.forEach((value, axis) => {
      assert.ok(
        Math.abs(value - expected[axis]) <= 0.001,
        `${url} axis ${axis}: metadata ${expected[axis]} vs measured ${value.toFixed(6)}`,
      );
    });
  }
});

// The tracked trail is drawn from a point BEHIND the aircraft to this anchor,
// so the anchor decides both whether the trail terminates ON the aeroplane and
// whether the last stretch of it crosses the airframe. An earlier round put the
// anchor on the aft-belly AABB CORNER, reasoning that a point aft of every
// vertex cannot be crossed. True, but a corner is empty space — 4.80 m from any
// real geometry on airplane.glb, 6.14 m on jet.glb — so the trail ended in mid
// air beside the model. The anchor is now a genuine hull point, and these pins
// re-derive it from the POSITION BUFFERS rather than restating the table.
test('every approved aircraft model has a trail anchor on its real aft-belly hull', () => {
  const urls = new Set([
    ...Object.keys(MODEL_VISUAL_CENTER_NATIVE),
    ...Object.values(CLASS_MODEL_REAL).map((spec) => spec.url),
  ]);
  assert.deepEqual(
    new Set(Object.keys(MODEL_TRAIL_ANCHOR_NATIVE)),
    urls,
    'trail-anchor metadata must cover every approved aircraft GLB',
  );

  for (const url of urls) {
    const file = path.join(ROOT, 'public', url);
    const { verts, tris } = nativeMesh(file);
    const { min, max } = vertexBounds(verts);
    const centre = min.map((value, axis) => (value + max[axis]) / 2);
    const actual = MODEL_TRAIL_ANCHOR_NATIVE[url];

    // 1. ON THE HULL. The property the AABB corner failed. Measured against the
    //    real triangles, not against a bounding box: the corner values sat
    //    metres out in open air, and this is what said so.
    // Measured bound across the shipped assets is <= 5e-5 native: re-measured
    // from these buffers they span 5.2e-6 (bell206) to 4.1e-5 (atr72), with
    // airplane.glb at 1.5e-5 and jet.glb at 1.8e-5. None is exactly zero — the
    // anchor is the nearest point of a triangulated profile, not a vertex — so
    // 1e-4 is met with margin and is still tight enough to catch an anchor that
    // has left the hull; the old 1e-3 was loose enough to be uninformative.
    const offHull = distanceToSurface(actual, verts, tris);
    assert.ok(
      offHull <= 1e-4,
      `${url}: trail anchor must lie ON the mesh — it is ${offHull.toFixed(4)} m off the ` +
      'nearest triangle, so the trail would end in mid air beside the aircraft',
    );

    // 2. AFT of the airframe's middle, or the head segment enters at the tail
    //    and stops inside the fuselage — the line through the model the review
    //    photographed. Every shipped asset clears 80 % of its aft extreme.
    assert.ok(
      actual[0] > centre[0],
      `${url}: trail anchor must sit aft of the centroid (${actual[0]} <= ${centre[0]})`,
    );
    assert.ok(
      actual[0] >= max[0] * 0.8,
      `${url}: trail anchor must sit on the AFT hull — ${actual[0].toFixed(3)} is only ` +
      `${(actual[0] / max[0] * 100).toFixed(1)}% of the ${max[0].toFixed(3)} aft extreme`,
    );

    // 3. BELOW: nothing of the aircraft hangs lower than the anchor at or
    //    behind its own station, so the trail leaves from underneath rather
    //    than out of the roof. Stated against the station rather than against
    //    the global minimum on purpose — the global lowest vertex is a wingtip
    //    or a gear leg amidships, and demanding the anchor match it is what
    //    drove the previous round off the hull in the first place.
    const profile = centrelineProfile(verts, tris);
    const lowestAtOrAft = profile
      .filter((p) => p[0] >= actual[0] - 1e-3)
      .reduce((lowest, p) => Math.min(lowest, p[1]), Infinity);
    assert.ok(
      Number.isFinite(lowestAtOrAft) && actual[1] <= lowestAtOrAft + 1e-3,
      `${url}: trail anchor must be the lowest centreline hull at or aft of its station ` +
      `(anchor ${actual[1]}, hull reaches ${lowestAtOrAft})`,
    );

    // 4. ON THE CENTRELINE, so the attachment cannot swing screen-left or
    //    screen-right as the aircraft turns.
    assert.equal(actual[2], 0, `${url}: trail anchor must stay on the longitudinal centreline`);

    // 5. And the value itself is the closest centreline hull point to the
    //    aft-belly corner — the construction, re-derived. This is what makes
    //    the table re-measurable rather than re-guessable.
    const corner = [max[0], min[1], 0];
    const nearest = closestProfilePoint(corner, profile, tris, verts);
    [0, 1].forEach((axis) => {
      assert.ok(
        Math.abs(actual[axis] - nearest[axis]) <= 1e-3,
        `${url} trail axis ${axis}: metadata ${actual[axis]} vs re-measured ${nearest[axis].toFixed(6)}`,
      );
    });
  }
});

// A PARKED contact is the case this decides. Grounded tracking starts a trail
// unconditionally, and on a contact that has not moved the last body point sits
// where the aircraft is — so the head segment ran from inside the model out to
// its own aft-belly anchor, straight through half the fuselage. The cut is on
// the segment's START, not its length (a length test hides trail that is
// genuinely in open air) and never on its END (clipping at the envelope stops a
// moving trail short of the aircraft). See trailHeadStart.
//
// A flat 1-D rig stands in for the world here: the model centre at the origin,
// the aft-belly anchor at its own measured station, and the last body point
// swept out along +x. That is exactly the geometry the guard reasons about —
// two distances from one centre — so the arithmetic under test is the shipped
// arithmetic, with no transform chain in the way (that is the pin below).
const TRAIL_RIG_URLS = new Set([
  ...Object.keys(MODEL_VISUAL_CENTER_NATIVE),
  ...Object.values(CLASS_MODEL_REAL).map((spec) => spec.url),
]);
const trailRigAt = (d) => ({ x: d, y: 0, z: 0 });
const trailRigCentre = trailRigAt(0);
/** The rig's world anchor: the model's own measured attachment point, laid out
 *  aft (+x) and below (y) exactly as far as it really sits from the centre. */
function trailRigAnchor(url) {
  const native = trailAnchorForModel(url);
  return { x: native[0] || 0, y: native[1] || 0, z: 0 };
}
/** Visible length of the head segment the guard would have drawn, in metres.
 *  Zero means nothing is drawn — which is the answer the whole guard exists for. */
function drawnHeadLength(start, anchor, centre, envelope) {
  const from = trailHeadStart(start, anchor, centre, envelope, { x: 0, y: 0, z: 0 });
  if (!from) return 0;
  return Math.hypot(from.x - anchor.x, from.y - anchor.y, from.z - anchor.z);
}

test('a stationary contact draws no trail head, and a moving one draws all of it', () => {
  for (const url of TRAIL_RIG_URLS) {
    const envelope = nativeBoundingRadius(path.join(ROOT, 'public', url));
    const anchor = trailRigAnchor(url);
    // Parked: the last body point is where the aircraft is. Nothing at all —
    // not a short segment, not a degenerate one. Nothing.
    assert.equal(
      trailHeadStart(trailRigCentre, anchor, trailRigCentre, envelope, { x: 0, y: 0, z: 0 }), null,
      `${url}: a parked contact's head segment is the anchor offset, not motion, ` +
      `and must not be drawn (envelope ${envelope.toFixed(2)} m)`,
    );
    // Still nothing while the last body point is no further out than the
    // anchor's own station: every millimetre of that segment would be drawn
    // FORWARD of the attachment point, into the fuselage.
    const station = Math.hypot(anchor.x, anchor.y, anchor.z);
    assert.equal(drawnHeadLength(trailRigAt(station * 0.5), anchor, trailRigCentre, envelope), 0,
      `${url}: a segment that would run forward of its own anchor draws nothing`);
    // At and past the envelope the segment is real and must be drawn IN FULL so
    // it reaches the hull — the failure mode clipping introduced. Referentially
    // the caller's own start point, so a contact that has cleared its own size
    // is bit-for-bit what the containment rule drew.
    const clear = trailRigAt(envelope * 1.01);
    assert.equal(trailHeadStart(clear, anchor, trailRigCentre, envelope, { x: 0, y: 0, z: 0 }), clear,
      `${url}: once the contact clears its own envelope the whole head must draw`);
  }

  // The review's repro: airplane.glb, a prior fix 58 m aft of a 34.41 m
  // envelope. The old length test suppressed this entirely; ~23.6 m of it is in
  // open air, so it must draw.
  const airliner = nativeBoundingRadius(path.join(ROOT, 'public', '/models/airplane.glb'));
  const anchor = trailRigAnchor('/models/airplane.glb');
  for (const [d, why] of [
    [58, 'a fix 58 m aft is well outside the envelope and its segment must be drawn'],
    [7500, 'a jet covers ~7.5 km between fixes — that trail must never be shortened'],
    [300, 'even a slow 10 m/s taxi between 30 s fixes still draws its whole trail'],
  ]) {
    const start = trailRigAt(d);
    assert.equal(
      trailHeadStart(start, anchor, trailRigCentre, airliner, { x: 0, y: 0, z: 0 }), start, why,
    );
  }
  // No model drawing (billboard owns the visual): nothing to cut through.
  const loose = trailRigAt(5);
  assert.equal(trailHeadStart(loose, anchor, null, 0, { x: 0, y: 0, z: 0 }), loose,
    'with no model envelope the whole segment always draws');
});

// THE PIN FOR THE BOUNDARY FLASH.
//
// The containment rule this replaces was BINARY, and a binary rule at
// airplane.glb's 34.41 m envelope is a 10.33 m flash: a start at 34.40 m drew
// nothing, a start at 34.42 m drew the entire segment, and a contact whose next
// fix landed back inside dropped it again. Two centimetres of travel cannot
// change ten metres of what the operator sees, and the pin the round shipped
// with could not catch it because it only ever asked static questions.
//
// So this asks the continuity question directly: sweep the start out through
// the boundary in small steps and require the VISIBLE LENGTH to move by no more
// than the step allows. The bound is 3x the step — the drawn length is at worst
// the segment's own growth (1:1 with the step) plus the reveal sliding across a
// shell that is never shorter than the segment it reveals, so 3 is a ceiling
// with room, and it is nowhere near the 10.33 m the boolean produced.
test('the trail head grows continuously across the envelope, never in one step', () => {
  for (const url of TRAIL_RIG_URLS) {
    const envelope = nativeBoundingRadius(path.join(ROOT, 'public', url));
    const anchor = trailRigAnchor(url);
    const step = envelope / 400;
    let previous = 0;
    for (let d = 0; d <= envelope * 1.5; d += step) {
      const start = trailRigAt(d);
      const length = drawnHeadLength(start, anchor, trailRigCentre, envelope);
      assert.ok(
        length - previous <= step * 3 + 1e-9 && previous - length <= step * 3 + 1e-9,
        `${url}: the head jumped ${Math.abs(length - previous).toFixed(3)} m across a ` +
        `${step.toFixed(3)} m step at ${d.toFixed(3)} m — that is the flash, not motion`,
      );
      // Never longer than the segment actually being drawn: the guard only ever
      // takes trail away from the START, and only ever from inside the envelope.
      const full = Math.hypot(start.x - anchor.x, start.y - anchor.y, start.z - anchor.z);
      assert.ok(length <= full + 1e-9,
        `${url}: drew ${length.toFixed(3)} m of a ${full.toFixed(3)} m segment at ${d.toFixed(3)} m`);
      previous = length;
    }
  }

  // The exact repro, in the numbers the review used.
  const airliner = nativeBoundingRadius(path.join(ROOT, 'public', '/models/airplane.glb'));
  const anchor = trailRigAnchor('/models/airplane.glb');
  const inside = drawnHeadLength(trailRigAt(34.40), anchor, trailRigCentre, airliner);
  const outside = drawnHeadLength(trailRigAt(34.42), anchor, trailRigCentre, airliner);
  assert.ok(outside > 10, `the segment 34.42 m aft is ~10.3 m long and must draw (${outside})`);
  assert.ok(Math.abs(outside - inside) < 0.1,
    'crossing the 34.41 m envelope by 2 cm must change the trail by centimetres, ' +
    `not by the whole ${outside.toFixed(2)} m segment (moved ${Math.abs(outside - inside).toFixed(3)} m)`);

  // And the flap: a contact whose fixes cross back and forth over the boundary
  // must not strobe the whole segment on and off. Each visit draws essentially
  // the same partial length as the last.
  const flap = [34.40, 34.42, 34.40, 34.43, 34.39].map(
    (d) => drawnHeadLength(trailRigAt(d), anchor, trailRigCentre, airliner));
  const spread = Math.max(...flap) - Math.min(...flap);
  assert.ok(spread < 0.1,
    `an in/out/in flap across the boundary moved the trail ${spread.toFixed(3)} m — ` +
    'the boolean rule moved the whole segment, and that is what the operator saw');
  assert.ok(Math.min(...flap) > 10,
    'every visit in that flap is a real ~10 m segment: the inside ones are partial, not absent');
});

// THE PIN THAT WOULD HAVE CAUGHT THE 2026-08-23 FIELD REGRESSION.
//
// The anchor is expressed in the model's own axes, and it only lands where it
// is meant to if it rides the SAME transform chain Cesium renders the model
// with. It did not: the table was stored after a single glTF Y-up -> Z-up step
// and multiplied straight by `modelMatrix`, which is half of Cesium's
// correction (the `fromGltfAsync` defaults also apply Z_UP_TO_X_UP). The
// aircraft's longitudinal axis is raw glTF X, so the aft offset landed on the
// RENDERED model's LATERAL axis — a 90-degree error that `modelMatrix`'s
// heading then rotated into world space, putting the trail out to one side and
// flipping which side as the course changed.
//
// A single-heading harness cannot catch this: at one heading a wrongly-framed
// offset can coincidentally point
// aft. So this sweeps headings and every shipped asset, and asserts the
// property directly — the anchor lies in the model's longitudinal/vertical
// plane, with NO lateral component.
//
// The mock carries a NON-IDENTITY `sceneGraph.components.transform`, because
// the chain has a third link and a mock without one cannot tell whether the
// code reads it: Cesium renders `modelMatrix x components.transform x
// axisCorrection`, and an asset with a baked root transform has to ride all
// three. A scale and an offset ALONG the model's own axes is the strongest
// choice the property survives — it changes both numbers the pin asserts
// (identity would leave them at the raw table values, which is the answer a
// dropped link also gives) while leaving lateral zero, which is the regression.
const TRAIL_ROOT_SCALE = 2;
const TRAIL_ROOT_OFFSET = Object.freeze({ lengthwise: 5, vertical: -1 });
test('the trail anchor rides the rendered longitudinal axis at every heading', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000);
  const sub = (a, b) => Cesium.Cartesian3.subtract(a, b, new Cesium.Cartesian3());
  // Cesium-model-local: x is lateral, y lengthwise, z vertical once the axis
  // correction has mapped raw glTF [x, y, z] -> [z, x, y].
  const rootTransform = Cesium.Matrix4.fromTranslationQuaternionRotationScale(
    new Cesium.Cartesian3(0, TRAIL_ROOT_OFFSET.lengthwise, TRAIL_ROOT_OFFSET.vertical),
    Cesium.Quaternion.IDENTITY,
    new Cesium.Cartesian3(TRAIL_ROOT_SCALE, TRAIL_ROOT_SCALE, TRAIL_ROOT_SCALE),
    new Cesium.Matrix4(),
  );
  for (const headingDeg of [0, 45, 90, 180, 270, 315]) {
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg), 0, 0);
    const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
      position, hpr, Cesium.Ellipsoid.WGS84, undefined, new Cesium.Matrix4(),
    );
    for (const [url, anchor] of Object.entries(MODEL_TRAIL_ANCHOR_NATIVE)) {
      const model = {
        modelMatrix,
        computedScale: 1,
        sceneGraph: { components: { transform: rootTransform } },
      };
      const origin = Cesium.Matrix4.getTranslation(modelMatrix, new Cesium.Cartesian3());
      const world = modelAnchorWorld(model, anchor, new Cesium.Cartesian3());
      // Reference axes derived INDEPENDENTLY, from the ENU frame and the same
      // heading the matrix was built with — deliberately NOT through
      // modelAnchorWorld. Taking them through the function under test makes the
      // check self-consistent: a wrong transform rotates the anchor and the
      // reference frame together and the lateral component stays zero, which is
      // how the first version of this pin passed against the very bug it was
      // written for.
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin, Cesium.Ellipsoid.WGS84, new Cesium.Matrix4());
      const axis = (i) => {
        const c = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
        return Cesium.Cartesian3.normalize(new Cesium.Cartesian3(c.x, c.y, c.z), new Cesium.Cartesian3());
      };
      const east = axis(0); const north = axis(1); const vertical = axis(2);
      const rad = Cesium.Math.toRadians(headingDeg);
      const lengthwise = Cesium.Cartesian3.normalize(Cesium.Cartesian3.add(
        Cesium.Cartesian3.multiplyByScalar(north, Math.cos(rad), new Cesium.Cartesian3()),
        Cesium.Cartesian3.multiplyByScalar(east, Math.sin(rad), new Cesium.Cartesian3()),
        new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const lateral = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.cross(lengthwise, vertical, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const offset = sub(world, origin);
      const along = Cesium.Cartesian3.dot(offset, lengthwise);
      const up = Cesium.Cartesian3.dot(offset, vertical);
      const side = Cesium.Cartesian3.dot(offset, lateral);
      const where = `${url} @ heading ${headingDeg}`;
      // The anchor must lie in the vertical plane through the heading. The
      // regression put the whole longitudinal offset on THIS axis.
      assert.ok(Math.abs(side) < 1e-4,
        `${where}: the anchor must have NO lateral component (got ${side.toFixed(4)} m) — ` +
        'a sideways offset is the field regression, and it is invisible at a single heading');
      // SIGNED, not magnitudes. An `abs()` on both sides passes an anchor that
      // landed on the nose instead of the tail, or on the roof instead of the
      // belly — which are the two directions the table exists to fix. The
      // expected values carry the root transform, so a dropped `components`
      // link fails here rather than quietly rendering the raw table value.
      const expectedAlong = anchor[0] * TRAIL_ROOT_SCALE + TRAIL_ROOT_OFFSET.lengthwise;
      const expectedUp = anchor[1] * TRAIL_ROOT_SCALE + TRAIL_ROOT_OFFSET.vertical;
      assert.ok(Math.abs(along - expectedAlong) < 1e-4,
        `${where}: the longitudinal offset must land AFT along the heading ` +
        `(${along.toFixed(4)} vs ${expectedAlong.toFixed(4)})`);
      assert.ok(Math.abs(up - expectedUp) < 1e-4,
        `${where}: the belly offset must land BELOW on the vertical axis ` +
        `(${up.toFixed(4)} vs ${expectedUp.toFixed(4)})`);
    }
  }
});

// A helicopter is in the sweep above by asset, but the field report also had a
// hovering H60 whose course is ill-defined. The anchor must not depend on the
// contact having a meaningful heading — it is a model-space offset, so an
// arbitrary heading still puts it aft of the hull.
test('a hovering rotorcraft anchors aft of its own hull, whatever its heading', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 300);
  const anchor = MODEL_TRAIL_ANCHOR_NATIVE['/models/bell206.glb'];
  for (const headingDeg of [0, 137.5, 271.9]) {
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg), 0, 0);
    const model = {
      modelMatrix: Cesium.Transforms.headingPitchRollToFixedFrame(
        position, hpr, Cesium.Ellipsoid.WGS84, undefined, new Cesium.Matrix4()),
      computedScale: 1,
    };
    const origin = Cesium.Matrix4.getTranslation(model.modelMatrix, new Cesium.Cartesian3());
    const world = modelAnchorWorld(model, anchor, new Cesium.Cartesian3());
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin, Cesium.Ellipsoid.WGS84, new Cesium.Matrix4());
    const ax = (i) => {
      const c = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
      return Cesium.Cartesian3.normalize(new Cesium.Cartesian3(c.x, c.y, c.z), new Cesium.Cartesian3());
    };
    const rad = Cesium.Math.toRadians(headingDeg);
    const fwd = Cesium.Cartesian3.normalize(Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(ax(1), Math.cos(rad), new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(ax(0), Math.sin(rad), new Cesium.Cartesian3()),
      new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const lateral = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(fwd, ax(2), new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const side = Cesium.Cartesian3.dot(
      Cesium.Cartesian3.subtract(world, origin, new Cesium.Cartesian3()), lateral);
    assert.ok(Math.abs(side) < 1e-4,
      `bell206 @ heading ${headingDeg}: hovering rotorcraft anchor drifted sideways by ${side.toFixed(4)} m`);
  }
});

test('legacy aircraft GLBs keep scale and orientation baked with no node transforms', () => {
  for (const url of Object.keys(MODEL_VISUAL_CENTER_NATIVE)) {
    const file = path.join(ROOT, 'public', url);
    const gltf = glbJson(file);
    for (const node of gltf.nodes || []) {
      assert.equal(node.matrix, undefined, `${url}: ${node.name || 'node'} has an unapplied matrix`);
      assert.equal(node.translation, undefined, `${url}: ${node.name || 'node'} has unapplied translation`);
      assert.equal(node.rotation, undefined, `${url}: ${node.name || 'node'} has unapplied rotation`);
      assert.equal(node.scale, undefined, `${url}: ${node.name || 'node'} has unapplied scale`);
    }
    const { min, max } = nativeBounds(file);
    const extents = max.map((value, axis) => value - min[axis]);
    assert.ok(
      extents[1] < extents[0] && extents[1] < extents[2],
      `${url}: glTF +Y must remain the short vertical axis; got ${extents.map((v) => v.toFixed(2)).join(' × ')}`,
    );
  }
});

test('real per-class models remain origin-centred for visual anchoring', () => {
  for (const spec of Object.values(CLASS_MODEL_REAL)) {
    const center = nativeVisualCenter(path.join(ROOT, 'public', spec.url));
    const maxOffset = Math.max(...center.map(Math.abs));
    assert.ok(
      maxOffset <= 0.001,
      `${spec.url}: visual centre ${center.map((v) => v.toFixed(4)).join(', ')} ` +
      'must stay at the origin or receive explicit modelVisualAnchor metadata',
    );
  }
});

test('civilian and military globe-view aircraft retain the established 3.0 near scale and 0.5 floor', () => {
  for (const layer of LAYERS) {
    assert.deepEqual(
      normalBillboardScaleByDistance(layer.source),
      [1000, 3, 8000000, 0.5],
      `${layer.name}: owner-established close sizing and the orbital floor must remain readable`,
    );
  }
});
