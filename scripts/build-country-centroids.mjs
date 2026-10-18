#!/usr/bin/env node
// Regenerates scripts/data/country-centroids.json from public/data/countries.geojson.
//
// Seeders that only know a country use its centroid as the item's position.
// Each point is the area centroid of the country's main polygon (mainland,
// not overseas islands), moved to the nearest interior grid point when the
// centroid falls outside a concave shape.
//
// Usage: node scripts/build-country-centroids.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../public/data/countries.geojson', import.meta.url);
const FIFTY_M = new URL('../public/data/countries-50m.json', import.meta.url);
const TARGET =new URL('./data/country-centroids.json', import.meta.url);

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function ringCentroid(ring) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f;
  }
  if (a === 0) return ring[0];
  return [x / (3 * a), y / (3 * a)];
}

function inRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(point, polygon) {
  return inRing(point, polygon[0]) && !polygon.slice(1).some((hole) => inRing(point, hole));
}

function interiorPoint(polygon) {
  const c = ringCentroid(polygon[0]);
  if (inPolygon(c, polygon)) return c;
  const xs = polygon[0].map((p) => p[0]), ys = polygon[0].map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = null, bestD = Infinity;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    for (let k = 0; k <= steps; k++) {
      const p = [minX + ((maxX - minX) * i) / steps, minY + ((maxY - minY) * k) / steps];
      if (!inPolygon(p, polygon)) continue;
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best ?? c;
}

// Countries whose largest landmass is not where the capital is: use the
// polygon containing the capital ([lon, lat]) instead.
const CAPITAL_LANDMASS = {
  MY: [101.69, 3.14], // Kuala Lumpur, not Borneo
  NZ: [174.78, -41.29], // Wellington, not the South Island
};

export function mainPolygon(geometry, code) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const capital = CAPITAL_LANDMASS[code];
  const withCapital = capital && polygons.find((p) => inPolygon(capital, p));
  if (withCapital) return withCapital;
  return polygons.reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
}

// countries.geojson has no shape for ~80 small states and territories; the
// Natural Earth 50m topology does, under its abbreviated names.
const FIFTY_M_NAMES = {
  FM: 'Micronesia', MH: 'Marshall Is.', MP: 'N. Mariana Is.', VI: 'U.S. Virgin Is.',
  GS: 'S. Geo. and the Is.', IO: 'Br. Indian Ocean Ter.', PN: 'Pitcairn Is.', FK: 'Falkland Is.',
  KY: 'Cayman Is.', VG: 'British Virgin Is.', TC: 'Turks and Caicos Is.', SB: 'Solomon Is.',
  VC: 'St. Vin. and Gren.', KN: 'St. Kitts and Nevis', CK: 'Cook Is.', PM: 'St. Pierre and Miquelon',
  WF: 'Wallis and Futuna Is.', MF: 'St-Martin', BL: 'St-Barthélemy', PF: 'Fr. Polynesia',
  TF: 'Fr. S. Antarctic Lands', AX: 'Åland', FO: 'Faeroe Is.', MO: 'Macao', HK: 'Hong Kong',
  BS: 'Bahamas', HM: 'Heard I. and McDonald Is.', AG: 'Antigua and Barb.',
};

// Territories neither source draws: island groups too small for 1:50m.
const MANUAL = {
  GI: [36.14, -5.35], TV: [-8.52, 179.2], UM: [19.28, 166.65],
};

// Two decimals (~1 km) unless rounding pushes the point out of a small or
// narrow country; then keep as many decimals as it takes to stay inside.
function roundInside(point, polygon) {
  for (let digits = 2; digits <= 6; digits++) {
    const f = 10 ** digits;
    const rounded = [Math.round(point[0] * f) / f, Math.round(point[1] * f) / f];
    if (inPolygon(rounded, polygon)) return [rounded[1], rounded[0]];
  }
  return [point[1], point[0]];
}

// code -> the polygon its centroid is taken from; null for MANUAL entries.
export function countryPolygons(geojson, fiftyM) {
  const out = new Map();
  const missing = [];
  for (const f of geojson.features) {
    const code = f.properties?.['ISO3166-1-Alpha-2'];
    if (!/^[A-Z]{2}$/.test(code ?? '') || out.has(code)) continue;
    if (f.geometry) out.set(code, mainPolygon(f.geometry, code));
    else missing.push({ code, name: f.properties.name });
  }
  const byName = new Map(fiftyM.features.filter((f) => f.geometry).map((f) => [f.properties.name, f.geometry]));
  for (const { code, name } of missing) {
    const geometry = byName.get(FIFTY_M_NAMES[code] ?? name);
    if (geometry) out.set(code, mainPolygon(geometry, code));
    else if (MANUAL[code]) out.set(code, null);
    else throw new Error(`no geometry for ${code} (${name}) — add it to FIFTY_M_NAMES or MANUAL`);
  }
  return out;
}

export function buildCentroids(geojson, fiftyM) {
  const out = {};
  for (const [code, polygon] of countryPolygons(geojson, fiftyM)) {
    out[code] = polygon ? roundInside(interiorPoint(polygon), polygon) : MANUAL[code];
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function loadSources() {
  const { feature } = await import('topojson-client');
  const topo = JSON.parse(readFileSync(FIFTY_M, 'utf8'));
  return [JSON.parse(readFileSync(SOURCE, 'utf8')), feature(topo, Object.values(topo.objects)[0])];
}

let polygonsCache = null;
/** The polygon a committed centroid must lie in; null when it is a MANUAL entry. */
export async function mainPolygonFor(code) {
  polygonsCache ??= countryPolygons(...(await loadSources()));
  return polygonsCache.get(code) ?? null;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const next = `${JSON.stringify(buildCentroids(...(await loadSources())))}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(TARGET, 'utf8') !== next) {
      console.error('scripts/data/country-centroids.json is stale — run: node scripts/build-country-centroids.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(TARGET, next);
    console.log(`wrote ${Object.keys(JSON.parse(next)).length} centroids`);
  }
}
