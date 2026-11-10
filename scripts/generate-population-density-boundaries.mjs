#!/usr/bin/env node
// Writes shared/population-density-boundaries.json: the outlines of the
// countries in PRIORITY_COUNTRIES, cut from the desktop map's 50m world
// atlas, so the server can find which density-table country holds a bare
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
const SOURCE = 'public/data/countries-50m.json';
const OUTPUT = 'shared/population-density-boundaries.json';
// Douglas-Peucker tolerance in degrees, about 2 km. The smallest event radius
// is 30 km. Without it Russia's coastline alone is 120 KB.
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
const topology = JSON.parse(readFileSync(resolve(ROOT, SOURCE), 'utf8'));
const countries = {};
for (const { id, properties, geometry } of feature(topology, topology.objects.countries).features) {
  const code = MERGE_BY_NAME[properties?.name] ?? iso2ByUnCode.get(id);
  if (!code || !geometry) continue;
  const polygons = polygonsOf(geometry).map(simplifyPolygon).filter((polygon) => polygon.length > 0);
  (countries[code] ??= []).push(...polygons);
}

const missing = [...iso2ByUnCode.values()].filter((code) => !countries[code]?.length);
if (missing.length > 0) throw new Error(`${SOURCE} has no geometry for ${missing.join(', ')}`);

const sorted = Object.fromEntries(Object.keys(countries).sort().map((code) => [code, countries[code]]));
const output = `${JSON.stringify({ source: SOURCE, toleranceDegrees: TOLERANCE, countries: sorted })}\n`;
const target = resolve(ROOT, OUTPUT);

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch { /* a missing file is stale */ }
  if (current !== output) {
    console.error(`${OUTPUT} is stale. Run: node --import tsx scripts/generate-population-density-boundaries.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
  console.log(`wrote ${OUTPUT} (${Object.keys(sorted).length} countries, ${output.length} bytes)`);
}
