#!/usr/bin/env node
// The issue's original sweep was not attached. This fixed seed is a repeatable
// 24,383-point sample, not a reproduction of its exact 19/136 baseline counts.
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { isMainModule } from './lib/main-module.mjs';
import { densityCountryAt } from '../shared/population-density-country-at.ts';
import { PRIORITY_COUNTRIES } from '../shared/analysis-population-exposure.ts';
import { resolveCountryCode } from '../shared/country-code-resolve.ts';
import { iso2ToUnCode } from '../shared/country-numeric-codes.ts';
import { inRing } from '../shared/population-density-geometry.ts';
import DATA from '../shared/population-density-boundaries.json' with { type: 'json' };

const atlas = JSON.parse(readFileSync(new URL('./data/population-density-countries-10m.json', import.meta.url), 'utf8'));
const codes = new Map(Object.keys(PRIORITY_COUNTRIES).map((code) => {
  const iso2 = resolveCountryCode(code);
  return [iso2ToUnCode(iso2), iso2];
}));
const polygonsOf = (geometry) => geometry.type === 'Polygon' ? [geometry.coordinates]
  : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
const contains = (polygons, lat, lon) => polygons.some(([outer, ...holes]) =>
  inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));

// Recognize the previous generated schema solely for the documented revert
// experiment: distinguish wrong containment from an actual wrong-country snap.
const generated = DATA.countries ?? {};
if (DATA.topology) {
  for (const { properties, geometry } of feature(DATA.topology, DATA.topology.objects.countries).features) {
    (generated[properties.code] ??= []).push(...polygonsOf(geometry));
  }
}
const countries = feature(atlas, atlas.objects.countries).features.map(({ id, properties, geometry }) => ({
  name: properties.name,
  code: properties.name === 'Somaliland' ? 'SO' : codes.get(id) ?? null,
  polygons: polygonsOf(geometry).map((rings) => ({
    rings,
    bbox: rings[0].reduce(([w, s, e, n], [x, y]) =>
      [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)],
    [Infinity, Infinity, -Infinity, -Infinity]),
  })),
}));
function countryAt(lat, lon) {
  return countries.find((country) => country.polygons.some(({ rings, bbox: [w, s, e, n] }) =>
    lon >= w && lon <= e && lat >= s && lat <= n && contains([rings], lat, lon)));
}
const vertices = countries.filter((country) => country.code)
  .flatMap((country) => country.polygons.flatMap((polygon) => polygon.rings[0]));

export function runSweep() {
  let seed = 10462;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const counts = { sampled: 24383, rawTableLand: 0, offshoreEstimates: 0, wrongCountry: 0, wrongSnaps: 0, nullTableLand: 0 };
  const examples = {};
  const snapExamples = {};
  for (let i = 0; i < counts.sampled; i++) {
    const [x, y] = vertices[Math.floor(random() * vertices.length)];
    const lat = y + (random() - 0.5) * 0.12;
    const lon = ((x + (random() - 0.5) * 0.12 / Math.max(0.1, Math.cos(y * Math.PI / 180)) + 540) % 360) - 180;
    const raw = countryAt(lat, lon);
    const actual = densityCountryAt(lat, lon);
    if (raw?.code) {
      counts.rawTableLand++;
      if (!actual) counts.nullTableLand++;
    }
    if (!raw && actual) counts.offshoreEstimates++;
    if (raw && actual && actual !== raw.code) {
      counts.wrongCountry++;
      const example = { lat, lon, actual, expected: raw.code };
      if (!contains(generated[actual], lat, lon)) {
        counts.wrongSnaps++;
        snapExamples[raw.name] ??= example;
      }
      examples[raw.name] ??= example;
    }
  }
  return { counts, examples, snapExamples };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const result = runSweep();
  console.log(JSON.stringify(result, null, 2));
  if (result.counts.wrongCountry || result.counts.nullTableLand > 0) process.exitCode = 1;
}
