// Street-level map tests: vector tile decoding and styling, JPEG decoding,
// tile math and caches, the keyless lookup services, and the map view at
// street zoom (tiles, hover, details with links, "what's here", remote
// search, Wikipedia and aircraft layers, high-zoom imagery).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { App } from '../src/tui/app.mjs';
import { createClient } from '../src/tui/data/client.mjs';
import { Store } from '../src/tui/data/store.mjs';
import { loadCatalog } from '../src/tui/index.mjs';
import { createViews } from '../src/tui/views/index.mjs';
import { decodeTile } from '../src/tui/map/pbf.mjs';
import { decodeJpeg } from '../src/tui/map/jpeg.mjs';
import { STREET_LAYERS, displayName, featureLinks, tileFeatures } from '../src/tui/map/osm.mjs';
import { TileCache, createRasterTileCache, createVectorTileCache, tileKey } from '../src/tui/map/tiles.mjs';
import { Lookups, shortAddress, weatherText } from '../src/tui/map/services.mjs';
import { lonLatToTile, makeProjector, normalizeView, scaleBar, tileToLonLat, tilesForBbox } from '../src/tui/map/geo.mjs';
import { getTheme } from '../src/tui/ui/theme.mjs';
import { visualText } from '../src/tui/views/map.mjs';
import { Screen, stableWidth } from '../src/tui/term/screen.mjs';

const bootstrap = JSON.parse(readFileSync(new URL('./fixtures/bootstrap.json', import.meta.url), 'utf8'));
const digest = JSON.parse(readFileSync(new URL('./fixtures/digest.json', import.meta.url), 'utf8'));
const png = readFileSync(new URL('./fixtures/gibs-bluemarble-32x16.png', import.meta.url));
const pbf = readFileSync(new URL('./fixtures/osm-tabuk-14-9855-6843.pbf', import.meta.url));
const jpg = readFileSync(new URL('./fixtures/esri-imagery-14-7193-10004.jpg', import.meta.url));
const catalog = loadCatalog();
const theme = getTheme('neon');
const TABUK = { z: 14, x: 9855, y: 6843, lat: 28.3838, lon: 36.555 };

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// A fetch stub for every service the street map talks to.
function stubFetch(log = []) {
  return async (url) => {
    const u = String(url);
    log.push(u);
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.includes('openfreemap.org/planet') && !u.endsWith('.pbf')) return json({ tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] });
    if (u.endsWith('.pbf')) return { ok: true, status: 200, arrayBuffer: async () => ab(pbf) };
    if (u.includes('arcgisonline')) return { ok: true, status: 200, arrayBuffer: async () => ab(jpg) };
    if (u.includes('gibs')) return { ok: true, status: 200, arrayBuffer: async () => ab(png) };
    if (u.includes('nominatim') && u.includes('reverse')) return json({ name: 'King Faisal Road', display_name: 'King Faisal Road, Tabuk, Saudi Arabia', category: 'highway', type: 'primary', osm_type: 'way', osm_id: 42, address: { road: 'King Faisal Road', city: 'Tabuk', country: 'Saudi Arabia' } });
    if (u.includes('nominatim') && u.includes('search')) return json([{ name: 'Prince Sultan Mosque', display_name: 'Prince Sultan Mosque, Tabuk, Saudi Arabia', lat: '28.39', lon: '36.56', category: 'amenity', type: 'place_of_worship', osm_type: 'way', osm_id: 7, boundingbox: ['28.389', '28.391', '36.559', '36.561'] }]);
    if (u.includes('open-meteo')) return json({ current: { temperature_2m: 31.5, apparent_temperature: 30, relative_humidity_2m: 20, precipitation: 0, weather_code: 1, wind_speed_10m: 14, wind_direction_10m: 300, cloud_cover: 10, time: '2026-10-19T14:00' }, daily: { sunrise: ['2026-10-19T06:10'], sunset: ['2026-10-19T17:45'], temperature_2m_max: [33], temperature_2m_min: [18] }, timezone: 'Asia/Riyadh', utc_offset_seconds: 10800, elevation: 770 });
    if (u.includes('wikipedia') && u.includes('geosearch')) return json({ query: { geosearch: [{ pageid: 99, title: 'Tabuk, Saudi Arabia', lat: 28.3838, lon: 36.555, dist: 12 }] } });
    if (u.includes('wikipedia')) return json({ query: { pages: { 99: { title: 'Tabuk, Saudi Arabia', extract: 'Tabuk is a city in northwestern Saudi Arabia.', fullurl: 'https://en.wikipedia.org/wiki/Tabuk,_Saudi_Arabia' } } } });
    if (u.includes('overpass')) return json({ elements: [{ type: 'way', id: 555, tags: { name: 'X', website: 'example.org', opening_hours: 'Mo-Su 05:00-22:00', religion: 'muslim', denomination: 'sunni', 'addr:street': 'Main St', wikipedia: 'en:Some Mosque' } }] });
    if (u.includes('adsb')) return json({ ac: [{ hex: 'abc123', flight: 'SVA123 ', r: 'HZ-AK1', t: 'B789', lat: 28.4, lon: 36.6, alt_baro: 34000, gs: 450, track: 180, baro_rate: 0, squawk: '1234', seen: 2, dbFlags: 0 }, { hex: 'mil1', flight: 'RCH1', t: 'C17', lat: 28.5, lon: 36.7, alt_baro: 'ground', gs: 0, track: 0, seen: 1, dbFlags: 1, emergency: 'none' }] });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}), headers: new Map() };
  };
}

function makeApp({ cols = 170, rows = 48, anim = true } = {}) {
  const clock = { t: 1_792_300_000_000 };
  const log = [];
  const store = new Store(createClient({ fetch: async () => ({ ok: true, status: 200, text: async () => '{}', headers: new Map() }) }), { now: () => clock.t });
  Object.assign(store.data, bootstrap.data);
  store.raw.digest = digest;
  const app = new App({ store, catalog, prefs: { theme: 'neon', animations: anim, view: 'map' }, savePrefs: () => {}, out: () => {}, cols, rows, createViews, now: () => clock.t, player: {}, fetchImpl: stubFetch(log), userAgent: 'worldmonitor-tui-test' });
  app.boot.done = true;
  app.view.mount();
  clock.t += 500;
  const map = app.view;
  const settle = async (ms = 20, steps = 3) => {
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, ms));
      clock.t += 1500;
      app.render();
    }
  };
  return { app, map, clock, log, settle };
}

const text = (app) => app.screen.toLines().join('\n');
const mouse = (app, kind, x, y, button = kind === 'move' ? 3 : 0) => app.handleEvent({ type: 'mouse', kind, x, y, button });
const key = (app, name, extra = {}) => app.handleEvent({ type: 'key', name, ch: name.length === 1 ? name : undefined, ...extra });

describe('vector tiles', () => {
  it('decodes an OpenFreeMap tile into layers with tags and geometry', () => {
    const tile = decodeTile(pbf);
    assert.ok(tile.layers.transportation.features.length > 100);
    assert.ok(tile.layers.poi.features.length > 100);
    assert.equal(tile.layers.poi.extent, 4096);
    const mosque = tile.layers.poi.features.find((f) => f.props.class === 'place_of_worship');
    assert.ok(mosque);
    assert.equal(mosque.type, 1);
    assert.equal(mosque.geometry.length, 1);
    const road = tile.layers.transportation.features.find((f) => f.type === 2);
    assert.ok(road.geometry[0].length >= 2);
    assert.throws(() => decodeTile(Buffer.from([0xff, 0xff, 0xff])));
  });
  it('styles tiles with zoom-dependent level of detail', () => {
    const tile = decodeTile(pbf);
    const at = (tz) => tileFeatures(tile, TABUK.z, TABUK.x, TABUK.y, { t: theme, tileZoom: tz });
    const count = (fs, layer) => fs.filter((f) => f.layer === layer).length;
    const z6 = at(6);
    const z12 = at(12);
    const z15 = at(15);
    const z18 = at(18);
    assert.ok(count(z6, 'roads') < count(z12, 'roads'), 'minor roads only appear when zoomed in');
    assert.equal(count(z6, 'buildings'), 0);
    assert.ok(count(z15, 'buildings') > 0);
    assert.ok(count(z12, 'worship') > 0, 'mosques appear from z11');
    assert.ok(count(z15, 'pois') > count(z12, 'pois'));
    assert.equal(count(z15, 'housenumbers'), 0);
    assert.ok(count(z18, 'housenumbers') > 0, 'house numbers only at z17+');
    const mosque = z15.find((f) => f.layer === 'worship');
    assert.equal(mosque.glyph, '☪');
    assert.equal(mosque.kind, 'Mosque');
    assert.ok(mosque.lat > 28.2 && mosque.lat < 28.6 && mosque.lon > 36.4 && mosque.lon < 36.7, 'tile coordinates convert to lon/lat');
    assert.ok(mosque.info.some(([k, v]) => k === 'Type' && v === 'Mosque'));
    const road = z15.find((f) => f.layer === 'roads');
    assert.ok(road.points.length >= 2);
    const none = tileFeatures(tile, TABUK.z, TABUK.x, TABUK.y, { t: theme, tileZoom: 15, enabled: { roads: false, pois: false, worship: false, buildings: false, water: false, landuse: false, places: false, streetNames: false, boundaries: false, rail: false, aeroway: false, peaks: false, housenumbers: false } });
    assert.equal(none.length, 0);
  });
  it('prefers English names and builds links for features', () => {
    assert.deepEqual(displayName({ name: 'مكة', 'name:en': 'Mecca' }), { name: 'Mecca', local: 'مكة' });
    assert.deepEqual(displayName({ name: 'Paris' }), { name: 'Paris', local: '' });
    const links = featureLinks({ name: 'Grand Mosque', lat: 21.42, lon: 39.83, layer: 'worship' });
    assert.equal(links[0].label, 'OpenStreetMap');
    assert.match(links[1].url, /google\.com\/maps/);
    assert.ok(links.some((l) => l.label === 'Wikipedia search'));
    assert.ok(!featureLinks({ name: 'Building', lat: 1, lon: 1, layer: 'buildings' }).some((l) => l.label === 'Wikipedia search'));
  });
});

describe('terminal text', () => {
  it('reverses purely right-to-left names into visual order and leaves mixed text alone', () => {
    assert.equal(visualText('مسجد'), 'دجسم');
    assert.equal(visualText('Masjid مسجد'), 'Masjid مسجد');
    assert.equal(visualText('Kaaba'), 'Kaaba');
  });
  it('re-anchors the cursor after glyphs whose width terminals disagree on', () => {
    assert.ok(stableWidth('a') && stableWidth('°') && stableWidth('⣿') && stableWidth('─'));
    assert.ok(!stableWidth('☪') && !stableWidth('م') && !stableWidth('卍'));
    const s = new Screen(10, 1);
    s.text(0, 0, '☪ab', { fg: '#ffffff', bg: '#000000' });
    const out = s.diff(null);
    assert.match(out, /☪\x1b\[1;2H/, 'explicit move after the symbol');
    assert.doesNotMatch(out, /a\x1b\[1;3H/, 'plain ASCII keeps the implicit advance');
  });
});

describe('jpeg + tiles', () => {
  it('decodes a baseline JPEG imagery tile', () => {
    const img = decodeJpeg(jpg);
    assert.equal(img.width, 256);
    assert.equal(img.height, 256);
    const mid = (128 * 256 + 128) * 4;
    assert.ok(img.data[mid + 3] === 255);
    assert.ok(img.data.some((v) => v > 60), 'not black');
    assert.throws(() => decodeJpeg(Buffer.from('not a jpeg')));
  });
  it('converts between lon/lat and tiles and lists viewport tiles', () => {
    const t = lonLatToTile(TABUK.lon, TABUK.lat, 14);
    assert.equal(Math.floor(t.x), TABUK.x);
    assert.equal(Math.floor(t.y), TABUK.y);
    const back = tileToLonLat(TABUK.x + 0.5, TABUK.y + 0.5, 14);
    assert.ok(Math.abs(back.lon - TABUK.lon) < 0.03 && Math.abs(back.lat - TABUK.lat) < 0.03);
    const view = normalizeView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: (256 * 2 ** 14) / 340 }, 340, 160);
    const p = makeProjector(view, 340, 160);
    assert.ok(Math.abs(p.tileZoom - 14) < 1e-9);
    const tiles = tilesForBbox(p.bbox(), 14);
    assert.ok(tiles.length >= 2 && tiles.length <= 6);
    assert.ok(tiles.some((x) => x.x === TABUK.x && x.y === TABUK.y));
    const sb = scaleBar(p.metersPerDot, 18);
    assert.ok(sb.cells >= 1 && sb.cells <= 18);
    assert.match(sb.label, /\d+ m$/);
  });
  it('loads tiles centre-first, drops stale requests and evicts old entries', async () => {
    const order = [];
    const cache = new TileCache({ fetch: async (u) => { order.push(u); return { ok: true, status: 200, arrayBuffer: async () => ab(jpg) }; }, decode: decodeJpeg, urlFor: async (z, x, y) => `t/${z}/${x}/${y}`, concurrency: 1, maxEntries: 3, now: () => 1 });
    cache.beginFrame();
    cache.get(14, 1, 1, 5);
    cache.get(14, 2, 2, 1);
    cache.get(14, 3, 3, 3);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(order.length, 3);
    assert.equal(order[0], 't/14/1/1', 'the first request starts immediately');
    assert.equal(order[1], 't/14/2/2', 'then the closest to the centre');
    assert.equal(cache.peek(14, 2, 2).status, 'ready');
    assert.equal(cache.peek(14, 2, 2).value.width, 256);
    cache.beginFrame();
    cache.get(14, 9, 9, 0);
    cache.get(14, 8, 8, 0);
    cache.beginFrame(); // new frame without renewing 8/8: it is dropped before it loads
    cache.get(14, 9, 9, 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cache.peek(14, 8, 8), null);
    assert.ok(cache.entries.size <= 4);
    assert.equal(tileKey(1, 2, 3), '1/2/3');
  });
  it('resolves the OpenFreeMap tile template once and decodes vector and raster tiles', async () => {
    const log = [];
    const vec = createVectorTileCache({ fetch: stubFetch(log), now: () => 1, userAgent: 'test' });
    const ras = createRasterTileCache({ fetch: stubFetch(log), now: () => 1, userAgent: 'test' });
    vec.beginFrame();
    ras.beginFrame();
    vec.get(TABUK.z, TABUK.x, TABUK.y, 0);
    vec.get(TABUK.z, TABUK.x + 1, TABUK.y, 1);
    ras.get(14, 10004, 7193, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(log.filter((u) => u === 'https://tiles.openfreemap.org/planet').length, 1, 'tilejson fetched once');
    assert.ok(log.some((u) => u.endsWith('/14/9855/6843.pbf')));
    assert.equal(vec.peek(TABUK.z, TABUK.x, TABUK.y).value.layers.poi.features.length > 0, true);
    assert.equal(ras.peek(14, 10004, 7193).value.width, 256);
  });
});

describe('lookup services', () => {
  it('parses Nominatim, Open-Meteo, Wikipedia, Overpass and ADS-B responses', async () => {
    const log = [];
    const l = new Lookups({ fetch: stubFetch(log), now: () => Date.now(), userAgent: 'test', hosts: { nominatim: { base: 'https://nominatim.openstreetmap.org', minIntervalMs: 0 }, overpass: { base: 'https://overpass-api.de/api/interpreter', minIntervalMs: 0 }, meteo: { base: 'https://api.open-meteo.com/v1', minIntervalMs: 0 }, wikipedia: { base: 'https://en.wikipedia.org/w/api.php', minIntervalMs: 0 }, adsb: { base: 'https://api.adsb.lol/v2', minIntervalMs: 0 } } });
    const wait = async (e) => {
      for (let i = 0; i < 50 && e.status === 'loading'; i++) await new Promise((r) => setTimeout(r, 5));
      return e;
    };
    const rev = await wait(l.reverse(28.38, 36.55));
    assert.equal(rev.value.name, 'King Faisal Road');
    assert.equal(shortAddress(rev.value.address), 'King Faisal Road, Tabuk, Saudi Arabia');
    const s = await wait(l.search('prince sultan'));
    assert.equal(s.value[0].name, 'Prince Sultan Mosque');
    assert.equal(s.value[0].lat, 28.39);
    const wx = await wait(l.weather(28.38, 36.55));
    assert.equal(wx.value.temperature, 31.5);
    assert.equal(wx.value.description, 'partly cloudy');
    assert.equal(wx.value.elevation, 770);
    const wiki = await wait(l.wikiNearby(28.38, 36.55, 2000));
    assert.equal(wiki.value[0].pageid, 99);
    const sum = await wait(l.wikiSummary(99));
    assert.match(sum.value.extract, /Tabuk/);
    const tags = await wait(l.tags('X', 28.38, 36.55));
    assert.equal(tags.value[0].tags.religion, 'muslim');
    const ac = await wait(l.aircraft(28.4, 36.6, 50));
    assert.equal(ac.value.length, 2);
    assert.equal(ac.value[0].flight, 'SVA123');
    assert.equal(ac.value[1].onGround, true);
    assert.equal(ac.value[1].military, true);
    assert.equal(weatherText(95), 'thunderstorm');
    // cached: a second call does not fetch again
    const before = log.length;
    l.reverse(28.38, 36.55);
    assert.equal(log.length, before);
  });
  it('retries once when a public server is busy', async () => {
    let calls = 0;
    const l = new Lookups({ fetch: async () => { calls += 1; return calls === 1 ? { ok: false, status: 502 } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; }, now: () => Date.now(), retryDelayMs: 5, hosts: { overpass: { base: 'http://x', minIntervalMs: 0 } } });
    const e = l.get('k', { host: 'overpass', url: 'http://x' });
    for (let i = 0; i < 40 && e.status === 'loading'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2);
    assert.equal(e.status, 'ready');
  });
  it('paces calls per host', async () => {
    const times = [];
    const l = new Lookups({ fetch: async () => { times.push(Date.now()); return { ok: true, status: 200, json: async () => ({}) }; }, now: () => Date.now(), hosts: { meteo: { base: 'http://x', minIntervalMs: 40 } } });
    l.get('a', { host: 'meteo', url: 'http://x/a' });
    l.get('b', { host: 'meteo', url: 'http://x/b' });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 35, `paced: ${times[1] - times[0]}ms apart`);
  });
});

describe('street-level map view', () => {
  it('fetches tiles and draws roads, buildings, mosques and names at street zoom', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(15) });
    app.render();
    assert.match(map.streetStatus, /streets/);
    await settle();
    assert.ok(map.streetFeatures.length > 200, `street features: ${map.streetFeatures.length}`);
    assert.ok(map.streetCounts.roads > 50);
    assert.ok(map.streetCounts.worship > 10);
    assert.ok(map.streetCounts.pois > 10);
    const t = text(app);
    assert.match(t, /STREET MAP/);
    assert.match(t, /STREETS/);
    assert.match(t, /☪/, 'mosque icons are on screen');
    assert.match(t, /OpenStreetMap contributors/);
    assert.match(t, /├─+┤ \d+ m/, 'scale bar');
    assert.match(t, /STREET LEVEL/, 'sidebar group');
    assert.doesNotMatch(t, /view error/);
  });
  it('hovers a mosque, pins it and opens details enriched with OpenStreetMap tags and links', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(15) });
    await settle();
    const mosque = map.drawn.points.find((p) => p.f.layer === 'worship');
    assert.ok(mosque, 'a mosque was drawn');
    const cx = map.mapRect.x + Math.floor(mosque.x / 2);
    const cy = map.mapRect.y + Math.floor(mosque.y / 4);
    mouse(app, 'move', cx, cy);
    assert.equal(map.hovered.layer, 'worship');
    assert.equal(map.hovered.kind, 'Mosque');
    app.render();
    assert.match(text(app), /PLACES OF WORSHIP · MOSQUE/);
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    assert.equal(map.pinned, map.hovered);
    key(app, 'enter');
    assert.ok(app.detail);
    assert.ok(app.detail.spec.links.length >= 3);
    await settle();
    const labels = app.detail.spec.links.map((l) => l.label);
    assert.ok(labels.includes('Website'), `website link merged from Overpass: ${labels}`);
    assert.ok(labels.includes('Wikipedia'));
    assert.ok(labels.includes('OSM object'));
    assert.ok(app.detail.spec.rows.some(([k, v]) => k === 'Opening hours' && /05:00/.test(v)));
    assert.match(text(app), /1 {2}Website: https:\/\/example\.org/);
    key(app, 'escape');
    assert.equal(app.detail, null);
  });
  it('looks up the address and weather of an empty spot and of a clicked area', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon + 0.03, lat: TABUK.lat + 0.03, zoom: map.zoomForTileZoom(16) });
    await settle();
    // Force an empty spot: clear the drawn index so the click lands on nothing.
    map.drawn = { points: [], lines: [], polys: [] };
    const cx = map.mapRect.x + 10;
    const cy = map.mapRect.y + 5;
    mouse(app, 'move', cx, cy);
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    assert.ok(map.pinned && map.pinned.layer === 'here');
    assert.match(map.pinned.name, /Looking up/);
    await settle();
    assert.equal(map.pinned.ready, true);
    assert.equal(map.pinned.name, 'King Faisal Road');
    assert.ok(map.pinned.info.some(([k, v]) => k === 'Weather now' && /31\.5°C/.test(v)));
    assert.ok(map.pinned.info.some(([k, v]) => k === 'Elevation' && v === '770 m'));
    assert.ok(map.pinned.links.some((l) => l.label === 'OSM object'));
    app.render();
    assert.match(text(app), /King Faisal Road/);
  });
  it('falls back to OpenStreetMap search and jumps to the result', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    key(app, '/');
    for (const ch of 'zzzz') key(app, ch);
    app.render();
    assert.match(text(app), /Enter searches OpenStreetMap/);
    key(app, 'enter');
    assert.ok(map.search, 'search stays open while the remote lookup runs');
    await settle();
    assert.equal(map.search.results[0].label, 'Prince Sultan Mosque');
    key(app, 'enter');
    assert.equal(map.search, null);
    assert.ok(Math.abs(map.view.lon - 36.56) < 0.01);
    app.render();
    assert.ok(map.tileZoom() >= 12, `zoomed to the result: z${map.tileZoom()}`);
    assert.equal(map.pinned.name, 'Prince Sultan Mosque');
  });
  it('shows Wikipedia articles and live aircraft around the view', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.toggleLayer('aircraftAll', true);
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(12) });
    await settle();
    assert.equal(map.streetCounts.wikipedia, 1);
    assert.equal(map.streetCounts.aircraftAll, 2);
    const wiki = map.streetFeatures.find((f) => f.layer === 'wikipedia');
    assert.equal(wiki.glyph, 'W');
    assert.equal(wiki.url, 'https://en.wikipedia.org/?curid=99');
    map.pin(wiki);
    key(app, 'enter');
    await settle();
    assert.match(app.detail.spec.body, /northwestern Saudi Arabia/);
    key(app, 'escape');
    const mil = map.streetFeatures.find((f) => f.id === 'adsb:mil1');
    assert.equal(mil.color, theme.accent2, 'military aircraft use the alert accent');
    assert.ok(mil.info.some(([k, v]) => k === 'Military' && v === 'yes'));
  });
  it('switches to Esri imagery tiles when zoomed in with satellite on', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(14) });
    key(app, 's');
    app.render();
    await settle();
    assert.match(map.imageryStatus, /Esri z14/);
    assert.ok(map.rasterTiles.stats().ready >= 1);
    const lines = app.screen.toLines();
    assert.ok(lines.some((l) => l.includes('▀')), 'half-block imagery cells');
    assert.match(text(app), /Esri, Maxar/);
    assert.match(text(app), /ESRI IMAGERY/);
  });
  it('zooms in on double-click and keeps street layers toggleable from the sidebar', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(13) });
    await settle();
    const z0 = map.view.zoom;
    map.drawn = { points: [], lines: [], polys: [] };
    const cx = map.mapRect.x + 20;
    const cy = map.mapRect.y + 10;
    mouse(app, 'move', cx, cy);
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    mouse(app, 'down', cx, cy);
    mouse(app, 'up', cx, cy);
    assert.ok(map.view.zoom > z0 * 2, 'double-click zoomed in');
    const before = map.streetCounts.worship;
    map.toggleLayer('worship', false);
    await settle();
    assert.equal(map.streetCounts.worship, undefined);
    assert.ok(before > 0);
    map.toggleLayer('worship', true);
    await settle();
    assert.ok(map.streetCounts.worship > 0);
    assert.doesNotMatch(text(app), /view error/);
  });
  it('leaves street mode when zoomed out', async () => {
    const { app, map, settle } = makeApp();
    app.render();
    map.setView({ mode: 'flat', lon: TABUK.lon, lat: TABUK.lat, zoom: map.zoomForTileZoom(14) });
    await settle();
    assert.ok(map.streetFeatures.length > 0);
    map.setView({ ...map.view, zoom: 1 });
    app.render();
    assert.equal(map.streetFeatures.length, 0);
    assert.match(text(app), /WORLD MAP/);
    assert.equal(STREET_LAYERS.length, 15);
  });
});
