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
import {
  CRITICAL_MINERALS,
  ECONOMIC_CENTERS,
  NUCLEAR_FACILITIES,
  SANCTIONED_COUNTRIES_ALPHA2,
  SPACEPORTS,
  UNDERSEA_CABLES,
} from '../src/config/geo-map.ts';
import { CONFLICT_ZONES, INTEL_HOTSPOTS, STRATEGIC_WATERWAYS } from '../src/config/geo.ts';
import { MONITORED_AIRPORTS } from '../src/config/airports.ts';
import { PORTS } from '../src/config/ports.ts';
import { MILITARY_BASES } from '../src/config/military-bases.ts';
import { PIPELINES } from '../shared/pipelines-data.ts';
import { AI_DATA_CENTERS } from '../src/config/ai-datacenters.ts';
import { GAMMA_IRRADIATORS } from '../src/config/irradiators.ts';
import { resolveTradeRouteSegments } from '../src/config/trade-routes.ts';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';
import { CENTRAL_BANKS, COMMODITY_HUBS, FINANCIAL_CENTERS, STOCK_EXCHANGES } from '../src/config/finance-geo.ts';
import { ACCELERATORS, CLOUD_REGIONS, STARTUP_HUBS, TECH_HQS } from '../src/config/tech-geo.ts';
import { COMMODITY_PORTS, MINING_SITES, PROCESSING_PLANTS } from '../src/config/commodity-geo.ts';
import { GULF_INVESTMENTS } from '../src/config/gulf-fdi.ts';
import { AI_RESEARCH_LABS } from '../src/config/ai-research-labs.ts';
import { STARTUP_ECOSYSTEMS } from '../src/config/startup-ecosystems.ts';
import { TECH_COMPANIES } from '../src/config/tech-companies.ts';
import { COMMODITY_MINERS } from '../src/config/commodity-miners.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(root, 'cli/src/tui/data/catalog.generated.json');
const CHANNELS_TS = resolve(root, 'src/services/live-channels.ts');
const WEBCAMS_TS = resolve(root, 'src/components/LiveWebcamsPanel.ts');
const TOPO_JSON = resolve(root, 'public/data/countries-110m.json');
const TOPO_50M_JSON = resolve(root, 'public/data/countries-50m.json');
const UN_TO_ISO2 = resolve(root, 'shared/un-to-iso2.json');

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

// --- static map layers --------------------------------------------------------
//
// Every curated geo registry the web map draws, reduced to the fields the
// terminal needs: a position (or polyline / polygon), a name and the facts the
// hover card shows. Live layers (quakes, flights, vessels, alerts…) come from
// the API at runtime; see cli/src/tui/map/layers.mjs.

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);
const pt = (lon, lat) => [r2(lon), r2(lat)];
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));

export function buildStaticLayers() {
  const cables = UNDERSEA_CABLES.map((c) => compact({
    id: c.id,
    name: c.name,
    points: c.points.map(([lon, lat]) => pt(lon, lat)),
    major: c.major || undefined,
    rfsYear: c.rfsYear,
    capacityTbps: c.capacityTbps,
    owners: c.owners,
    landings: (c.landingPoints || []).map((l) => compact({ city: l.city, country: l.countryName || l.country, lat: r2(l.lat), lon: r2(l.lon) })),
  }));
  const pipelines = PIPELINES.map((p) => compact({
    id: p.id,
    name: p.name,
    type: p.type,
    status: p.status,
    points: p.points.map(([lon, lat]) => pt(lon, lat)),
    capacity: p.capacity,
    length: p.length,
    operator: p.operator,
    countries: p.countries,
    origin: p.origin && compact({ name: p.origin.name, country: p.origin.country }),
    destination: p.destination && compact({ name: p.destination.name, country: p.destination.country }),
  }));
  const point = (e, extra) => compact({ id: e.id, name: e.name, lat: r2(e.lat), lon: r2(e.lon), ...extra });
  const registryById = new Map(CHOKEPOINT_REGISTRY.map((c) => [c.id, c]));
  return {
    cables,
    pipelines,
    nuclear: NUCLEAR_FACILITIES.map((e) => point(e, { type: e.type, status: e.status, operator: e.operator, since: e.operationalSince, iaea: e.iaeaStatus })),
    irradiators: GAMMA_IRRADIATORS.map((e) => compact({ id: e.id, name: e.organization || `${e.city} irradiator`, lat: r2(e.lat), lon: r2(e.lon), city: e.city, country: e.country })),
    spaceports: SPACEPORTS.map((e) => point(e, { country: e.country, operator: e.operator, status: e.status, launches: e.launches })),
    bases: MILITARY_BASES.map((e) => point(e, { type: e.type, country: e.country, arm: e.arm, status: e.status, description: e.description })),
    ports: PORTS.map((e) => point(e, { country: e.country, type: e.type, rank: e.rank, note: e.note })),
    airports: MONITORED_AIRPORTS.map((e) => compact({ id: e.iata, name: e.name, lat: r2(e.lat), lon: r2(e.lon), iata: e.iata, icao: e.icao, city: e.city, country: e.country, region: e.region })),
    datacenters: AI_DATA_CENTERS.map((e) => point(e, { owner: e.owner, country: e.country, status: e.status, chipType: e.chipType, chipCount: e.chipCount, powerMW: e.powerMW })),
    hotspots: INTEL_HOTSPOTS.map((e) => point(e, { subtext: e.subtext, location: e.location, level: e.level, description: e.description, agencies: e.agencies })),
    conflictZones: CONFLICT_ZONES.map((z) => compact({
      id: z.id,
      name: z.name,
      coords: z.coords.map(([lon, lat]) => pt(lon, lat)),
      lon: r2(z.center[0]),
      lat: r2(z.center[1]),
      intensity: z.intensity,
      parties: z.parties,
      casualties: z.casualties,
      displaced: z.displaced,
      startDate: z.startDate,
      description: z.description,
    })),
    waterways: STRATEGIC_WATERWAYS.map((w) => {
      const reg = registryById.get(w.chokepointId) || {};
      return point(w, { description: w.description, routes: reg.routeIds, shockModel: reg.shockModelSupported || undefined });
    }),
    tradeRoutes: resolveTradeRouteSegments().map((seg) => compact({
      id: `${seg.routeId}:${seg.segmentIndex}`,
      routeId: seg.routeId,
      name: seg.routeName,
      category: seg.category,
      status: seg.status,
      volume: seg.volumeDesc,
      points: [pt(seg.sourcePosition[0], seg.sourcePosition[1]), pt(seg.targetPosition[0], seg.targetPosition[1])],
      segment: `${seg.segmentIndex + 1}/${seg.totalSegments}`,
    })),
    economicCenters: ECONOMIC_CENTERS.map((e) => point(e, { type: e.type, country: e.country, description: e.description, hours: e.marketHours && `${e.marketHours.open}-${e.marketHours.close} ${e.marketHours.timezone}` })),
    stockExchanges: STOCK_EXCHANGES.map((e) => point(e, { shortName: e.shortName, city: e.city, country: e.country, tier: e.tier, marketCapT: e.marketCap, hours: e.tradingHours, description: e.description })),
    financialCenters: FINANCIAL_CENTERS.map((e) => point(e, { country: e.country, type: e.type, gfciRank: e.gfciRank, specialties: e.specialties, description: e.description })),
    centralBanks: CENTRAL_BANKS.map((e) => point(e, { shortName: e.shortName, city: e.city, country: e.country, currency: e.currency, description: e.description })),
    commodityHubs: COMMODITY_HUBS.map((e) => point(e, { city: e.city, country: e.country, type: e.type, commodities: e.commodities, description: e.description })),
    startupHubs: STARTUP_HUBS.map((e) => point(e, { city: e.city, country: e.country, tier: e.tier, unicorns: e.unicorns })),
    accelerators: ACCELERATORS.map((e) => point(e, { city: e.city, country: e.country, type: e.type, founded: e.founded, notable: e.notable })),
    techHQs: TECH_HQS.map((e) => compact({ id: e.id, name: e.company, lat: r2(e.lat), lon: r2(e.lon), city: e.city, country: e.country, type: e.type, marketCap: e.marketCap })),
    cloudRegions: CLOUD_REGIONS.map((e) => point(e, { provider: e.provider, city: e.city, country: e.country, zones: e.zones })),
    aiLabs: AI_RESEARCH_LABS.map((e) => point(e, { type: e.type, city: e.city, country: e.country, founded: e.foundedYear, focus: e.focusAreas })),
    techCompanies: TECH_COMPANIES.map((e) => point(e, { sector: e.sector, office: e.officeType, city: e.city, country: e.country, employees: e.employees, founded: e.foundedYear, products: e.keyProducts })),
    startupEcosystems: STARTUP_ECOSYSTEMS.map((e) => point(e, { city: e.city, country: e.country, tier: e.ecosystemTier, startups: e.activeStartups, unicorns: e.unicorns, sectors: e.topSectors })),
    miningSites: MINING_SITES.map((e) => point(e, { mineral: e.mineral, country: e.country, operator: e.operator, status: e.status, significance: e.significance })),
    processingPlants: PROCESSING_PLANTS.map((e) => point(e, { type: e.type, mineral: e.mineral, country: e.country, operator: e.operator, status: e.status, significance: e.significance })),
    commodityPorts: COMMODITY_PORTS.map((e) => point(e, { city: e.city, country: e.country, commodities: e.commodities, throughput: e.annualThroughput, significance: e.significance })),
    criticalMinerals: CRITICAL_MINERALS.map((e) => point(e, { mineral: e.mineral, country: e.country, operator: e.operator, status: e.status, significance: e.significance })),
    commodityMiners: COMMODITY_MINERS.map((e) => point(e, { country: e.country, city: e.city, siteType: e.siteType, sector: e.sector, minerals: e.mineralTypes, status: e.status, symbol: e.stockSymbol })),
    // investmentUSD is in USD millions; the map formats whole dollars.
    gulfInvestments: GULF_INVESTMENTS.map((e) => compact({ id: e.id, name: e.assetName, lat: r2(e.lat), lon: r2(e.lon), investor: e.investingEntity, from: e.investingCountry, country: e.targetCountry, sector: e.sector, assetType: e.assetType, usd: e.investmentUSD == null ? undefined : e.investmentUSD * 1e6, year: e.yearAnnounced, status: e.status })),
    sanctions: SANCTIONED_COUNTRIES_ALPHA2,
  };
}

// --- TopoJSON (50m) → compact arc stream --------------------------------------
//
// Arcs stay in TopoJSON's quantized delta form, packed as zigzag varints so the
// zoomable map can rasterize coastlines and borders at any scale.

function zigzag(n) {
  return n < 0 ? -2 * n - 1 : 2 * n;
}

export function packArcs(arcs) {
  const bytes = [];
  const pushVarint = (n) => {
    let v = n >>> 0;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
  };
  pushVarint(arcs.length);
  for (const arc of arcs) {
    pushVarint(arc.length);
    for (const [dx, dy] of arc) {
      pushVarint(zigzag(dx));
      pushVarint(zigzag(dy));
    }
  }
  return Buffer.from(bytes).toString('base64');
}

export function buildWorld(topo, unToIso2) {
  const countries = [];
  for (const geom of topo.objects.countries.geometries) {
    if (!geom || !geom.arcs) continue;
    const polys = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs;
    const id = geom.id === undefined ? null : String(geom.id);
    countries.push(compact({ id, a2: id ? unToIso2[id] : undefined, name: geom.properties?.name, polys }));
  }
  return {
    scale: topo.transform.scale,
    translate: topo.transform.translate,
    arcs: packArcs(topo.arcs),
    countries,
  };
}

export function buildCatalog({ channelsSource, webcamsSource, topo, topo50m, unToIso2 }) {
  const { channels, regions, defaultChannelIds } = buildChannels(channelsSource);
  const { webcams, gridPriority } = buildWebcams(webcamsSource);
  const bitmap = rasterizeLand(topo);
  return {
    generatedFrom: [
      'src/config/live-video-sources.ts',
      'src/services/live-channels.ts',
      'src/components/LiveWebcamsPanel.ts',
      'src/config/geo-map.ts, geo.ts, airports.ts, ports.ts, military-bases.ts, ai-datacenters.ts, irradiators.ts, trade-routes.ts, chokepoint-registry.ts, finance-geo.ts, tech-geo.ts, commodity-geo.ts, gulf-fdi.ts, ai-research-labs.ts, startup-ecosystems.ts, tech-companies.ts, commodity-miners.ts',
      'shared/pipelines-data.ts',
      'shared/un-to-iso2.json',
      'public/data/countries-110m.json',
      'public/data/countries-50m.json',
    ],
    channels,
    regions,
    defaultChannelIds,
    webcams,
    webcamGridPriority: gridPriority,
    map: { ...MAP, bits: packBitmap(bitmap) },
    layers: topo50m ? buildStaticLayers() : undefined,
    world: topo50m ? buildWorld(topo50m, unToIso2 || {}) : undefined,
  };
}

// Static layers and world geometry are large: they stay on one line each so
// the rest of the file remains readable and diffs stay small.
export function serializeCatalog(catalog) {
  const { layers, world, ...rest } = catalog;
  const head = JSON.stringify(rest, null, 2);
  if (layers === undefined && world === undefined) return `${head}\n`;
  return `${head.slice(0, -2)},\n  "layers": ${JSON.stringify(layers)},\n  "world": ${JSON.stringify(world)}\n}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const catalog = buildCatalog({
    channelsSource: readFileSync(CHANNELS_TS, 'utf8'),
    webcamsSource: readFileSync(WEBCAMS_TS, 'utf8'),
    topo: JSON.parse(readFileSync(TOPO_JSON, 'utf8')),
    topo50m: JSON.parse(readFileSync(TOPO_50M_JSON, 'utf8')),
    unToIso2: JSON.parse(readFileSync(UN_TO_ISO2, 'utf8')),
  });
  const next = serializeCatalog(catalog);
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
