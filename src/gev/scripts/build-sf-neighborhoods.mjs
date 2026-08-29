#!/usr/bin/env node
/**
 * Build src/data/local_data/neighborhoods/san-francisco.json from the official
 * public-domain DataSF "Analysis Neighborhoods" dataset.
 *
 * Source (map view):  https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h
 * Underlying dataset: https://data.sfgov.org/d/j2bu-swwd  (columns: the_geom, nhood)
 * Fetched from:       https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=100
 * License:            Open Data Commons Public Domain Dedication and License (PDDL 1.0)
 *                     (dataset metadata `licenseId: "PDDL"` at
 *                     https://data.sfgov.org/api/views/j2bu-swwd.json)
 *
 * Transform (deterministic):
 *   1. `properties.nhood` → `properties.name` (no renames — DataSF names kept verbatim).
 *   2. Douglas-Peucker simplification per ring, tolerance 2e-5° (~2 m) — shaves
 *      hyper-detailed shoreline vertices without visibly moving boundaries.
 *   3. Coordinates rounded to 6 decimals (~0.1 m); consecutive duplicates dropped;
 *      rings re-closed; rings that collapse below 4 points dropped.
 *   4. Single-part MultiPolygons collapsed to Polygon.
 *   5. Features sorted by name for a stable diff.
 *
 * Usage:
 *   node scripts/build-sf-neighborhoods.mjs [raw.geojson]
 * With no argument it downloads the live dataset; with an argument it reads the
 * given raw GeoJSON file (the exact bytes retrieved on 2026-07-30 in our case).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=100';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'neighborhoods', 'san-francisco.json');
const TOLERANCE = 2e-5; // degrees, ~2 m
const DECIMALS = 6;

/** Perpendicular distance from point p to segment a-b (in degrees, planar — fine at this scale). */
function segDist(p, a, b) {
  let [x, y] = p; const [x1, y1] = a; const [x2, y2] = b;
  let dx = x2 - x1; let dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x -= x2; y -= y2; return Math.hypot(x, y); }
    if (t > 0) { x -= x1 + dx * t; y -= y1 + dy * t; return Math.hypot(x, y); }
  }
  return Math.hypot(x - x1, y - y1);
}

/** Iterative Douglas-Peucker on an open point list. */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0; let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (v) => Number(v.toFixed(DECIMALS));

/** Simplify + round one ring; returns null if it degenerates. */
function processRing(ring) {
  // GeoJSON rings are closed (first == last); simplify the open part.
  const open = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1) : ring.slice();
  const simplified = douglasPeucker(open, TOLERANCE).map(([lon, lat]) => [round(lon), round(lat)]);
  const out = [];
  for (const pt of simplified) {
    const prev = out[out.length - 1];
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
    out.push(pt);
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]); // re-close
  return out;
}

async function main() {
  let rawText;
  if (process.argv[2]) {
    rawText = fs.readFileSync(process.argv[2], 'utf8');
    console.log(`read ${process.argv[2]}`);
  } else {
    console.log(`fetching ${SOURCE_URL}`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} from DataSF`);
    rawText = await res.text();
  }
  const raw = JSON.parse(rawText);
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('unexpected payload: not a FeatureCollection');
  }

  let inVerts = 0; let outVerts = 0;
  const features = [];
  for (const f of raw.features) {
    const name = f.properties && f.properties.nhood;
    if (!name || !f.geometry) throw new Error(`feature missing nhood/geometry: ${JSON.stringify(f.properties)}`);
    const polysIn = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates
      : f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
        : null;
    if (!polysIn) throw new Error(`unexpected geometry type ${f.geometry.type} for ${name}`);
    const polys = [];
    for (const poly of polysIn) {
      const rings = [];
      for (const ring of poly) {
        inVerts += ring.length;
        const r = processRing(ring);
        if (r) { rings.push(r); outVerts += r.length; }
      }
      if (rings.length && poly[0] && rings[0]) polys.push(rings);
    }
    if (!polys.length) throw new Error(`geometry collapsed for ${name}`);
    const geometry = polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys };
    features.push({ type: 'Feature', properties: { name }, geometry });
  }
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

  const out = {
    type: 'FeatureCollection',
    city: 'San Francisco',
    source: 'DataSF "Analysis Neighborhoods" (dataset j2bu-swwd, map view p5b7-5n3h) — PDDL 1.0 (public domain); see SOURCE.md',
    features,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${OUT}: ${features.length} features, ${inVerts} → ${outVerts} vertices, ${kb} KB`);
}

main().catch((err) => { console.error(err); process.exit(1); });
