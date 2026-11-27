#!/usr/bin/env node
// Writes shared/population-density-boundaries.json: the outlines of the
// countries in PRIORITY_COUNTRIES, cut from the pinned 10m World Atlas
// in scripts/data, so the server can find which density-table country holds a bare
// lat/lon. The 110m countries.geojson is too coarse for this: Taiwan is an
// 8-point polygon that misses Taipei, and Israel's outline covers Gaza.
//
//   node --import tsx scripts/generate-population-density-boundaries.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';

import { PRIORITY_COUNTRIES } from '../shared/analysis-population-exposure.ts';
import { resolveCountryCode } from '../shared/country-code-resolve.ts';
import { iso2ToUnCode } from '../shared/country-numeric-codes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'scripts/data/population-density-countries-10m.json';
const OUTPUT = 'shared/population-density-boundaries.json';
// Preserve the existing small browser-only Palestinian correction outline.
// Server containment and snap guards below retain the raw atlas geometry.
const TOLERANCE = 0.02;
// Somaliland is in Somalia's population and area figures but is its own
// atlas feature, with no numeric id.
const MERGE_BY_NAME = { Somaliland: 'SO' };

function simplify(points) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  let farthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const distance = length === 0
      ? Math.hypot(px - ax, py - ay)
      : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= TOLERANCE) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1)).slice(0, -1), ...simplify(points.slice(index))];
}

const round = (value) => Number(value.toFixed(3));
const simplifyPolygon = (polygon) => polygon
  .map((ring) => simplify(ring).map(([lon, lat]) => [round(lon), round(lat)]))
  .filter((ring) => ring.length >= 4);
const polygonsOf = (geometry) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

const iso2ByUnCode = new Map(Object.keys(PRIORITY_COUNTRIES).map((iso3) => {
  const iso2 = resolveCountryCode(iso3);
  return [iso2ToUnCode(iso2), iso2];
}));
const atlas = JSON.parse(readFileSync(resolve(ROOT, SOURCE), 'utf8'));
// Source: https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json
// SHA256: 3bc6f1d367a9bcec479841bae0e76092f512838411d0cef124e92eec4db45f79
// License: ISC; underlying Natural Earth map data is public domain.
// Keep the atlas quantization and shared arcs intact. Expanded floating-point
// rings are much larger; TopoJSON preserves the source exactly within the budget.
const geometries = atlas.objects.countries.geometries;
const codeOf = (g) => MERGE_BY_NAME[g.properties?.name] ?? iso2ByUnCode.get(g.id);
const arcIds = (g) => g.arcs.flat(Infinity).map((id) => id < 0 ? ~id : id);
const selected = geometries.filter(codeOf);
const missing = [...iso2ByUnCode.values()].filter((code) => !selected.some((g) => codeOf(g) === code));
if (missing.length) throw new Error(`${SOURCE} has no geometry for ${missing.join(', ')}`);
const used = new Set(selected.flatMap(arcIds));
const owners = new Map();
for (const g of geometries) for (const id of new Set(arcIds(g))) {
  const codes = owners.get(id) ?? new Set();
  codes.add(codeOf(g) ?? `foreign:${g.id ?? g.properties?.name}`);
  owners.set(id, codes);
}
const decoded = atlas.arcs.map((arc) => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => [(x += dx), (y += dy)]);
});
const position = ([x, y]) => [
  x * atlas.transform.scale[0] + atlas.transform.translate[0],
  y * atlas.transform.scale[1] + atlas.transform.translate[1],
];
// This is only a conservative build-time spatial filter, never a containment
// approximation. Retain foreign edges near table edges, including across water.
// Ten km covers both five-km legs from query to coast and query to foreign edge.
const CELL = 0.25;
function cellsForEdge(a, b, marginKm = 0) {
  const [ax, ay] = position(a), [bx, by] = position(b);
  const dy = marginKm / 110;
  const dx = dy / Math.max(0.001, Math.cos((Math.max(Math.abs(ay), Math.abs(by)) + dy) * Math.PI / 180));
  const cells = [];
  for (let y = Math.floor((Math.min(ay, by) - dy) / CELL); y <= Math.floor((Math.max(ay, by) + dy) / CELL); y++) {
    for (let x = Math.floor((Math.min(ax, bx) - dx) / CELL); x <= Math.floor((Math.max(ax, bx) + dx) / CELL); x++) {
      cells.push(`${((x + 720) % 1440 + 1440) % 1440},${y}`);
    }
  }
  return cells;
}
const nearby = new Set();
for (const id of used) {
  const points = decoded[id];
  for (let i = 1; i < points.length; i++) for (const cell of cellsForEdge(points[i - 1], points[i], 10)) nearby.add(cell);
}
const arcs = [];
const remap = new Map();
const guards = [];
function addArc(id, arc) {
  const index = arcs.push(arc) - 1;
  const codes = owners.get(id);
  guards.push({ owner: codes.size === 1 ? [...codes][0] : '', arc: index });
  return index;
}
for (const id of used) remap.set(id, addArc(id, atlas.arcs[id]));
for (let id = 0; id < decoded.length; id++) {
  if (used.has(id)) continue;
  const points = decoded[id];
  let run = [];
  const flush = () => {
    if (run.length > 1) addArc(id, run.map(([x, y], i) => i ? [x - run[i - 1][0], y - run[i - 1][1]] : [x, y]));
    run = [];
  };
  for (let i = 1; i < points.length; i++) {
    if (cellsForEdge(points[i - 1], points[i]).some((cell) => nearby.has(cell))) {
      if (!run.length) run.push(points[i - 1]);
      run.push(points[i]);
    } else flush();
  }
  flush();
}
const remapArcs = (value) => Array.isArray(value) ? value.map(remapArcs) : value < 0 ? ~remap.get(~value) : remap.get(value);
const topology = {
  type: 'Topology', transform: atlas.transform, arcs,
  objects: { countries: { type: 'GeometryCollection', geometries: selected.map((g) => ({
    type: g.type, arcs: remapArcs(g.arcs), properties: { code: codeOf(g) },
  })) } },
};
const countries = {};
for (const { properties, geometry } of feature(atlas, atlas.objects.countries).features) {
  // The dashboard's small provider-correction outline keeps its existing contract.
  if (properties?.name === 'Palestine') countries.PS = polygonsOf(geometry).map(simplifyPolygon);
}
const output = `${JSON.stringify({ source: SOURCE, topology, guards })}\n`;
const outputs = new Map([
  [OUTPUT, output],
  ['shared/population-density-palestine.json', `${JSON.stringify(countries.PS)}\n`],
]);
for (const [outputPath, content] of outputs) {
  const target = resolve(ROOT, outputPath);

  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* a missing file is stale */ }
    if (current !== content) {
      console.error(`${outputPath} is stale. Run: node --import tsx scripts/generate-population-density-boundaries.mjs`);
      process.exit(1);
    }
  } else {
    writeFileSync(target, content);
    console.log(`wrote ${outputPath} (${content.length} bytes)`);
  }
}
