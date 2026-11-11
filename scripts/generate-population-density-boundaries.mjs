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
// Douglas-Peucker tolerance in degrees, about 2 km. The smallest event radius
// is 30 km. Simplification keeps the Edge geometry bundle bounded.
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
// Shared topology arcs are land borders. Keep them as a snap exclusion guard
// so a point in an unsupported neighbour cannot borrow a table density.
const arcUses = new Map();
const arcIds = (geometry) => geometry.arcs.flat(Infinity).map((id) => id < 0 ? ~id : id);
for (const geometry of atlas.objects.countries.geometries) {
  for (const id of new Set(arcIds(geometry))) arcUses.set(id, (arcUses.get(id) ?? 0) + 1);
}
const landBorders = {};
for (const geometry of atlas.objects.countries.geometries) {
  const code = MERGE_BY_NAME[geometry.properties?.name] ?? iso2ByUnCode.get(geometry.id);
  if (!code) continue;
  const arcs = arcIds(geometry).filter((id) => arcUses.get(id) > 1).map((id) => [id]);
  const lines = feature(atlas, { type: 'MultiLineString', arcs }).geometry.coordinates;
  (landBorders[code] ??= []).push(...lines.map((line) => simplify(line).map(([lon, lat]) => [round(lon), round(lat)])));
}
const countries = {};
for (const { id, properties, geometry } of feature(atlas, atlas.objects.countries).features) {
  const code = MERGE_BY_NAME[properties?.name] ?? iso2ByUnCode.get(id);
  if (!code || !geometry) continue;
  const polygons = polygonsOf(geometry).map(simplifyPolygon).filter((polygon) => polygon.length > 0);
  (countries[code] ??= []).push(...polygons);
}

const missing = [...iso2ByUnCode.values()].filter((code) => !countries[code]?.length);
if (missing.length > 0) throw new Error(`${SOURCE} has no geometry for ${missing.join(', ')}`);

const sorted = Object.fromEntries(Object.keys(countries).sort().map((code) => [code, countries[code]]));
const output = `${JSON.stringify({ source: SOURCE, toleranceDegrees: TOLERANCE, countries: sorted, landBorders })}\n`;
const outputs = new Map([
  [OUTPUT, output],
  ['shared/population-density-palestine.json', `${JSON.stringify(sorted.PS)}\n`],
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
