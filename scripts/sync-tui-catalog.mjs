#!/usr/bin/env node
// Generates cli/src/tui/data/catalog.generated.json: the data the terminal
// dashboard needs that lives in browser-only TypeScript config or in public/
// (live news channels, webcams, and a braille-ready world land bitmap).
//
//   npm run sync:tui-catalog            # rewrite the file
//   npm run sync:tui-catalog:check      # exit 1 when the file is stale
//
// cli/ must not import src/, so the catalog is snapshotted rather than imported.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/main-module.mjs';
import {
  LIVE_NEWS_SOURCES,
  WEBCAM_GRID_PRIORITY,
  WEBCAM_SOURCES,
} from '../src/config/live-video-sources.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(root, 'cli/src/tui/data/catalog.generated.json');
const CHANNELS_TS = resolve(root, 'src/services/live-channels.ts');
const WEBCAMS_TS = resolve(root, 'src/components/LiveWebcamsPanel.ts');
const TOPO_JSON = resolve(root, 'public/data/countries-110m.json');

// Map raster: equirectangular, 2 dots per column and 4 per row of braille.
export const MAP = { width: 480, height: 200, lonMin: -180, lonMax: 180, latMin: -58, latMax: 84 };

const REGION_LABELS = {
  na: 'North America',
  eu: 'Europe',
  latam: 'Latin America',
  asia: 'Asia',
  me: 'Middle East',
  africa: 'Africa',
  oc: 'Oceania',
};

// live-channels.ts imports browser-only modules, so its literal tables are read
// textually. The entries are flat object literals with string / string[] fields.
function parseObjectLiterals(block) {
  const out = [];
  const re = /\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(block))) {
    const body = m[1];
    const obj = {};
    const fieldRe = /(\w+):\s*(?:'((?:[^'\\]|\\.)*)'|\[([^\]]*)\])/g;
    let f;
    while ((f = fieldRe.exec(body))) {
      if (f[2] !== undefined) obj[f[1]] = f[2];
      else obj[f[1]] = [...f[3].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
    }
    if (obj.id) out.push(obj);
  }
  return out;
}

function sliceArray(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  // Skip the type annotation (`: Foo[] = [`): the array literal follows `=`.
  const eq = source.indexOf('=', start);
  const open = source.indexOf('[', eq);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated array after ${marker}`);
}

export function buildChannels(channelsSource) {
  const optional = parseObjectLiterals(sliceArray(channelsSource, 'export const OPTIONAL_LIVE_CHANNELS'));
  const defaults = parseObjectLiterals(sliceArray(channelsSource, 'const FULL_LIVE_CHANNELS'));
  const regionBlock = sliceArray(channelsSource, 'const _REGION_ENTRIES');
  const regions = [];
  const regionRe = /key:\s*'(\w+)'[^\]]*channelIds:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = regionRe.exec(regionBlock))) {
    regions.push({
      key: m[1],
      label: REGION_LABELS[m[1]] || m[1],
      channelIds: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    });
  }
  const regionOf = new Map();
  for (const r of regions) for (const id of r.channelIds) regionOf.set(id, r.key);
  const seen = new Set();
  const channels = [];
  for (const entry of optional) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const sources = LIVE_NEWS_SOURCES[entry.id] || [];
    channels.push({
      id: entry.id,
      name: entry.name,
      handle: entry.handle || null,
      region: regionOf.get(entry.id) || 'other',
      geo: entry.geoAvailability || null,
      sources: [...sources],
    });
  }
  return { channels, regions, defaultChannelIds: defaults.map((d) => d.id) };
}

export function buildWebcams(webcamsSource) {
  const feeds = parseObjectLiterals(sliceArray(webcamsSource, 'const WEBCAM_FEEDS'));
  return {
    webcams: feeds.map((f) => ({
      id: f.id,
      city: f.city,
      country: f.country,
      region: f.region,
      sources: [...(WEBCAM_SOURCES[f.id] || [])],
    })),
    gridPriority: [...WEBCAM_GRID_PRIORITY],
  };
}

// --- TopoJSON → land bitmap -------------------------------------------------

function decodeArcs(topo) {
  const { scale, translate } = topo.transform;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

function ringCoords(ring, arcs) {
  const pts = [];
  for (const index of ring) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    for (let i = pts.length ? 1 : 0; i < arc.length; i++) pts.push(arc[i]);
  }
  return pts;
}

export function rasterizeLand(topo, map = MAP) {
  const arcs = decodeArcs(topo);
  const rings = [];
  for (const geom of topo.objects.countries.geometries) {
    if (!geom || !geom.arcs) continue;
    const polys = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs;
    for (const poly of polys) for (const ring of poly) rings.push(ringCoords(ring, arcs));
  }
  const { width, height, lonMin, lonMax, latMin, latMax } = map;
  const toX = (lon) => ((lon - lonMin) / (lonMax - lonMin)) * width;
  const toY = (lat) => ((latMax - lat) / (latMax - latMin)) * height;
  const edges = [];
  const pushEdge = (x0, y0, x1, y1) => {
    if (y0 === y1) return;
    edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
  };
  for (const ring of rings) {
    // Rings that cross the antimeridian are cut at the map edges. Each cut
    // leaves a junction on both edges; pairing the junctions per side with a
    // vertical edge closes the pieces so scanline parity stays correct.
    const junctions = { left: [], right: [] };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const x0 = toX(a[0]);
      const y0 = toY(a[1]);
      const x1 = toX(b[0]);
      const y1 = toY(b[1]);
      if (Math.abs(x1 - x0) > width / 2) {
        const leftFirst = x0 < x1;
        const span = width - Math.abs(x1 - x0);
        const t = span === 0 ? 0 : leftFirst ? x0 / span : (width - x0) / span;
        const ym = y0 + (y1 - y0) * t;
        pushEdge(x0, y0, leftFirst ? 0 : width, ym);
        pushEdge(leftFirst ? width : 0, ym, x1, y1);
        junctions.left.push(ym);
        junctions.right.push(ym);
        continue;
      }
      pushEdge(x0, y0, x1, y1);
    }
    for (const [side, ys] of Object.entries(junctions)) {
      if (ys.length === 0) continue;
      ys.sort((p, q) => p - q);
      if (ys.length % 2 === 1) ys.push(height);
      const x = side === 'left' ? 0 : width;
      for (let i = 0; i + 1 < ys.length; i += 2) pushEdge(x, ys[i], x, ys[i + 1]);
    }
  }
  const rows = [];
  for (let py = 0; py < height; py++) {
    const y = py + 0.5;
    const xs = [];
    for (const [x0, y0, x1, y1] of edges) {
      if (y < y0 || y >= y1) continue;
      xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    const row = new Uint8Array(width);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = from; x <= to; x++) row[x] = 1;
    }
    rows.push(row);
  }
  return rows;
}

export function packBitmap(rows) {
  const width = rows[0].length;
  const bytesPerRow = Math.ceil(width / 8);
  const buf = Buffer.alloc(bytesPerRow * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (row[x]) buf[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  });
  return buf.toString('base64');
}

export function buildCatalog({ channelsSource, webcamsSource, topo }) {
  const { channels, regions, defaultChannelIds } = buildChannels(channelsSource);
  const { webcams, gridPriority } = buildWebcams(webcamsSource);
  const bitmap = rasterizeLand(topo);
  return {
    generatedFrom: [
      'src/config/live-video-sources.ts',
      'src/services/live-channels.ts',
      'src/components/LiveWebcamsPanel.ts',
      'public/data/countries-110m.json',
    ],
    channels,
    regions,
    defaultChannelIds,
    webcams,
    webcamGridPriority: gridPriority,
    map: { ...MAP, bits: packBitmap(bitmap) },
  };
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const catalog = buildCatalog({
    channelsSource: readFileSync(CHANNELS_TS, 'utf8'),
    webcamsSource: readFileSync(WEBCAMS_TS, 'utf8'),
    topo: JSON.parse(readFileSync(TOPO_JSON, 'utf8')),
  });
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  const rel = relative(root, OUTPUT);
  if (check) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      process.stderr.write(`${rel} is stale. Run: npm run sync:tui-catalog\n`);
      return 1;
    }
    process.stdout.write(`${rel} is up to date (${catalog.channels.length} channels, ${catalog.webcams.length} webcams)\n`);
    return 0;
  }
  writeFileSync(OUTPUT, next);
  process.stdout.write(`wrote ${rel} (${catalog.channels.length} channels, ${catalog.webcams.length} webcams)\n`);
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
