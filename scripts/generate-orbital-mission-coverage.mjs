#!/usr/bin/env node
// Generates the per-mission acquisition-coverage grids: where Sentinel-2 and
// Sentinel-1 actually acquire, as opposed to where land and coasts are.
//
// Source: every Earth Search footprint for one full repeat cycle of each
// mission (Sentinel-2 L2A over 10 days, Sentinel-1 GRD over 12 days). A
// 0.25-degree cell is covered when its centre lies inside a footprint or a
// footprint vertex falls in it. Sentinel-1 follows a fixed acquisition plan
// that often images a place from one orbit direction only, so its grid is kept
// per direction; Sentinel-2 acquires the same areas on both. Polar ice is only
// imaged in its own summer, so the grid is the union of cycles ending on each
// --end date (one per solstice season).
//
// Rows use the run-length encoding of land-coast-mask.data.js. The source is a
// live archive, so the grid cannot be re-derived offline; the window and item
// counts are recorded in the module so a rerun is comparable.
//
// Usage: node scripts/generate-orbital-mission-coverage.mjs --end 2026-06-25 --end 2026-11-13

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COVERAGE_PATHS = ['shared/orbital/mission-coverage.data.js', 'scripts/shared/orbital/mission-coverage.data.js'];
const SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
const USER_AGENT = 'WorldMonitor orbital coverage generator (+https://www.worldmonitor.app)';
export const CELL_DEG = 0.25;
const WIDTH = Math.round(360 / CELL_DEG);
const HEIGHT = Math.round(180 / CELL_DEG);
const DAY_MS = 86_400_000;
const PAGE_LIMIT = 1000;

export const MISSIONS = [
  { coverage: 'sentinel-2', collection: 'sentinel-2-l2a', repeatDays: 10, byDirection: false },
  { coverage: 'sentinel-1', collection: 'sentinel-1-grd', repeatDays: 12, byDirection: true },
];

// Longitudes made continuous so a footprint across the antimeridian fills the short way round.
function unwrap(ring) {
  const points = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [lon, lat] = ring[i];
    const previousLon = points[i - 1][0];
    points.push([lon + 360 * Math.round((previousLon - lon) / 360), lat]);
  }
  return points;
}

export function rasterizeFootprint(grid, geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const mark = (row, col) => {
    if (row >= 0 && row < HEIGHT) grid[row * WIDTH + (((col % WIDTH) + WIDTH) % WIDTH)] = 1;
  };
  for (const polygon of polygons) {
    const rings = polygon.map(unwrap);
    const lats = rings.flat().map(([, lat]) => lat);
    for (const ring of rings) for (const [lon, lat] of ring) mark(Math.floor((90 - lat) / CELL_DEG), Math.floor((lon + 180) / CELL_DEG));
    const top = Math.max(0, Math.floor((90 - Math.max(...lats)) / CELL_DEG));
    const bottom = Math.min(HEIGHT - 1, Math.floor((90 - Math.min(...lats)) / CELL_DEG));
    for (let row = top; row <= bottom; row++) {
      const lat = 90 - (row + 0.5) * CELL_DEG;
      const crossings = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[i + 1];
          if ((y1 > lat) !== (y2 > lat)) crossings.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        for (let col = Math.ceil((crossings[i] + 180) / CELL_DEG - 0.5); (col + 0.5) * CELL_DEG - 180 <= crossings[i + 1]; col++) mark(row, col);
      }
    }
  }
}

export function encodeGrid(grid) {
  const rows = [];
  for (let row = 0; row < HEIGHT; row++) {
    const runs = [];
    let value = 0;
    let length = 0;
    for (let col = 0; col < WIDTH; col++) {
      const cell = grid[row * WIDTH + col];
      if (cell === value) {
        length++;
      } else {
        runs.push(length);
        value = cell;
        length = 1;
      }
    }
    runs.push(length);
    rows.push(runs.map((n) => n.toString(36)).join('.'));
  }
  return rows;
}

async function postSearch(body, attempt = 0) {
  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => ({ ok: false, status: String(error) }));
  if (response.ok) return response.json();
  if (attempt >= 4) throw new Error(`Earth Search ${response.status}`);
  await new Promise((done) => setTimeout(done, 2000 * 2 ** attempt));
  return postSearch(body, attempt + 1);
}

// One day per query keeps every result set well inside the archive's paging limits.
async function* footprints(collection, startMs, days) {
  for (let day = 0; day < days; day++) {
    const from = new Date(startMs + day * DAY_MS).toISOString();
    const to = new Date(startMs + (day + 1) * DAY_MS).toISOString();
    let body = {
      collections: [collection],
      datetime: `${from}/${to}`,
      limit: PAGE_LIMIT,
      fields: { include: ['id', 'geometry', 'properties.sat:orbit_state'], exclude: ['assets', 'links', 'bbox'] },
    };
    while (body) {
      const page = await postSearch(body);
      for (const feature of page.features ?? []) yield feature;
      const next = (page.links ?? []).find((link) => link.rel === 'next');
      body = next?.body ? { ...body, ...next.body } : null;
    }
  }
}

async function buildMission(mission, endDates) {
  const keys = mission.byDirection ? ['ascending', 'descending'] : ['all'];
  const grids = Object.fromEntries(keys.map((key) => [key, new Uint8Array(WIDTH * HEIGHT)]));
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  const windows = [];
  for (const endMs of endDates) {
    const startMs = endMs - mission.repeatDays * DAY_MS;
    windows.push(`${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`);
    for await (const feature of footprints(mission.collection, startMs, mission.repeatDays)) {
      const key = mission.byDirection ? feature.properties?.['sat:orbit_state'] : 'all';
      if (!grids[key]) continue;
      rasterizeFootprint(grids[key], feature.geometry);
      counts[key]++;
    }
  }
  console.log(`${mission.collection}: ${JSON.stringify(counts)}`);
  return {
    collection: mission.collection,
    windows,
    items: counts,
    grids: Object.fromEntries(keys.map((key) => [key, encodeGrid(grids[key])])),
  };
}

export function renderCoverageModule(missions) {
  const data = { source: SEARCH_URL, generator: 'scripts/generate-orbital-mission-coverage.mjs', cellDeg: CELL_DEG, missions };
  return `// Generated by scripts/generate-orbital-mission-coverage.mjs from Earth Search footprints. Do not edit.\nexport default ${JSON.stringify(data)};\n`;
}

async function main() {
  const ends = process.argv.flatMap((arg, i) => (process.argv[i - 1] === '--end' ? [Date.parse(`${arg}T00:00:00Z`)] : []));
  if (!ends.length || ends.some((ms) => !Number.isFinite(ms))) throw new Error('Pass one or more --end YYYY-MM-DD dates');
  const missions = {};
  for (const mission of MISSIONS) missions[mission.coverage] = await buildMission(mission, ends);
  const rendered = renderCoverageModule(missions);
  for (const path of COVERAGE_PATHS) writeFileSync(resolve(ROOT, path), rendered);
  console.log(`Wrote ${COVERAGE_PATHS.join(', ')} (${rendered.length} bytes each)`);
}

if (isMainModule(import.meta.url, process.argv[1])) await main();
