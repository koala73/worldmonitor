#!/usr/bin/env node
// Generates scripts/shared/cii-country-borders.data.mjs: the country borders the
// CII uses to place a coordinate in a Tier-1 country
// (scripts/shared/cii-country-borders.mjs reads it).
//
// Source: public/data/countries-50m.json, the Natural Earth 1:50m admin-0
// TopoJSON the map already ships. Each shared border arc is simplified once,
// so neighbouring countries keep exactly the same simplified border and no
// gap or overlap opens between them. Land of every non-Tier-1 country is kept
// as unnamed land: a point there is in no Tier-1 country, and it stops the
// coastal-waters fallback from reaching across a land border.
//
// Three attribution rules differ from the source file:
// - Crimea counts as Ukraine. Natural Earth 1:50m draws it inside Russia; the
//   internationally recognised border, the map's countries.geojson and every
//   CII version before v11 place it in Ukraine.
// - Gaza and the West Bank count toward the Israel row. The CII has no
//   Palestine row, and v10 bounding boxes and the Israel news keywords
//   ('gaza') already attributed them there.
// - France is metropolitan France and Corsica. Natural Earth 1:50m includes
//   French Guiana, Martinique, Guadeloupe, Reunion and Mayotte, which carry
//   their own ISO 3166 codes (GF, MQ, GP, RE, YT) everywhere else in the CII.
//
// Usage: node scripts/generate-cii-country-borders.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'public/data/countries-50m.json';
// An inline ES module, not JSON: the file is reached from Vercel Edge handlers,
// where `with { type: 'json' }` breaks the bundle, and from plain Node seeders,
// where a bare JSON import throws (tests/no-json-import-attributes-on-edge-path).
export const CII_COUNTRY_BORDERS_PATH = 'scripts/shared/cii-country-borders.data.mjs';

// Douglas-Peucker tolerance in degrees (~1 km). The source's own grid is
// 0.0036 deg of longitude, and 1:50m borders are generalised by a few km, so
// this removes points without adding meaningful error.
export const SIMPLIFY_TOLERANCE_DEG = 0.01;
// Coastlines can be coarser than land borders: a point just offshore still
// reaches its country through the 12-nautical-mile coastal fallback.
export const COAST_TOLERANCE_DEG = 0.02;
export const OTHER_LAND_TOLERANCE_DEG = 0.05;
// Non-Tier-1 land kept only near a Tier-1 border or coast (well beyond the
// coastal fallback's 12 nautical miles).
export const NEAR_TIER1_DEG = 0.5;

// ISO 3166-1 numeric ids (the source's feature ids) of the 31 Tier-1 countries.
export const TIER1_NUMERIC_IDS = {
  US: '840', RU: '643', CN: '156', UA: '804', IR: '364', IL: '376', TW: '158', KP: '408',
  SA: '682', TR: '792', PL: '616', DE: '276', FR: '250', GB: '826', IN: '356', PK: '586',
  SY: '760', YE: '887', MM: '104', VE: '862', CU: '192', MX: '484', BR: '076', AE: '784',
  KR: '410', IQ: '368', AF: '004', LB: '422', EG: '818', JP: '392', QA: '634',
};
// Territories with no CII row, by ISO2 and source id, and the Tier-1 row they count toward.
export const ATTRIBUTED_TERRITORIES = { PS: 'IL' };
const TERRITORY_NUMERIC_IDS = { PS: '275' };
const RUSSIA_NUMERIC_ID = '643';
// Every Natural Earth polygon of Russia whose bounding box lies inside this box is Crimea.
const CRIMEA_BOX = { minLon: 32.2, maxLon: 36.8, minLat: 44.2, maxLat: 46.3 };
const FRANCE_NUMERIC_ID = '250';
// Metropolitan France and Corsica; French polygons outside it are overseas regions.
const METROPOLITAN_FRANCE_BOX = { minLon: -6, maxLon: 10, minLat: 41, maxLat: 52 };

function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return { qx: x, qy: y, lon: x * sx + tx, lat: y * sy + ty };
    });
  });
}

function perpendicularDistance(p, a, b) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.lon - a.lon, p.lat - a.lat);
  const t = Math.max(0, Math.min(1, ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / len2));
  return Math.hypot(p.lon - (a.lon + t * dx), p.lat - (a.lat + t * dy));
}

function simplifyArc(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  // A closed ring arc (start === end) needs at least 4 points to stay a ring.
  const kept = points.filter((_, i) => keep[i]);
  if (kept.length < 4 && points[0].qx === points.at(-1).qx && points[0].qy === points.at(-1).qy) {
    return points.length <= 4 ? points : [points[0], points[Math.floor(points.length / 3)],
      points[Math.floor((2 * points.length) / 3)], points.at(-1)];
  }
  return kept;
}

function geometryPolygons(geometry) {
  if (geometry.type === 'Polygon') return [geometry.arcs];
  if (geometry.type === 'MultiPolygon') return geometry.arcs;
  return [];
}

function polygonBox(polygon, arcs) {
  const box = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
  for (const ring of polygon) {
    for (const index of ring) {
      for (const p of arcs[index < 0 ? ~index : index]) {
        box.minLon = Math.min(box.minLon, p.lon);
        box.maxLon = Math.max(box.maxLon, p.lon);
        box.minLat = Math.min(box.minLat, p.lat);
        box.maxLat = Math.max(box.maxLat, p.lat);
      }
    }
  }
  return box;
}

function insideBox(inner, outer) {
  return inner.minLon >= outer.minLon && inner.maxLon <= outer.maxLon
    && inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat;
}

/** Builds the generated document from the source TopoJSON. Deterministic. */
export function buildCiiCountryBorders(topology) {
  const decoded = decodeArcs(topology);
  const codeById = Object.fromEntries(Object.entries(TIER1_NUMERIC_IDS).map(([code, id]) => [id, code]));
  const polygonsByCode = Object.fromEntries(Object.keys(TIER1_NUMERIC_IDS).map((code) => [code, []]));
  const otherLand = [];
  for (const geometry of topology.objects.countries.geometries) {
    for (const polygon of geometryPolygons(geometry)) {
      let code = codeById[geometry.id] ?? null;
      for (const [iso2, id] of Object.entries(TERRITORY_NUMERIC_IDS)) if (geometry.id === id) code = ATTRIBUTED_TERRITORIES[iso2];
      if (geometry.id === RUSSIA_NUMERIC_ID && insideBox(polygonBox(polygon, decoded), CRIMEA_BOX)) code = 'UA';
      if (geometry.id === FRANCE_NUMERIC_ID && !insideBox(polygonBox(polygon, decoded), METROPOLITAN_FRANCE_BOX)) code = null;
      (code ? polygonsByCode[code] : otherLand).push(polygon);
    }
  }
  for (const [code, polygons] of Object.entries(polygonsByCode)) {
    if (polygons.length === 0) throw new Error(`No border polygons for Tier-1 country ${code}`);
  }

  // Other land only matters near a Tier-1 country: farther away, the coastal
  // fallback finds no Tier-1 coast in range anyway. Keep a non-Tier-1 polygon
  // when any of its points is within NEAR_TIER1_DEG of a Tier-1 border point.
  // An arc two polygons use is a land border; an arc one polygon uses is coast.
  const arcUses = new Map();
  for (const geometry of topology.objects.countries.geometries) {
    for (const index of geometryPolygons(geometry).flat(2)) {
      const source = index < 0 ? ~index : index;
      arcUses.set(source, (arcUses.get(source) ?? 0) + 1);
    }
  }
  const tier1Arcs = new Set(Object.values(polygonsByCode).flat(3).map((index) => (index < 0 ? ~index : index)));
  const cell = (lon, lat) => `${Math.floor(lon / NEAR_TIER1_DEG)}:${Math.floor(lat / NEAR_TIER1_DEG)}`;
  const nearCells = new Set();
  for (const source of tier1Arcs) {
    for (const p of decoded[source]) {
      const cx = Math.floor(p.lon / NEAR_TIER1_DEG);
      const cy = Math.floor(p.lat / NEAR_TIER1_DEG);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) nearCells.add(`${cx + dx}:${cy + dy}`);
    }
  }
  const nearOtherLand = otherLand.filter((polygon) => polygon.some((ring) => ring.some((index) => (
    decoded[index < 0 ? ~index : index].some((p) => nearCells.has(cell(p.lon, p.lat)))
  ))));

  // Renumber the arcs actually used, simplify each once, and delta-encode them
  // on the source grid so the file stays compact. An arc a Tier-1 country uses
  // keeps the fine tolerance on both sides of the border; coastlines only other
  // land uses are coarser, since they only bound the coastal fallback.
  const remap = new Map();
  const arcs = [];
  const useArc = (index) => {
    const source = index < 0 ? ~index : index;
    if (!remap.has(source)) {
      remap.set(source, arcs.length);
      const tolerance = !tier1Arcs.has(source) ? OTHER_LAND_TOLERANCE_DEG
        : (arcUses.get(source) ?? 0) > 1 ? SIMPLIFY_TOLERANCE_DEG
        : COAST_TOLERANCE_DEG;
      const points = simplifyArc(decoded[source], tolerance);
      const encoded = [];
      let px = 0;
      let py = 0;
      for (const p of points) {
        encoded.push(p.qx - px, p.qy - py);
        px = p.qx;
        py = p.qy;
      }
      arcs.push(encoded);
    }
    const target = remap.get(source);
    return index < 0 ? ~target : target;
  };
  const encodePolygons = (polygons) => polygons.map((polygon) => polygon.map((ring) => ring.map(useArc)));
  const countries = Object.fromEntries(Object.entries(polygonsByCode).map(([code, polygons]) => [code, encodePolygons(polygons)]));
  const other = encodePolygons(nearOtherLand);
  return {
    source: `${SOURCE_PATH} (Natural Earth 1:50m admin-0)`,
    generator: 'scripts/generate-cii-country-borders.mjs',
    attributedTerritories: ATTRIBUTED_TERRITORIES,
    toleranceDeg: SIMPLIFY_TOLERANCE_DEG,
    otherLandToleranceDeg: OTHER_LAND_TOLERANCE_DEG,
    transform: topology.transform,
    countries,
    otherLand: other,
    arcs,
  };
}

export function renderCiiCountryBorders(document) {
  // One arc per line keeps diffs reviewable without inflating the file.
  const { arcs, ...head } = document;
  const headJson = JSON.stringify(head);
  return '// Generated by scripts/generate-cii-country-borders.mjs from public/data/countries-50m.json. Do not edit.\n'
    + `export default ${headJson.slice(0, -1)},"arcs":[\n${arcs.map((arc) => JSON.stringify(arc)).join(',\n')}\n]};\n`;
}

export function generateCiiCountryBorders({ check = false } = {}) {
  const topology = JSON.parse(readFileSync(resolve(ROOT, SOURCE_PATH), 'utf8'));
  const expected = renderCiiCountryBorders(buildCiiCountryBorders(topology));
  const outputPath = resolve(ROOT, CII_COUNTRY_BORDERS_PATH);
  let actual = null;
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch { /* missing output is stale */ }
  const stale = actual !== expected;
  if (stale && !check) writeFileSync(outputPath, expected);
  return { stale, bytes: Buffer.byteLength(expected) };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const check = process.argv.includes('--check');
  const { stale, bytes } = generateCiiCountryBorders({ check });
  if (check && stale) {
    console.error(`${CII_COUNTRY_BORDERS_PATH} is stale; run node scripts/generate-cii-country-borders.mjs`);
    process.exit(1);
  }
  console.log(`${CII_COUNTRY_BORDERS_PATH} ${check ? 'current' : 'written'} (${bytes} bytes)`);
}
