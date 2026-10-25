// Map engine and map/brief view tests: projections, world geometry, PNG
// decoding, imagery cache, orbit propagation, layer features, hover picking,
// pinning, search, satellite compositing, detail overlay and the brief view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { App } from '../src/tui/app.mjs';
import { createClient } from '../src/tui/data/client.mjs';
import { Store } from '../src/tui/data/store.mjs';
import { loadCatalog } from '../src/tui/index.mjs';
import { createViews } from '../src/tui/views/index.mjs';
import { DotCanvas } from '../src/tui/map/canvas.mjs';
import { charWidth } from '../src/tui/term/ansi.mjs';
import { dayFactor, defaultView, makeProjector, normalizeView, panBy, subsolarPoint, wrapLon, zoomAt } from '../src/tui/map/geo.mjs';
import { ImageryCache, gibsUrl, latestDailyDate } from '../src/tui/map/imagery.mjs';
import { LAYERS, buildFeatures, defaultLayerState, layerSources } from '../src/tui/map/layers.mjs';
import { groundTrack, parseTle, propagate } from '../src/tui/map/orbit.mjs';
import { decodePng, samplePixel } from '../src/tui/map/png.mjs';
import { countryCentroidByA2, decodeWorld, renderWorld, worldMask } from '../src/tui/map/world.mjs';
import { describeItem } from '../src/tui/ui/detail.mjs';
import { getTheme } from '../src/tui/ui/theme.mjs';
import { citations, relatedFor, tokens } from '../src/tui/views/brief.mjs';

const bootstrap = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url), 'utf8'));
const digest = JSON.parse(readFileSync(new URL('./fixtures/digest.json', import.meta.url), 'utf8'));
const png = readFileSync(new URL('./fixtures/gibs-bluemarble-32x16.png', import.meta.url));
const catalog = loadCatalog();
const world = decodeWorld(catalog.world);
const theme = getTheme('neon');

const pngResponse = () => ({ ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) });

function makeApp({ cols = 170, rows = 48, anim = true, fetchImpl = async () => pngResponse() } = {}) {
  const clock = { t: 1_792_300_000_000 };
  const store = new Store(createClient({ fetch: async () => ({ ok: true, status: 200, text: async () => '{}', headers: new Map() }) }), { now: () => clock.t });
  Object.assign(store.data, bootstrap.data);
  store.raw.digest = digest;
  store.raw.flights = {
    flights: [{ id: 'adsb-1', callsign: 'RCH123', aircraftType: 'MILITARY_AIRCRAFT_TYPE_TRANSPORT', operator: 'MILITARY_OPERATOR_USAF', operatorCountry: 'USA', location: { latitude: 48.5, longitude: 8.0 }, altitude: 31000, heading: 90, speed: 420, lastSeenAt: clock.t - 60000, onGround: false }],
  };
  store.raw.satellites = { satellites: [{ id: '25544', name: 'TESTSAT', country: 'US', type: 'optical', line1: '1 25544U 98067A   26291.50000000  .00016717  00000-0  10270-3 0  9005', line2: '2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560000500000' }] };
  const saved = [];
  const app = new App({
    store,
    catalog,
    prefs: { theme: 'neon', animations: anim, view: 'map' },
    savePrefs: (p) => saved.push(JSON.parse(JSON.stringify(p))),
    out: () => {},
    cols,
    rows,
    createViews,
    now: () => clock.t,
    player: { mpv: null, ytdlp: null, vo: 'tct' },
    fetchImpl,
  });
  app.boot.done = true;
  app.view.mount();
  clock.t += 500;
  return { app, store, clock, saved, map: app.views.find((v) => v.id === 'map') };
}

const text = (app) => app.screen.toLines().join('\n');

// Terminals draw a wide character over two columns; the cell after it must be
// the screen's reserved tail ('\0') or the rest of the row drifts on screen.
function assertCellWidths(s, label = '') {
  for (let y = 0; y < s.rows; y++) {
    for (let x = 0; x < s.cols; x++) {
      const ch = s.ch[y * s.cols + x];
      const next = x + 1 < s.cols ? s.ch[y * s.cols + x + 1] : null;
      if (ch === '\u0000') assert.ok(x > 0 && charWidth(s.ch[y * s.cols + x - 1]) === 2, `${label} row ${y} col ${x}: tail without a wide head`);
      else if (charWidth(ch) === 2) assert.equal(next, '\u0000', `${label} row ${y} col ${x}: ${ch} has no reserved cell`);
    }
  }
}
const mouse = (app, kind, x, y, button = kind === 'move' ? 3 : 0) => app.handleEvent({ type: 'mouse', kind, x, y, button });

describe('geo projections', () => {
  it('wraps longitudes and round-trips the flat projection', () => {
    assert.equal(wrapLon(190), -170);
    assert.equal(wrapLon(-181), 179);
    const view = normalizeView({ ...defaultView(), lon: 10, lat: 20, zoom: 4 }, 340, 160);
    const p = makeProjector(view, 340, 160);
    const [x, y] = p.toDot(12.5, 21);
    const g = p.fromDot(x, y);
    assert.ok(Math.abs(g.lon - 12.5) < 0.05 && Math.abs(g.lat - 21) < 0.05);
  });
  it('round-trips the globe projection and hides the far side', () => {
    const p = makeProjector({ mode: 'globe', lon: 0, lat: 0, zoom: 1 }, 340, 160);
    const [x, y, vis] = p.toDot(20, 10);
    assert.ok(vis);
    const g = p.fromDot(x, y);
    assert.ok(Math.abs(g.lon - 20) < 0.1 && Math.abs(g.lat - 10) < 0.1);
    assert.equal(p.toDot(170, 0)[2], false);
    assert.equal(p.fromDot(0, 0), null);
  });
  it('zooms around an anchor and clamps panning at the poles', () => {
    const view = normalizeView({ ...defaultView(), zoom: 2 }, 340, 160);
    const p = makeProjector(view, 340, 160);
    const anchor = p.fromDot(100, 40);
    const zoomed = zoomAt(view, 340, 160, 2, 100, 40);
    const after = makeProjector(zoomed, 340, 160).fromDot(100, 40);
    assert.ok(Math.abs(after.lon - anchor.lon) < 0.2 && Math.abs(after.lat - anchor.lat) < 0.2);
    const far = panBy(view, 340, 160, 0, 100000);
    assert.ok(far.lat <= 90);
    assert.ok(normalizeView({ ...view, zoom: 10000 }, 340, 160).zoom <= 160);
  });
  it('computes a plausible subsolar point and day factor', () => {
    const sun = subsolarPoint(Date.UTC(2026, 5, 21, 12, 0, 0)); // June solstice, noon UTC
    assert.ok(sun.lat > 22 && sun.lat < 24.5, `declination ${sun.lat}`);
    assert.ok(Math.abs(sun.lon) < 5, `subsolar lon ${sun.lon}`);
    assert.equal(dayFactor(sun.lat, sun.lon, sun), 1);
    assert.equal(dayFactor(-sun.lat, wrapLon(sun.lon + 180), sun), 0);
  });
});

describe('world geometry', () => {
  it('decodes the packed arcs into countries with centroids', () => {
    assert.ok(world.arcs.length > 1500);
    assert.ok(world.countries.length > 200);
    const us = countryCentroidByA2(world, 'US');
    assert.ok(us && us.lat > 35 && us.lat < 45 && us.lon < -90 && us.lon > -110, JSON.stringify(us));
    const ru = countryCentroidByA2(world, 'RU');
    assert.ok(ru.lon > 60 && ru.lon < 120, 'Russia centroid stays on the mainland side of the antimeridian');
  });
  it('rasterizes land in both projections and the mask knows countries', () => {
    const mask = worldMask(world);
    assert.equal(world.countries[mask.get(2.3, 48.8) - 1].a2, 'FR');
    assert.equal(mask.get(-30, 30), 0); // Atlantic
    for (const mode of ['flat', 'globe']) {
      const c = new DotCanvas(100, 30);
      const p = makeProjector(normalizeView({ ...defaultView(), mode, zoom: 1 }, c.w, c.h), c.w, c.h);
      renderWorld(c, p, world, { fillColor: () => '#224466', coast: '#44aaff', border: '#224488', outline: '#fff' });
      const lit = c.code.reduce((a, v) => a + (v ? 1 : 0), 0);
      assert.ok(lit > 500, `${mode}: ${lit} cells drawn`);
    }
  });
  it('handles the antimeridian without streaks at high zoom', () => {
    const c = new DotCanvas(120, 30);
    const p = makeProjector(normalizeView({ ...defaultView(), lon: 179.5, lat: -17.5, zoom: 24 }, c.w, c.h), c.w, c.h);
    renderWorld(c, p, world, { fillColor: () => '#224466', coast: '#44aaff', border: '#224488' });
    // No row may be completely filled: that would be a wrap streak.
    for (let cy = 0; cy < c.rows; cy++) {
      let full = 0;
      for (let cx = 0; cx < c.cols; cx++) if (c.code[cy * c.cols + cx] === 0xff) full++;
      assert.ok(full < c.cols * 0.9, `row ${cy} is a streak`);
    }
  });
});

describe('png + imagery', () => {
  it('decodes the GIBS fixture tile', () => {
    const img = decodePng(png);
    assert.equal(img.width, 32);
    assert.equal(img.height, 16);
    const ocean = samplePixel(img, 0.45, 0.5);
    const sahara = samplePixel(img, 0.55, 0.38);
    assert.ok(ocean[2] > ocean[0], 'ocean is blue');
    assert.ok(sahara[0] > 150, 'the Sahara is bright');
  });
  it('builds WMS urls with lat/lon ordered boxes and caches by request', async () => {
    const url = gibsUrl({ layer: 'X', bbox: [-10, 20, 30, 40], width: 100, height: 50, time: '2026-01-02' });
    assert.match(url, /BBOX=20%2C-10%2C40%2C30/);
    assert.match(url, /TIME=2026-01-02/);
    assert.match(latestDailyDate(Date.UTC(2026, 9, 18, 12)), /^2026-10-1[67]$/);
    let calls = 0;
    const cache = new ImageryCache({ fetch: async () => { calls++; return pngResponse(); }, now: () => 1000 });
    const req = { layer: 'X', bbox: [-180, -90, 180, 90], width: 32, height: 16 };
    const e1 = cache.get(req);
    assert.equal(e1.status, 'loading');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cache.get(req).status, 'ready');
    assert.equal(cache.get(req).image.width, 32);
    assert.equal(calls, 1);
  });
  it('drops superseded requests and records errors', async () => {
    const cache = new ImageryCache({ fetch: async (u) => (u.includes('LAYERS=bad') ? { ok: false, status: 500 } : pngResponse()), now: () => 1000, concurrency: 1 });
    cache.get({ layer: 'a', bbox: [0, 0, 10, 10], width: 8, height: 8 });
    cache.get({ layer: 'b', bbox: [0, 0, 10, 10], width: 8, height: 8 });
    cache.get({ layer: 'c', bbox: [0, 0, 10, 10], width: 8, height: 8 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(cache.peek({ layer: 'b', bbox: [0, 0, 10, 10], width: 8, height: 8 }), null, 'b was superseded by c before it started');
    assert.equal(cache.peek({ layer: 'c', bbox: [0, 0, 10, 10], width: 8, height: 8 }).status, 'ready');
    const bad = cache.get({ layer: 'bad', bbox: [0, 0, 10, 10], width: 8, height: 8 }, 'other');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /HTTP 500/);
  });
});

describe('orbit', () => {
  it('parses a TLE and propagates to a low-earth-orbit altitude', () => {
    const tle = parseTle('1 25544U 98067A   26291.50000000  .00016717  00000-0  10270-3 0  9005', '2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560000500000');
    assert.ok(tle);
    const p = propagate(tle, tle.epoch + 3600e3);
    assert.ok(p.altKm > 350 && p.altKm < 500, `alt ${p.altKm}`);
    assert.ok(Math.abs(p.lat) <= 51.7);
    assert.ok(p.periodMin > 90 && p.periodMin < 95);
    const track = groundTrack(tle, tle.epoch, { ahead: 10, stepMin: 1 });
    assert.equal(track.length, 11);
    assert.equal(parseTle('bad', 'bad'), null);
  });
});

describe('layers', () => {
  const ctx = () => ({ catalog, data: bootstrap.data, raw: { flights: { flights: [] }, vessels: {}, satellites: { satellites: [] } }, t: theme, now: 1_792_300_000_000, world });
  it('builds features for every static and live layer in the fixtures', () => {
    const all = Object.fromEntries(LAYERS.map((l) => [l.id, true]));
    const { features, counts } = buildFeatures(ctx(), all);
    assert.ok(features.length > 1500, `features ${features.length}`);
    for (const id of ['cables', 'pipelines', 'nuclear', 'bases', 'ports', 'airports', 'datacenters', 'earthquakes', 'unrest', 'ucdp', 'weather', 'outages', 'cyber', 'hotspots', 'conflictZones', 'waterways', 'tradeRoutes', 'exchanges', 'mining', 'techHQs']) {
      assert.ok(counts[id] > 0, `${id} has features`);
    }
    for (const f of features) {
      assert.ok(Number.isFinite(f.lat) && Number.isFinite(f.lon), `${f.id} has a position`);
      assert.ok(f.name, `${f.id} has a name`);
      assert.ok(Array.isArray(f.info), `${f.id} has info rows`);
    }
    const cable = features.find((f) => f.layer === 'cables');
    assert.ok(cable.points.length > 2 && cable.from && cable.to);
    const suez = features.find((f) => f.id === 'cp:suez');
    assert.match(suez.info.find(([k]) => k === 'Status')[1], /yellow/);
  });
  it('reports lazy sources only for enabled layers', () => {
    const state = defaultLayerState();
    assert.ok(layerSources(state).includes('flights'));
    state.flights = false;
    state.satellites = false;
    assert.ok(!layerSources(state).includes('flights'));
    state.storage = true;
    assert.ok(layerSources(state).includes('storageFacilities'));
  });
});

describe('map view', () => {
  it('renders the map with a layer sidebar and toolbar', () => {
    const { app } = makeApp();
    app.render();
    const t = text(app);
    assert.match(t, /WORLD MAP · TACTICAL/);
    assert.match(t, /LAYERS/);
    assert.match(t, /Undersea cables/);
    assert.match(t, /SAT OFF/);
    assert.doesNotMatch(t, /view error/);
  });
  it('hovers features, pins on click and opens the detail overlay on Enter', () => {
    const { app, map } = makeApp();
    app.render();
    const r = map.mapRect;
    const cable = map.drawn.lines.find((l) => l.f.layer === 'cables');
    assert.ok(cable, 'a cable was drawn');
    const [x0, y0] = cable.segs[Math.floor(cable.segs.length / 2)];
    const cx = r.x + Math.floor(x0 / 2);
    const cy = r.y + Math.floor(y0 / 4);
    mouse(app, 'move', cx, cy);
    assert.equal(map.hovered && map.hovered.layer, 'cables');
    app.render();
    assert.match(text(app), new RegExp(map.hovered.name.slice(0, 10)));
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    assert.equal(map.pinned, map.hovered);
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(app.detail);
    app.render();
    const t = text(app);
    assert.match(t, /UNDERSEA CABLES/);
    assert.match(t, /From:/);
    assert.match(t, /Length: [\d,]+ km/);
    app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(app.detail, null);
    app.handleEvent({ type: 'key', name: 'c' });
    assert.equal(map.pinned, null);
  });
  it('identifies the country under the cursor when nothing else is there', () => {
    const { app, map } = makeApp();
    map.toggleLayer('cii', true);
    app.render();
    const p = map.proj;
    const [x, y] = p.toDot(123, -25); // Western Australian desert: no fixture features
    mouse(app, 'move', map.mapRect.x + Math.floor(x / 2), map.mapRect.y + Math.floor(y / 4));
    assert.ok(map.hovered);
    assert.equal(map.hovered.layer, 'country');
    assert.equal(map.hovered.name, 'Australia');
    assert.ok(map.hovered.info.some(([k, v]) => k === 'ISO' && v === 'AU'));
    const [rx, ry] = p.toDot(99, 62); // central Siberia (fixture fires live there, so ask the country lookup directly)
    const ru = map.countryAt(rx, ry);
    assert.equal(ru.name, 'Russia');
    assert.ok(ru.info.some(([k]) => k === 'CII score'), 'choropleth info is attached');
  });
  it('drags to pan, wheels to zoom and resets', () => {
    const { app, map } = makeApp();
    app.render();
    const r = map.mapRect;
    const before = { ...map.view };
    mouse(app, 'down', r.x + 40, r.y + 10);
    mouse(app, 'drag', r.x + 50, r.y + 10);
    mouse(app, 'up', r.x + 50, r.y + 10);
    assert.ok(map.view.lon < before.lon, 'dragging right moves the view west');
    mouse(app, 'wheelup', r.x + 40, r.y + 10, -1);
    assert.ok(map.view.zoom > before.zoom);
    app.handleEvent({ type: 'key', name: 'z', ch: 'z' });
    assert.equal(map.view.zoom, 1);
    app.handleEvent({ type: 'key', name: '+', ch: '+' });
    app.handleEvent({ type: 'key', name: '+', ch: '+' });
    assert.ok(map.view.zoom > 2);
    app.render();
    assert.ok(text(app).includes(`zoom ×${map.view.zoom.toFixed(1)}`), `toolbar shows zoom ×${map.view.zoom.toFixed(1)}`);
  });
  it('switches to the globe, turns on satellite imagery and composites half blocks', async () => {
    const { app, map, clock } = makeApp();
    app.handleEvent({ type: 'key', name: 'g', ch: 'g' });
    app.render();
    assert.equal(map.view.mode, 'globe');
    assert.match(text(app), /GLOBE/);
    app.handleEvent({ type: 'key', name: 's', ch: 's' });
    app.render();
    await new Promise((r) => setTimeout(r, 30));
    clock.t += 2000;
    app.render();
    assert.equal(map.imageryStatus, 'BLUE MARBLE');
    const lines = app.screen.toLines();
    assert.ok(lines.some((l) => l.includes('▀')), 'half-block imagery cells are drawn');
    assert.equal(map.imageryCache.stats().requests, 2, 'day and night images requested');
    app.handleEvent({ type: 'key', name: 'i', ch: 'i' });
    assert.equal(map.imagery, 'truecolor');
    app.handleEvent({ type: 'key', name: 'd', ch: 'd' });
    assert.equal(map.layers.dayNight, false);
  });
  it('toggles layers from the sidebar, by group and in bulk, and persists them', () => {
    const { app, map, saved } = makeApp();
    app.render();
    const before = map.features.length;
    map.toggleLayer('nuclear', false);
    app.render();
    assert.ok(map.features.length < before);
    assert.equal(saved[saved.length - 1].map.layers.nuclear, false);
    const lines = app.screen.toLines();
    const y = lines.findIndex((l) => l.includes('Nuclear sites'));
    const x = lines[y].indexOf('Nuclear sites');
    mouse(app, 'down', x, y);
    assert.equal(map.layers.nuclear, true);
    map.setAllLayers(false);
    app.render();
    assert.ok(map.features.length < 5, `features after NONE: ${map.features.length}`);
    map.toggleGroup('infra');
    assert.ok(map.layers.cables && map.layers.ports);
    map.resetLayers();
    assert.deepEqual(Object.keys(map.layers).filter((k) => map.layers[k]).sort(), Object.keys(defaultLayerState()).filter((k) => defaultLayerState()[k]).sort());
    app.handleEvent({ type: 'key', name: 'L', ch: 'L', shift: true });
    assert.equal(map.focus, 'map');
    app.handleEvent({ type: 'key', name: 'L', ch: 'L', shift: true });
    assert.equal(map.sidebar, false);
  });
  it('searches features and countries and jumps to the result', () => {
    const { app, map } = makeApp();
    app.render();
    app.handleEvent({ type: 'key', name: '/', ch: '/' });
    for (const ch of 'hormuz') app.handleEvent({ type: 'key', name: ch, ch });
    app.render();
    assert.ok(map.search.results.length >= 1);
    assert.match(text(app), /SEARCH/);
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.equal(map.search, null);
    assert.ok(map.pinned && /hormuz/i.test(map.pinned.name));
    assert.ok(Math.abs(map.view.lon - 56.5) < 1);
    app.handleEvent({ type: 'key', name: '/', ch: '/' });
    for (const ch of 'japan') app.handleEvent({ type: 'key', name: ch, ch });
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(map.view.lon > 130 && map.view.lon < 145);
  });
  it('moves aircraft by dead reckoning and draws satellite ground tracks when focused', () => {
    const { app, map, clock } = makeApp();
    app.render();
    const ac = map.drawn.points.find((p) => p.f.layer === 'flights');
    assert.ok(ac, 'aircraft drawn');
    clock.t += 5 * 60000;
    app.render();
    const later = map.drawn.points.find((p) => p.f.layer === 'flights');
    assert.ok(later.x > ac.x, 'heading 090 moves east over time');
    const sat = map.features.find((f) => f.layer === 'satellites');
    assert.ok(sat && sat.tle);
    const paths = [];
    const polyline = map.canvas.polyline.bind(map.canvas);
    map.canvas.polyline = (path, ...rest) => {
      paths.push(path);
      return polyline(path, ...rest);
    };
    // A drawn path of 20+ points that runs along the satellite's own ground track.
    const trackDrawn = () => {
      const dots = groundTrack(sat.tle, clock.t, { back: 45, ahead: 95, stepMin: 1 }).map(([lon, lat]) => map.proj.toDot(lon, lat));
      const near = ([x, y]) => dots.some(([tx, ty]) => Math.abs(x - tx) <= 1 && Math.abs(y - ty) <= 1);
      // The map unwraps longitudes past 180°, so compare the leading stretch only.
      return paths.some((path) => path.length >= 20 && path.slice(0, 20).every(near));
    };
    clock.t += 1000;
    app.render();
    assert.equal(trackDrawn(), false, 'no ground track while the satellite is not focused');
    paths.length = 0;
    map.pin(sat);
    clock.t += 1000;
    app.render();
    assert.doesNotMatch(text(app), /view error/);
    assert.equal(trackDrawn(), true, 'pinning the satellite draws its ground track');
  });
  it('scrolls the detail overlay, keeps it open on inside clicks and shows the record on the map', () => {
    const { app, map } = makeApp();
    app.switchView(app.views.findIndex((v) => v.id === 'news'));
    app.render();
    let centred = 0;
    const rows = Array.from({ length: 80 }, (_, i) => [`Row ${i}`, `value ${i}`]);
    app.openDetail({ title: 'Long record', subtitle: 'test', rows, onCenter: () => (centred += 1) });
    app.render();
    assert.ok(app.detail.maxScroll > 0, 'content taller than the overlay');
    app.handleEvent({ type: 'key', name: 'down' });
    assert.equal(app.detail.scroll, 1);
    app.handleEvent({ type: 'key', name: 'G', ch: 'G', shift: true });
    assert.equal(app.detail.scroll, app.detail.maxScroll);
    const { box } = app.detail;
    mouse(app, 'wheelup', box.x + 2, box.y + 2, -1);
    assert.equal(app.detail.scroll, app.detail.maxScroll - 3);
    mouse(app, 'wheeldown', box.x + 2, box.y + 2, -1);
    mouse(app, 'wheeldown', box.x + 2, box.y + 2, -1);
    assert.equal(app.detail.scroll, app.detail.maxScroll, 'wheel clamps at the end');
    mouse(app, 'down', box.x + 2, box.y + 1);
    assert.ok(app.detail, 'a click inside the overlay keeps it open');
    mouse(app, 'move', box.x + 3, box.y + 3);
    assert.ok(app.detail, 'pointer motion is swallowed while it is open');
    app.handleEvent({ type: 'key', name: 'm', ch: 'm' });
    assert.equal(app.detail, null);
    assert.equal(app.view, map, 'm switches to the map');
    assert.equal(centred, 1, 'and centres on the record');
  });
  it('keeps every theme and animation mode free of view errors', () => {
    for (const id of ['matrix', 'synthwave']) {
      const { app, map } = makeApp({ anim: id === 'matrix' });
      app.setTheme(id);
      app.render();
      app.handleEvent({ type: 'key', name: 'g', ch: 'g' });
      app.render();
      map.toggleLayer('sanctions', true);
      app.render();
      assert.doesNotMatch(text(app), /view error/);
    }
  });
  it('fits a small terminal without crashing', () => {
    const { app } = makeApp({ cols: 80, rows: 24 });
    app.render();
    assert.doesNotMatch(text(app), /view error/);
  });
});

describe('detail overlay', () => {
  it('describes arbitrary records and formats enums, timestamps and nested objects', () => {
    const d = describeItem({ title: 'Quake', magnitude: 5.1, location: { latitude: 1.5, longitude: 2.25 }, occurredAt: Date.now() - 3600e3, severity: 'THREAT_LEVEL_HIGH', sourceUrl: 'https://example.com/q', description: 'A long description.', tags: ['a', 'b'] });
    assert.equal(d.title, 'Quake');
    assert.equal(d.url, 'https://example.com/q');
    assert.ok(d.rows.some(([k, v]) => k === 'Severity' && v === 'high'));
    assert.ok(d.rows.some(([k, v]) => k === 'Location' && v === '1.50, 2.25'));
    assert.ok(d.rows.some(([k, v]) => k === 'Occurred at' && /1h.*ago/.test(v)));
    assert.equal(d.body, 'A long description.');
  });
  it('expands list rows in other views and closes with Escape or a click outside', () => {
    const { app, clock } = makeApp();
    app.switchView(app.views.findIndex((v) => v.id === 'climate'));
    clock.t += 500;
    app.render();
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(app.detail, 'climate quake expands');
    app.render();
    assert.match(text(app), /Magnitude/);
    app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(app.detail, null);
    app.switchView(app.views.findIndex((v) => v.id === 'news'));
    app.render();
    assert.equal(app.view.focusedPane, 'items');
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(app.detail, 'news headline expands');
    app.render();
    mouse(app, 'down', 0, 3);
    assert.equal(app.detail, null, 'click outside closes');
  });
});

describe('brief view', () => {
  it('extracts citations and keywords and finds related coverage', () => {
    assert.deepEqual(citations('Something happened [1] and more [3].'), [1, 3]);
    assert.ok(tokens('Protesters clashed with police in Belgium').includes('belgium'));
    const ins = bootstrap.data.insights;
    const rel = relatedFor(ins.briefStoryLines[0], ins, digest);
    assert.ok(rel.length >= 1);
    assert.equal(rel[0].kind, 'cited');
    assert.equal(rel[0].n, 1);
    assert.ok(rel[0].link);
  });
  it('renders the brief with story lines and a related pane, and expands items', () => {
    const { app, clock } = makeApp();
    app.switchView(app.views.findIndex((v) => v.id === 'brief'));
    clock.t += 500; // past the tab wipe
    app.render();
    const t = text(app);
    assert.match(t, /AI WORLD BRIEF/);
    assert.match(t, /STORY LINES|story lines/);
    assert.match(t, /What line 1 is about/i);
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.equal(app.view.focusedPane, 'related');
    app.handleEvent({ type: 'key', name: 'enter' });
    assert.ok(app.detail);
    assert.match(app.detail.spec.subtitle, /cited source/);
    app.handleEvent({ type: 'key', name: 'escape' });
    app.handleEvent({ type: 'key', name: 'left' });
    app.handleEvent({ type: 'key', name: 'down' });
    app.render();
    assert.match(text(app), /What line 2 is about/i);
  });
  it('keeps the fallback story lines stable so the related cache hits', () => {
    const { app } = makeApp();
    const brief = app.views.find((v) => v.id === 'brief');
    const ins = { ...app.store.data.insights, briefStoryLines: undefined, worldBrief: 'First thing happened. Second thing too.' };
    app.store.data.insights = ins;
    assert.equal(brief.lines(), brief.lines());
  });
});

describe('review fixes', () => {
  it('saves the map state through the real prefs file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadPrefs, savePrefs } = await import('../src/tui/prefs.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wm-map-prefs-'));
    try {
      const env = { XDG_CONFIG_HOME: dir };
      savePrefs({ theme: 'neon', animations: true, view: 'map', map: { view: { mode: 'globe', lon: 10, lat: 20, zoom: 2 }, sat: true } }, env);
      const back = loadPrefs(env);
      assert.equal(back.map && back.map.view.mode, 'globe');
      assert.equal(back.map.sat, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('saves keyboard pans and zooms when quitting from the map', () => {
    const { app, map, saved } = makeApp();
    app.render();
    app.handleEvent({ type: 'key', name: '+', ch: '+' });
    app.quit();
    const last = saved[saved.length - 1];
    assert.ok(last && last.map, 'map state saved on quit');
    assert.equal(last.map.view.zoom, map.view.zoom);
    assert.ok(map.view.zoom > 1);
  });
  it('opens the info card and search results on click', () => {
    const { app, map } = makeApp();
    app.render();
    const r = map.mapRect;
    const cable = map.drawn.lines.find((l) => l.f.layer === 'cables');
    const [x0, y0] = cable.segs[Math.floor(cable.segs.length / 2)];
    const cx = r.x + Math.floor(x0 / 2);
    const cy = r.y + Math.floor(y0 / 4);
    mouse(app, 'move', cx, cy);
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    assert.ok(map.pinned);
    app.render();
    const lines = app.screen.toLines();
    const y = lines.findIndex((l) => l.includes('c unpin'));
    assert.ok(y > 0, 'pinned card is drawn');
    mouse(app, 'down', lines[y].indexOf('c unpin'), y);
    mouse(app, 'up', lines[y].indexOf('c unpin'), y);
    assert.ok(app.detail, 'clicking the card opens the detail overlay');
    app.handleEvent({ type: 'key', name: 'escape' });

    app.handleEvent({ type: 'key', name: '/', ch: '/' });
    for (const ch of 'hormuz') app.handleEvent({ type: 'key', name: ch, ch });
    app.render();
    const sl = app.screen.toLines();
    const qy = sl.findIndex((l) => l.includes('⌕ hormuz'));
    const ry = qy + 1;
    mouse(app, 'down', sl[ry].indexOf('│') + 3, ry);
    mouse(app, 'up', sl[ry].indexOf('│') + 3, ry);
    assert.equal(map.search, null, 'clicking a result closes the search');
    assert.ok(map.pinned && /hormuz/i.test(map.pinned.name));
  });
  it('does not pan or zoom the map under the help overlay', () => {
    const { app, map } = makeApp();
    app.render();
    const r = map.mapRect;
    app.handleEvent({ type: 'key', name: '?', ch: '?' });
    const zoom = map.view.zoom;
    mouse(app, 'wheelup', r.x + 20, r.y + 5, -1);
    assert.equal(map.view.zoom, zoom);
    mouse(app, 'down', r.x + 20, r.y + 5);
    assert.equal(app.help, false, 'a click closes help');
    assert.equal(map.drag, null, 'and does not start a drag');
  });
  it('keeps a pending redraw when the mouse moves over a view without hover', () => {
    const { app } = makeApp({ anim: false });
    app.switchView(app.views.findIndex((v) => v.id === 'news'));
    app.render();
    app.toast('hello');
    mouse(app, 'move', 5, 5);
    assert.equal(app.dirty, true);
  });
  it('keeps a lazy source while another enabled layer still uses it', () => {
    const { map, store } = makeApp();
    map.toggleLayer('shipping', true);
    map.toggleLayer('aisDisruptions', true);
    map.toggleLayer('shipping', false);
    assert.ok(store.wanted.has('vessels'), 'AIS disruptions still needs vessels');
    map.toggleLayer('aisDisruptions', false);
    assert.ok(!store.wanted.has('vessels'));
  });
  it('fetches a zoomed view across the antimeridian as two sharp tiles', async () => {
    const urls = [];
    const fetchImpl = async (u) => {
      urls.push(u);
      return pngResponse();
    };
    const { app, map, clock } = makeApp({ anim: false, fetchImpl });
    map.setView({ ...map.view, mode: 'flat', lon: 180, lat: 0, zoom: 6 });
    map.toggleSat();
    map.layers.dayNight = false;
    app.render();
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 2000;
    app.render();
    const boxes = urls.map((u) => new URL(u).searchParams).filter((q) => q.get('LAYERS') !== 'VIIRS_Black_Marble');
    assert.equal(boxes.length, 2, 'one tile on each side of 180°');
    for (const q of boxes) assert.ok(Number(q.get('WIDTH')) < 1024, `tile width ${q.get('WIDTH')} matches the zoom, not a world strip`);
    const lons = boxes.map((q) => q.get('BBOX').split(',').map(Number)).map(([, w, , e]) => [w, e]);
    assert.ok(lons.some(([, e]) => e === 180) && lons.some(([w]) => w === -180));
    assert.equal(map.imageryStatus, 'BLUE MARBLE');
    assert.ok(app.screen.toLines().some((l) => l.includes('▀')));
  });
  it('reuses sampled imagery cells while the map is still and resamples after a pan', async () => {
    const { app, map, clock } = makeApp({ anim: false });
    map.toggleSat();
    app.render();
    await new Promise((r) => setTimeout(r, 20));
    clock.t += 2000;
    let samples = 0;
    const original = map.sampler.bind(map);
    map.sampler = (...args) => {
      const fn = original(...args);
      return (cx, cy) => {
        samples += 1;
        return fn(cx, cy);
      };
    };
    app.render();
    const first = samples;
    assert.ok(first > 100, `first frame samples the imagery (${first})`);
    app.render();
    assert.equal(samples, first, 'a still frame reuses every cell');
    app.handleEvent({ type: 'key', name: 'left' });
    app.render();
    assert.ok(samples > first, 'a pan resamples');
  });
  it('samples a fallback tile with its own extent, not the new request', () => {
    const { map } = makeApp();
    const img = decodePng(png);
    const entry = { status: 'ready', image: img, req: { bbox: [0, 0, 10, 10] } };
    const proj = makeProjector(normalizeView({ ...defaultView(), lon: 0, lat: 0, zoom: 1 }, 340, 160), 340, 160);
    const bg = map.sampler([entry], proj, null, [], 1);
    const [x, y] = proj.toDot(120, 5); // far outside the 0..10 tile
    assert.equal(bg(Math.floor(x / 2), Math.floor(y / 4)), null);
  });
  it('strips control characters from map labels', async () => {
    const { Screen } = await import('../src/tui/term/screen.mjs');
    const c = new DotCanvas(40, 4);
    c.label(4, 4, 'Riot\u001b]0;pwned\u0007', '#ffffff', { force: true });
    const s = new Screen(40, 4);
    c.blit({ s, t: theme, hits: [] }, { x: 0, y: 0, w: 40, h: 4 });
    const out = s.diff(null);
    assert.ok(!/\u0007/.test(out));
    assert.ok(!/\u001b[^[]/.test(out), 'every escape is one the renderer wrote');
  });
  it('keeps an emoji map label two columns wide so the row does not drift', async () => {
    const { Screen } = await import('../src/tui/term/screen.mjs');
    const c = new DotCanvas(30, 2);
    for (let x = 0; x < 60; x++) c.dot(x, 1, '#888888'); // braille under the label row
    c.label(0, 0, '🟠Drought', '#ffffff', { force: true });
    const s = new Screen(30, 2);
    c.blit({ s, t: theme, hits: [] }, { x: 0, y: 0, w: 30, h: 2 });
    assertCellWidths(s);
    assert.match(s.toLines()[0], /🟠Drought/);
  });
  it('draws every view with each wide character followed by its reserved cell', () => {
    const { app, map } = makeApp();
    for (let i = 0; i < app.views.length; i++) {
      app.switchView(i);
      app.render();
      assertCellWidths(app.screen, app.views[i].id);
    }
    app.switchView(app.views.indexOf(map));
    app.handleEvent({ type: 'key', name: '/', ch: '/' });
    for (const ch of 'marea') app.handleEvent({ type: 'key', name: ch, ch });
    app.handleEvent({ type: 'key', name: 'enter' });
    app.render();
    assertCellWidths(app.screen, 'map pinned');
  });
  it('keeps keys on the map when the layer panel does not fit', () => {
    const { app, map } = makeApp({ cols: 80, rows: 30 });
    app.render();
    const before = JSON.stringify(map.layers);
    for (const name of ['L', 'L']) {
      app.handleEvent({ type: 'key', name, ch: name, shift: true });
      app.render();
    }
    for (const name of ['down', 'down', 'enter']) {
      app.handleEvent({ type: 'key', name });
      app.render();
    }
    if (app.detail) app.handleEvent({ type: 'key', name: 'escape' });
    assert.equal(JSON.stringify(map.layers), before, 'no layers toggled from a hidden panel');
  });
  it('opens a country on a second click', () => {
    const { app, map } = makeApp();
    map.toggleLayer('cii', true);
    app.render();
    const [x, y] = map.proj.toDot(123, -25);
    const cx = map.mapRect.x + Math.floor(x / 2);
    const cy = map.mapRect.y + Math.floor(y / 4);
    mouse(app, 'move', cx, cy);
    for (let i = 0; i < 2; i++) {
      mouse(app, 'down', cx, cy);
      mouse(app, 'up', cx, cy);
    }
    assert.ok(app.detail, 'double click on Australia opens its detail');
  });
  it('aborts imagery fetches on close', async () => {
    let aborted = 0;
    const fetch = (_u, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted += 1;
          reject(new Error('aborted'));
        });
      });
    const cache = new ImageryCache({ fetch, now: () => 1000 });
    cache.get({ layer: 'a', bbox: [0, 0, 10, 10], width: 8, height: 8 });
    cache.close();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(aborted, 1);
    assert.equal(cache.active, 0);
  });
  it('waits out a cold GIBS render (about a minute) before giving up', () => {
    // A hand-rolled setTimeout stub: node:test mock timers need Node 20.11,
    // and the CLI supports Node 18.17.
    const realSetTimeout = globalThis.setTimeout;
    const timers = [];
    globalThis.setTimeout = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    try {
      let signal = null;
      const fetch = (_u, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      };
      const cache = new ImageryCache({ fetch, now: () => 1000 });
      cache.get({ layer: 'globe', bbox: [-180, -90, 180, 90], width: 1080, height: 540 }, 'globe');
      assert.equal(timers.length, 1);
      assert.ok(timers[0].ms > 61000, 'a 61 s render is still awaited');
      assert.equal(signal.aborted, false);
      timers[0].fn();
      assert.equal(signal.aborted, true, 'and abandoned after the timeout');
      cache.close();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
  it('aborts an in-flight fetch once a newer request replaces it in its slot', async () => {
    const aborted = [];
    const fetch = (u, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(new URL(u).searchParams.get('LAYERS'));
          reject(new Error('aborted'));
        });
      });
    const cache = new ImageryCache({ fetch, now: () => 1000 });
    const a = cache.get({ layer: 'a', bbox: [0, 0, 10, 10], width: 8, height: 8 }, 'view');
    cache.get({ layer: 'n', bbox: [0, 0, 10, 10], width: 8, height: 8 }, 'night');
    cache.get({ layer: 'b', bbox: [0, 0, 10, 10], width: 8, height: 8 }, 'view');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(aborted, ['a'], 'only the superseded view fetch is cancelled');
    assert.equal(cache.peek({ layer: 'a', bbox: [0, 0, 10, 10], width: 8, height: 8 }), null, 'and it can be fetched again later');
    assert.equal(a.status, 'error');
    cache.close();
  });
  it('evicts the oldest ready images but keeps wanted and loading ones', async () => {
    let t = 1000;
    const cache = new ImageryCache({ fetch: async () => pngResponse(), now: () => t, maxEntries: 3 });
    for (const layer of ['a', 'b', 'c', 'd']) {
      t += 10;
      cache.get({ layer, bbox: [0, 0, 10, 10], width: 8, height: 8 }, layer);
      await new Promise((r) => setTimeout(r, 5));
    }
    t += 10;
    cache.get({ layer: 'e', bbox: [0, 0, 10, 10], width: 8, height: 8 }, 'a');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(cache.entries.size <= 3 + 1);
    assert.equal(cache.peek({ layer: 'a', bbox: [0, 0, 10, 10], width: 8, height: 8 }), null, 'the oldest image no slot wants is evicted');
    assert.ok(cache.peek({ layer: 'e', bbox: [0, 0, 10, 10], width: 8, height: 8 }), 'the newest wanted image stays');
  });
  it('retries a failed image after 30 s and reports undecodable responses', async () => {
    let t = 1000;
    let calls = 0;
    const cache = new ImageryCache({ fetch: async () => (++calls === 1 ? { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } : pngResponse()), now: () => t });
    const req = { layer: 'x', bbox: [0, 0, 10, 10], width: 8, height: 8 };
    cache.get(req);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(cache.peek(req).status, 'error');
    assert.match(cache.peek(req).error, /not a PNG/);
    t += 10000;
    cache.get(req);
    assert.equal(calls, 1, 'no retry inside 30 s');
    t += 25000;
    cache.get(req);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2);
    assert.equal(cache.peek(req).status, 'ready');
  });
  it('rejects PNGs with absurd dimensions before allocating', () => {
    const chunk = (type, data) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0);
      b.write(type, 4, 'latin1');
      data.copy(b, 8);
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(100000, 0);
    ihdr.writeUInt32BE(100000, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
    assert.throws(() => decodePng(bomb), /too large/);
  });
  it('stores Gulf investment values in dollars', () => {
    const london = catalog.layers.gulfInvestments.find((g) => g.id === 'dpw-london-gateway');
    assert.equal(london.usd, 1.5e9);
  });
});

describe('second review round', () => {
  it('wraps any finite longitude without looping, and passes non-finite ones through', () => {
    assert.ok(wrapLon(1e17) >= -180 && wrapLon(1e17) < 180);
    assert.equal(wrapLon(3610), 10);
    assert.equal(wrapLon(-3590), 10);
    assert.equal(wrapLon(540), -180);
    assert.equal(wrapLon(-540), -180);
    assert.equal(wrapLon(Infinity), Infinity);
    assert.ok(Number.isNaN(wrapLon(Number.NaN)));
  });
  it('shows an out-of-range timestamp as a number instead of throwing', () => {
    const d = describeItem({ title: 'Bad clock', updatedAt: 1e16 });
    const row = d.rows.find(([k]) => /updated/i.test(k));
    assert.ok(row, 'the field is still listed');
    assert.doesNotMatch(row[1], /ago/);
  });
  it('drops non-http(s) links passed to the detail overlay', () => {
    assert.equal(describeItem({ title: 'x' }, { url: 'file:///etc/passwd' }).url, null);
    assert.equal(describeItem({ title: 'x' }, { url: 'https://example.com/a' }).url, 'https://example.com/a');
  });
  it('keeps non-http(s) brief links out of the overlay and the open key', () => {
    const { app } = makeApp();
    const brief = app.views.find((v) => v.id === 'brief');
    app.store.data.insights = { ...app.store.data.insights, briefStoryLines: [{ n: 1, text: 'Something happened [1].' }], worldBriefSources: [{ title: 'Local', source: 'x', url: 'file:///etc/passwd' }] };
    const line = brief.lines()[0];
    assert.equal(brief.describe(line, 'lines').url, null);
    assert.equal(brief.describe(brief.related()[0], 'related').url, null);
    assert.equal(brief.selectedUrl(), null);
  });
  it('recomputes related items when insights change but the brief text does not', () => {
    const { app } = makeApp();
    const brief = app.views.find((v) => v.id === 'brief');
    const base = { ...app.store.data.insights, briefStoryLines: undefined, worldBrief: 'Something happened [1].' };
    app.store.data.insights = { ...base, worldBriefSources: [{ title: 'Old source', source: 'a', url: 'https://a.example/' }] };
    assert.equal(brief.related()[0].title, 'Old source');
    app.store.data.insights = { ...base, worldBriefSources: [{ title: 'New source', source: 'b', url: 'https://b.example/' }] };
    assert.equal(brief.related()[0].title, 'New source');
  });
});
