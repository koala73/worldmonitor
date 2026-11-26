// Map view: a zoomable, pannable world map or globe with every layer the
// dashboard knows about, optional satellite imagery, hover highlighting with
// an info card, a layer picker sidebar, search and animations. Zooming in
// hands over to street level: OpenStreetMap vector tiles (roads, buildings,
// water, places, shops, places of worship, street names, house numbers),
// Esri imagery, Wikipedia articles and live aircraft around the view, and
// address / weather lookups for any point.
import { mix, strWidth, truncate } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { pulse } from '../ui/fx.mjs';
import { ListView, hit, panel } from '../ui/widgets.mjs';
import { imageryRequests, makeSampler } from '../map/backdrop.mjs';
import { DotCanvas } from '../map/canvas.mjs';
import { ImageryCache, IMAGERY, imageryById, latestDailyDate, nextImageryId } from '../map/imagery.mjs';
import { dayFactor, defaultView, destination, fmtCoord, lonLatToTile, makeProjector, normalizeView, panBy, subsolarPoint, tilesForBbox, wrapLon, zoomAt } from '../map/geo.mjs';
import { decodeWorld, renderGraticule, renderWorld, terminatorPoints, worldMask } from '../map/world.mjs';
import { LAYERS, LAYER_BY_ID, buildFeatures, layerSources } from '../map/layers.mjs';
import { groundTrack, propagate } from '../map/orbit.mjs';
import { pointInRing, polylineKm, segDist } from '../map/shapes.mjs';
import { rgb } from '../map/backdrop.mjs';
import { samplePixel } from '../map/png.mjs';
import { ESRI_CREDIT, RASTER_MAX_ZOOM, VECTOR_MAX_ZOOM, createRasterTileCache, createVectorTileCache } from '../map/tiles.mjs';
import { STREET_LAYERS, featureLinks, tileFeatures } from '../map/osm.mjs';
import { Lookups, shortAddress } from '../map/services.mjs';
import { isHttpUrl } from '../ui/detail.mjs';
import { ALL_LAYERS, LAYER_LABEL, STREET_LAYER_IDS, defaultAllLayers, drawCard, drawFooter, drawSearch, drawSidebar, drawToolbar, sidebarRows } from './map-panels.mjs';

const SIDEBAR_W = 34;
const PAN_STEP = 8;
const STREET_FROM = 4; // slippy-map zoom from which vector tiles are drawn
const RASTER_FROM = 8.5; // slippy-map zoom from which Esri imagery replaces NASA GIBS
// Highlighting a layer dims the others, except for the base map itself and
// "what's here" pins, which only highlight the one feature.
const NO_DIM_LAYERS = new Set(['country', 'here', 'roads', 'buildings', 'landuse', 'water', 'boundaries', 'streetNames', 'housenumbers', 'places', 'rail', 'aeroway']);
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export class MapView {
  constructor(app) {
    this.app = app;
    this.id = 'map';
    this.label = 'Map';
    const saved = (app.prefs && app.prefs.map) || {};
    this.view = normalizeView({ ...defaultView(), ...(saved.view || {}) }, 320, 160);
    this.layers = { ...defaultAllLayers(), ...(saved.layers || {}) };
    this.sat = Boolean(saved.sat);
    this.imagery = IMAGERY.some((i) => i.id === saved.imagery) ? saved.imagery : 'bluemarble';
    this.sidebar = saved.sidebar !== false;
    this.focus = 'map'; // 'map' | 'sidebar'
    this.sidebarList = new ListView();
    this.world = null;
    this.canvas = null;
    this.base = null;
    this.baseKey = '';
    this.hover = null; // { x, y } in cells, relative to the map rect
    this.hovered = null;
    this.pinned = null;
    this.drag = null;
    this.lastInteraction = app.now();
    this.rotate = true;
    this.search = null;
    this.features = [];
    this.counts = {};
    this.featureKey = '';
    this.dataVersion = 0;
    this.drawn = { points: [], lines: [], polys: [] };
    this.mapRect = rect(0, 0, 0, 0);
    const fetchImpl = app.fetchImpl || ((...a) => globalThis.fetch(...a));
    const now = () => app.now();
    const onChange = () => app.markDirty();
    this.imageryCache = new ImageryCache({ fetch: fetchImpl, now, onChange });
    this.imageryStatus = '';
    // Street level.
    this.vectorTiles = createVectorTileCache({ fetch: fetchImpl, now, onChange, userAgent: app.userAgent });
    this.rasterTiles = createRasterTileCache({ fetch: fetchImpl, now, onChange, userAgent: app.userAgent });
    this.lookups = new Lookups({ fetch: fetchImpl, now, onChange, userAgent: app.userAgent });
    this.street = null; // cached street canvas
    this.streetKey = '';
    this.streetDrawn = { points: [], lines: [], polys: [] };
    this.streetFeatures = [];
    this.streetCounts = {};
    this.streetTiles = [];
    this.streetStatus = '';
    this.tileFeatureCache = new Map();
    app.store.on('update', () => {
      this.dataVersion += 1;
    });
  }

  get store() {
    return this.app.store;
  }

  ensureWorld() {
    if (!this.world && this.app.catalog.world) this.world = decodeWorld(this.app.catalog.world);
    return this.world;
  }

  sources() {
    return ['fast', 'slow', ...layerSources(this.layers)];
  }

  mount() {
    this.syncWants(true);
  }

  unmount() {
    this.syncWants(false);
    this.persist();
  }

  syncWants(on) {
    for (const id of layerSources(this.layers)) if (this.store.sources[id]?.lazy) this.store.want(id, on);
  }

  // Called by the app on quit: save a moved or zoomed map, stop imagery fetches.
  dispose() {
    if (this.viewChanged) this.persist();
    this.imageryCache.close();
    this.vectorTiles.close();
    this.rasterTiles.close();
    this.lookups.close();
  }

  persist() {
    if (!this.app.prefs) return;
    this.viewChanged = false;
    this.app.prefs.map = { view: this.view, layers: this.layers, sat: this.sat, imagery: this.imagery, sidebar: this.sidebar };
    this.app.savePrefs(this.app.prefs);
  }

  touch() {
    this.lastInteraction = this.app.now();
    this.app.markDirty();
  }

  hints() {
    if (this.search) return 'type to search · Enter jump (OpenStreetMap search when nothing local matches) · Esc close';
    if (this.focus === 'sidebar') return '↑↓ layers  Space toggle  ←/→ back to map  L again: map focus / hide';
    if (this.streetActive()) return "wheel/+- zoom  drag pan  hover highlights  click: pin or what's here  Enter details  / search  s satellite";
    return '←→↑↓ pan  +/- zoom  g globe  s satellite  i imagery  L layers  / search  Enter details';
  }

  selectedUrl() {
    const f = this.pinned || this.hovered;
    if (!f) return null;
    if (isHttpUrl(f.url)) return f.url;
    const links = this.linksFor(f);
    return links.length ? links[0].url : null;
  }

  // Fractional slippy-map zoom of the flat map (-1 on the globe).
  tileZoom() {
    if (this.view.mode !== 'flat') return -1;
    const w = this.canvas ? this.canvas.w : 320;
    return Math.log2((w * this.view.zoom) / 256);
  }

  streetActive() {
    return this.tileZoom() >= STREET_FROM;
  }

  rasterActive() {
    return this.tileZoom() >= RASTER_FROM;
  }

  // View zoom at which a slippy-map zoom level is 1:1 with braille dots.
  zoomForTileZoom(z) {
    const w = this.canvas ? this.canvas.w : 320;
    return (256 * 2 ** z) / w;
  }

  // --- state changes -----------------------------------------------------------

  setView(v) {
    this.view = normalizeView(v, this.canvas ? this.canvas.w : 320, this.canvas ? this.canvas.h : 160);
    this.viewChanged = true;
    this.touch();
  }

  toggleMode() {
    const mode = this.view.mode === 'globe' ? 'flat' : 'globe';
    const zoom = mode === 'globe' ? Math.max(0.9, Math.min(4, this.view.zoom / 2.2)) : Math.max(1, Math.min(60, this.view.zoom * 2.2));
    this.setView({ ...this.view, mode, zoom });
    this.app.toast(mode === 'globe' ? 'globe view' : 'flat map');
    this.persist();
  }

  toggleSat() {
    this.sat = !this.sat;
    this.app.toast(this.sat ? `satellite imagery: ${this.rasterActive() ? ESRI_CREDIT : imageryById(this.imagery).label}` : 'satellite imagery off');
    this.touch();
    this.persist();
  }

  cycleImagery(step = 1) {
    this.imagery = nextImageryId(this.imagery, step);
    if (!this.sat) this.sat = true;
    this.app.toast(`imagery: ${imageryById(this.imagery).label}${this.rasterActive() ? ' (zoomed in: Esri imagery is used)' : ''}`);
    this.touch();
    this.persist();
  }

  toggleLayer(id, on) {
    const next = on === undefined ? !this.layers[id] : on;
    if (this.layers[id] === next) return;
    this.layers[id] = next;
    const src = LAYER_BY_ID.get(id)?.sources || [];
    // Another enabled layer may share the source, so ask the full enabled set.
    const needed = layerSources(this.layers);
    for (const s of src) if (this.store.sources[s]?.lazy) this.store.want(s, needed.includes(s));
    this.featureKey = '';
    this.baseKey = '';
    this.streetKey = '';
    if (this.pinned && this.pinned.layer === id && !next) this.pinned = null;
    this.touch();
    this.persist();
  }

  setAllLayers(on) {
    for (const l of ALL_LAYERS) if (l.kind !== 'overlay') this.toggleLayer(l.id, on);
  }

  resetLayers() {
    const d = defaultAllLayers();
    for (const l of ALL_LAYERS) this.toggleLayer(l.id, d[l.id]);
  }

  toggleGroup(groupId) {
    const members = ALL_LAYERS.filter((l) => l.group === groupId);
    const anyOff = members.some((l) => !this.layers[l.id]);
    for (const l of members) this.toggleLayer(l.id, anyOff);
  }

  pin(feature) {
    this.pinned = feature;
    this.touch();
  }

  centerOn(feature, minZoom = 6) {
    let zoom;
    if (this.view.mode === 'globe') zoom = Math.max(this.view.zoom, 2.5);
    else if (feature.streetZoom) zoom = Math.max(this.view.zoom, this.zoomForTileZoom(feature.streetZoom));
    else zoom = Math.max(this.view.zoom, minZoom);
    this.setView({ ...this.view, lon: feature.lon, lat: feature.lat, zoom });
  }

  // Links a feature's detail lists (http(s) only; feeds and OSM tags are untrusted).
  linksFor(f) {
    let links;
    if (f.links) links = f.links;
    else if (f.layer === 'country' || !Number.isFinite(f.lat)) links = f.url ? [{ label: 'Link', url: f.url }] : [];
    else {
      links = featureLinks(f);
      if (f.wiki) links.unshift({ label: 'Wikipedia article', url: f.url });
      else if (f.url && !STREET_LAYER_IDS.has(f.layer)) links.unshift({ label: 'Source', url: f.url });
    }
    return links.filter((l) => isHttpUrl(l.url));
  }

  openDetail(feature) {
    const f = feature || this.pinned || this.hovered;
    if (!f) return this.app.toast('hover or pin something on the map first', 1800, 'warn');
    const rows = [['Layer', f.layerLabel || LAYER_LABEL.get(f.layer) || f.layer], ['Position', fmtCoord(f.lat, f.lon)]];
    if (f.from && f.to) {
      rows.push(['From', `${f.fromName || fmtCoord(f.from[1], f.from[0])}`]);
      rows.push(['To', `${f.toName || fmtCoord(f.to[1], f.to[0])}`]);
      rows.push(['Length', `${Math.round(polylineKm(f.points)).toLocaleString('en-US')} km`]);
    }
    for (const [k, v] of f.info || []) rows.push([k, v]);
    const links = this.linksFor(f);
    this.app.openDetail({ title: f.name, subtitle: f.layerLabel || LAYER_LABEL.get(f.layer) || '', color: f.color, rows, links, url: links[0]?.url || null, onCenter: () => this.centerOn(f), featureId: f.id });
    this.detailFeature = f;
    this.detailMerged = new Set();
  }

  // Fill the open detail overlay with data that arrives later (OSM tags, Wikipedia summary, "what's here").
  refreshDetail() {
    const d = this.app.detail;
    const f = this.detailFeature;
    if (!d || !f || d.spec.featureId !== f.id) return;
    const spec = d.spec;
    const merged = this.detailMerged;
    const osmFeature = STREET_LAYER_IDS.has(f.layer) && f.layer !== 'wikipedia' && f.layer !== 'aircraftAll';
    if (osmFeature && f.name && !merged.has('tags')) {
      const e = this.lookups.tags(f.name, f.lat, f.lon, 120);
      if (e.status !== 'loading') {
        merged.add('tags');
        if (e.status === 'error') spec.rows.push(['OpenStreetMap tags', `lookup failed: ${e.error}`]);
        else {
          const el = (e.value || []).find((x) => x.tags && Object.keys(x.tags).length > 2) || (e.value || [])[0];
          if (el) {
            const tg = el.tags;
            const extra = [
              ['Address', [tg['addr:housenumber'], tg['addr:street'], tg['addr:city'], tg['addr:postcode']].filter(Boolean).join(' ')],
              ['Phone', tg.phone || tg['contact:phone']],
              ['Opening hours', tg.opening_hours],
              ['Cuisine', tg.cuisine],
              ['Religion', [tg.religion, tg.denomination].filter(Boolean).join(' · ')],
              ['Operator', tg.operator || tg.brand],
              ['Wheelchair', tg.wheelchair],
              ['Levels', tg['building:levels']],
              ['Capacity', tg.capacity],
              ['Description', tg.description],
              ['OpenStreetMap', `${el.type} ${el.id}`],
            ].filter(([, v]) => v);
            spec.rows = [...spec.rows, ...extra];
            const site = tg.website || tg['contact:website'] || tg.url;
            const links = [...(spec.links || [])];
            if (site) links.unshift({ label: 'Website', url: /^https?:/i.test(site) ? site : `https://${site}` });
            if (tg.wikipedia) links.push({ label: 'Wikipedia', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(tg.wikipedia.replace(/^en:/, ''))}` });
            if (tg.wikidata) links.push({ label: 'Wikidata', url: `https://www.wikidata.org/wiki/${encodeURIComponent(tg.wikidata)}` });
            links.push({ label: 'OSM object', url: `https://www.openstreetmap.org/${el.type}/${el.id}` });
            spec.links = links.filter((l) => isHttpUrl(l.url));
            spec.url = spec.links[0]?.url || null;
          } else spec.rows.push(['OpenStreetMap tags', 'no matching object within 120 m']);
        }
        this.app.markDirty();
      }
    }
    if (f.wiki && !merged.has('wiki')) {
      const e = this.lookups.wikiSummary(f.wiki);
      if (e.status !== 'loading') {
        merged.add('wiki');
        if (e.status === 'ready' && e.value) spec.body = e.value.extract || '';
        this.app.markDirty();
      }
    }
    if ((f.layer === 'here' || f.hereAt) && f.ready && !merged.has('here')) {
      merged.add('here');
      if (f.layer === 'here') spec.title = f.name;
      spec.rows = [['Position', fmtCoord(f.lat, f.lon)], ...f.info];
      spec.links = this.linksFor(f);
      spec.url = spec.links[0]?.url || null;
      this.app.markDirty();
    }
  }

  // --- "what's here": address, elevation and weather for any point ----------------

  whatsHere(lat, lon) {
    const f = { id: `here:${lat.toFixed(5)},${lon.toFixed(5)}`, layer: 'here', layerLabel: "what's here", name: 'Looking up this spot…', lat, lon, glyph: '⌖', color: this.app.theme.accent, size: 2, info: [], ready: false, streetZoom: 16 };
    f.links = featureLinks(f);
    this.pin(f);
    this.updateHere(f);
  }

  // Resolve a pending "what's here" (a pin, or an area / road clicked at a spot).
  updateHere(f) {
    if (!f || f.ready || (f.layer !== 'here' && !f.hereAt)) return;
    const at = f.hereAt || f;
    const rev = this.lookups.reverse(at.lat, at.lon, this.tileZoom() >= 15 ? 18 : 14);
    const wx = this.lookups.weather(at.lat, at.lon);
    if (rev.status === 'loading' || wx.status === 'loading') return;
    if (f.hereAt) {
      const extra = [];
      if (rev.status === 'ready' && rev.value) extra.push(['Address here', shortAddress(rev.value.address) || rev.value.display]);
      if (wx.status === 'ready' && wx.value) extra.push(['Weather now', `${wx.value.temperature}°C, ${wx.value.description}, wind ${wx.value.wind} km/h`]);
      f.info = [...(f.info || []), ...extra];
      f.ready = true;
      this.app.markDirty();
      return;
    }
    const info = [];
    if (rev.status === 'ready' && rev.value) {
      f.name = rev.value.name || shortAddress(rev.value.address) || 'Unnamed place';
      info.push(['Address', shortAddress(rev.value.address) || rev.value.display]);
      info.push(['What', rev.value.type]);
      if (rev.value.osmType && rev.value.osmId) f.osmLink = `https://www.openstreetmap.org/${rev.value.osmType}/${rev.value.osmId}`;
    } else f.name = `Point ${fmtCoord(f.lat, f.lon)}`;
    if (wx.status === 'ready' && wx.value) {
      const v = wx.value;
      info.push(['Weather now', `${v.temperature}°C (feels ${v.feelsLike}°C), ${v.description}, wind ${v.wind} km/h, humidity ${v.humidity}%`]);
      info.push(['Today', `${v.tmin}°C to ${v.tmax}°C · sunrise ${String(v.sunrise || '').slice(11, 16)} · sunset ${String(v.sunset || '').slice(11, 16)} (${v.timezone})`]);
      info.push(['Elevation', Number.isFinite(v.elevation) ? `${Math.round(v.elevation)} m` : '']);
      info.push(['Local time', v.time ? String(v.time).slice(11, 16) : '']);
    }
    f.info = info.filter(([, v]) => v);
    f.links = featureLinks(f);
    if (f.osmLink) f.links.push({ label: 'OSM object', url: f.osmLink });
    f.ready = true;
    this.app.markDirty();
  }

  // --- input ---------------------------------------------------------------------

  onKey(ev) {
    if (this.search) return this.onSearchKey(ev);
    const w = this.canvas ? this.canvas.w : 320;
    const h = this.canvas ? this.canvas.h : 160;
    const step = ev.shift ? PAN_STEP * 4 : PAN_STEP;
    if (this.focus === 'sidebar' && this.sidebar && this.sidebarShown !== false) {
      if (ev.name === 'left' || ev.name === 'h' || ev.name === 'right' || ev.name === 'l') {
        this.focus = 'map';
        this.touch();
        return true;
      }
      if (ev.name === 'enter' || ev.name === 'space') {
        const row = sidebarRows(this.streetActive())[this.sidebarList.selected];
        if (row?.layer) this.toggleLayer(row.layer.id);
        else if (row?.group) this.toggleGroup(row.group.id);
        return true;
      }
      if (this.sidebarList.handleKey(ev)) {
        this.touch();
        return true;
      }
    }
    switch (ev.name) {
      case 'left':
      case 'h':
        this.setView(panBy(this.view, w, h, step, 0));
        return true;
      case 'right':
      case 'l':
        this.setView(panBy(this.view, w, h, -step, 0));
        return true;
      case 'up':
      case 'k':
        this.setView(panBy(this.view, w, h, 0, step));
        return true;
      case 'down':
      case 'j':
        this.setView(panBy(this.view, w, h, 0, -step));
        return true;
      case '+':
      case '=':
        this.setView(zoomAt(this.view, w, h, ev.shift ? 4 : 1.5));
        return true;
      case '-':
      case '_':
        this.setView(zoomAt(this.view, w, h, ev.shift ? 1 / 4 : 1 / 1.5));
        return true;
      case 'g':
        this.toggleMode();
        return true;
      case 's':
        this.toggleSat();
        return true;
      case 'i':
        this.cycleImagery(ev.shift ? -1 : 1);
        return true;
      case 'I':
        this.cycleImagery(-1);
        return true;
      case 'd':
        this.toggleLayer('dayNight');
        return true;
      case 'L':
        // Cycle: hidden → layers panel focused → map focused (panel stays) → hidden.
        if (!this.sidebar) {
          this.sidebar = true;
          this.focus = 'sidebar';
        } else if (this.focus === 'sidebar') this.focus = 'map';
        else {
          this.sidebar = false;
          this.focus = 'map';
        }
        this.touch();
        this.persist();
        return true;
      case 'z':
      case 'home':
        this.setView({ ...defaultView(), mode: this.view.mode, zoom: 1 });
        return true;
      case 'c':
      case 'escape':
        if (this.pinned || this.hovered) {
          this.pinned = null;
          this.hovered = null;
          this.touch();
          return true;
        }
        return false;
      case 'enter':
        this.openDetail();
        return true;
      case 'p':
        this.rotate = !this.rotate;
        this.app.toast(this.rotate ? 'globe auto-rotate on' : 'globe auto-rotate paused');
        return true;
      case '/':
        this.search = { query: '', results: [], index: 0, remote: null, waiting: false, typedAt: this.app.now() };
        this.touch();
        return true;
      case 'n':
      case 'N':
        return this.cycleSearch(ev.name === 'n' ? 1 : -1);
      default:
        return false;
    }
  }

  onSearchKey(ev) {
    const sch = this.search;
    if (ev.name === 'escape') {
      this.search = null;
    } else if (ev.name === 'enter') {
      const hitItem = sch.results[sch.index];
      if (!hitItem && sch.query.trim().length >= 2) {
        // Nothing local: ask OpenStreetMap (results arrive asynchronously).
        sch.remote = this.lookups.search(sch.query.trim());
        sch.waiting = true;
        this.touch();
        return true;
      }
      this.lastResults = sch.results;
      this.lastIndex = sch.index;
      this.search = null;
      if (hitItem) this.jumpTo(hitItem);
    } else if (ev.name === 'backspace') {
      sch.query = sch.query.slice(0, -1);
      this.runSearch();
    } else if (ev.name === 'down' || (ev.ctrl && ev.name === 'n')) {
      sch.index = Math.min(sch.results.length - 1, sch.index + 1);
    } else if (ev.name === 'up' || (ev.ctrl && ev.name === 'p')) {
      sch.index = Math.max(0, sch.index - 1);
    } else if (ev.ch && !ev.ctrl && ev.ch.length === 1 && ev.name !== 'tab') {
      sch.query += ev.ch;
      this.runSearch();
    }
    this.touch();
    return true;
  }

  runSearch() {
    const sch = this.search;
    const q = sch.query.trim().toLowerCase();
    sch.index = 0;
    sch.remote = null;
    sch.waiting = false;
    sch.error = null;
    sch.typedAt = this.app.now();
    if (!q) {
      sch.results = [];
      return;
    }
    const world = this.ensureWorld();
    const results = [];
    for (const f of [...this.features, ...this.streetFeatures]) {
      const n = String(f.name || '').toLowerCase();
      if (n.includes(q)) results.push({ score: n.startsWith(q) ? 0 : 1, label: f.name, sub: f.layerLabel || LAYER_LABEL.get(f.layer) || f.layer, feature: f });
    }
    if (world) {
      for (const c of world.countries) {
        const n = String(c.name || '').toLowerCase();
        if (n.includes(q)) results.push({ score: n.startsWith(q) ? 0 : 2, label: c.name, sub: 'country', country: c });
      }
    }
    results.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
    sch.results = results.slice(0, 40);
  }

  // Ask OpenStreetMap when typing pauses on a query with no local match, and
  // merge its results (most important first: a city before a hamlet).
  pollRemoteSearch() {
    const sch = this.search;
    if (!sch) return;
    const q = sch.query.trim();
    if (!sch.remote && !sch.results.length && q.length >= 3 && this.app.now() - sch.typedAt > 900) {
      sch.remote = this.lookups.search(q);
      sch.waiting = true;
    }
    if (!sch.remote || !sch.waiting || sch.remote.status === 'loading') return;
    sch.waiting = false;
    if (sch.remote.status === 'error') {
      sch.error = sch.remote.error;
      return;
    }
    const remote = [...(sch.remote.value || [])].sort((a, b) => (b.importance || 0) - (a.importance || 0)).map((r) => ({ score: 5, label: r.name, sub: r.type.replace(/_/g, ' ') || 'place', remote: r, display: r.display }));
    const seen = new Set(sch.results.map((r) => r.label));
    sch.results = [...sch.results, ...remote.filter((r) => !seen.has(r.label))];
    this.app.markDirty();
  }

  cycleSearch(dir) {
    if (!this.lastResults || !this.lastResults.length) return false;
    this.lastIndex = (this.lastIndex + dir + this.lastResults.length) % this.lastResults.length;
    this.jumpTo(this.lastResults[this.lastIndex]);
    return true;
  }

  jumpTo(item) {
    if (item.feature) {
      this.pin(item.feature);
      this.centerOn(item.feature);
    } else if (item.country) {
      const [lon, lat] = item.country.centroid;
      this.pinned = null;
      this.setView({ ...this.view, lon, lat, zoom: this.view.mode === 'globe' ? Math.max(this.view.zoom, 1.6) : Math.max(this.view.zoom, 4) });
    } else if (item.remote) {
      const r = item.remote;
      // Zoom to the result's bounding box when it has one, otherwise to street level.
      let z = 15;
      if (r.bbox && r.bbox.length === 4 && r.bbox.every(Number.isFinite)) {
        const span = Math.max(Math.abs(r.bbox[1] - r.bbox[0]), Math.abs(r.bbox[3] - r.bbox[2]) * Math.cos((r.lat * Math.PI) / 180));
        z = Math.max(3, Math.min(17, Math.floor(Math.log2(360 / Math.max(span, 1e-5))) - 1));
      }
      this.setView({ ...this.view, mode: 'flat', lon: r.lon, lat: r.lat, zoom: this.zoomForTileZoom(z) });
      const f = { id: `remote:${r.osmType}/${r.osmId}`, layer: 'here', layerLabel: 'search result', name: r.name, lat: r.lat, lon: r.lon, glyph: '⌖', color: this.app.theme.accent, size: 2, info: [['What', item.sub], ['Address', r.display]], ready: true, streetZoom: z };
      f.links = featureLinks(f);
      if (r.osmType && r.osmId) f.links.push({ label: 'OSM object', url: `https://www.openstreetmap.org/${r.osmType}/${r.osmId}` });
      this.pin(f);
    }
    this.app.toast(`→ ${item.label}`);
  }

  // Mouse events inside the map area; returns true when handled.
  onMouse(ev) {
    const r = this.mapRect;
    const inside = ev.x >= r.x && ev.y >= r.y && ev.x < r.x + r.w && ev.y < r.y + r.h;
    const w = this.canvas ? this.canvas.w : 320;
    const h = this.canvas ? this.canvas.h : 160;
    if (ev.kind === 'move') {
      if (!inside) {
        if (this.hover) {
          this.hover = null;
          this.hovered = null;
          this.app.markDirty();
        }
        return false;
      }
      const cell = { x: ev.x - r.x, y: ev.y - r.y };
      // The footer coordinates and the crosshair follow the pointer.
      if (!this.hover || this.hover.x !== cell.x || this.hover.y !== cell.y) this.app.markDirty();
      this.hover = cell;
      const next = this.pick(cell.x, cell.y);
      if (next?.id !== this.hovered?.id) {
        this.hovered = next;
        this.app.markDirty();
      }
      this.lastInteraction = this.app.now();
      return true;
    }
    // The search box and info card are click targets of their own (app hits).
    const onOverlay = (this.overlayBoxes || []).some((b) => ev.x >= b.x && ev.y >= b.y && ev.x < b.x + b.w && ev.y < b.y + b.h);
    if (ev.kind === 'down' && ev.button === 0 && inside && !onOverlay) {
      this.drag = { x: ev.x, y: ev.y, moved: false, view: this.view };
      this.focus = 'map';
      this.touch();
      return true;
    }
    if (ev.kind === 'drag' && this.drag) {
      const dx = (ev.x - this.drag.x) * 2;
      const dy = (ev.y - this.drag.y) * 4;
      if (Math.abs(dx) + Math.abs(dy) >= 2) this.drag.moved = true;
      if (this.drag.moved) this.setView(panBy(this.drag.view, w, h, dx, dy));
      return true;
    }
    if (ev.kind === 'up' && this.drag) {
      const d = this.drag;
      this.drag = null;
      if (!d.moved && inside) {
        this.hover = { x: ev.x - r.x, y: ev.y - r.y };
        const f = this.pick(this.hover.x, this.hover.y);
        const now = this.app.now();
        const double = now - (this.lastClickAt || 0) < 500;
        const spot = this.proj ? this.proj.fromDot(this.hover.x * 2 + 1, this.hover.y * 4 + 2) : null;
        if (f && this.pinned && this.pinned.id === f.id && double) this.openDetail(f);
        else if (f && f.layer !== 'country') {
          this.pin(f);
          // Areas and roads at street zoom: also look up the address and weather at the clicked spot.
          if (this.tileZoom() >= 12 && spot && (f.rings || f.points) && !f.hereAt) f.hereAt = { lat: spot.lat, lon: spot.lon };
        } else if (double && spot) {
          // Double-click on empty map: zoom in on that spot.
          this.setView(zoomAt(this.view, w, h, 3, this.hover.x * 2 + 1, this.hover.y * 4 + 2));
        } else if (this.tileZoom() >= 10 && spot) this.whatsHere(spot.lat, spot.lon);
        else if (f) this.pin(f);
        else if (this.pinned) this.pinned = null;
        this.lastClickAt = now;
        this.touch();
      } else this.persist();
      return true;
    }
    if ((ev.kind === 'wheelup' || ev.kind === 'wheeldown') && inside) {
      const factor = ev.kind === 'wheelup' ? 1.25 : 1 / 1.25;
      this.setView(zoomAt(this.view, w, h, factor, (ev.x - r.x) * 2 + 1, (ev.y - r.y) * 4 + 2));
      return true;
    }
    return false;
  }

  // Nearest drawn feature to a cell: points first, then lines, then polygons.
  pick(cx, cy) {
    const px = cx * 2 + 1;
    const py = cy * 4 + 2;
    let best = null;
    let bestD = 4.5;
    for (const p of this.drawn.points) {
      const d = Math.hypot(p.x - px, (p.y - py) / 1.2) - (p.f.size || 0) * 0.4;
      if (d < bestD) {
        bestD = d;
        best = p.f;
      }
    }
    if (best) return best;
    bestD = 3;
    for (const l of this.drawn.lines) {
      if (px < l.minX - 3 || px > l.maxX + 3 || py < l.minY - 3 || py > l.maxY + 3) continue;
      for (const [x0, y0, x1, y1] of l.segs) {
        const d = segDist(px, py, x0, y0, x1, y1);
        if (d < bestD) {
          bestD = d;
          best = l.f;
        }
      }
    }
    if (best) return best;
    // Smallest polygon containing the point wins (a building inside a park).
    let bestArea = Infinity;
    for (const poly of this.drawn.polys) {
      if (poly.rings.some((ring) => pointInRing(px, py, ring))) {
        const area = poly.area ?? Infinity;
        if (!best || area < bestArea) {
          bestArea = area;
          best = poly.f;
        }
      }
    }
    if (best) return best;
    return this.countryAt(px, py);
  }

  countryAt(px, py) {
    const world = this.ensureWorld();
    if (!world || !this.proj) return null;
    const g = this.proj.fromDot(px, py);
    if (!g) return null;
    const v = worldMask(world).get(g.lon, g.lat);
    if (!v) return null;
    const c = world.countries[v - 1];
    if (!c) return null;
    const info = [];
    for (const l of LAYERS) {
      if (l.kind === 'choropleth' && this.layers[l.id] && l.countryInfo) {
        const rows = l.countryInfo(this.layerCtx())(c);
        if (rows) info.push(...rows);
      }
    }
    return { id: `country:${c.id}`, layer: 'country', layerLabel: 'country', name: c.name, lat: c.centroid[1], lon: c.centroid[0], glyph: '', color: this.app.theme.text, size: 0, info: [['ISO', c.a2 || '—'], ...info], country: c };
  }

  // --- data ----------------------------------------------------------------------

  layerCtx() {
    return { catalog: this.app.catalog, data: this.store.data, raw: this.store.raw, t: this.app.theme, now: this.app.now(), world: this.ensureWorld() };
  }

  refreshFeatures() {
    const enabled = Object.keys(this.layers).filter((k) => this.layers[k]).join(',');
    const key = `${this.dataVersion}|${enabled}|${this.app.theme.id}`;
    if (key === this.featureKey) return;
    this.featureKey = key;
    const { features, counts } = buildFeatures(this.layerCtx(), this.layers);
    this.features = features;
    this.counts = counts;
    // Countries, pins and street features are not part of this list: keep them.
    const keep = (f) => f && (f.layer === 'country' || f.layer === 'here' || STREET_LAYER_IDS.has(f.layer));
    if (this.pinned) this.pinned = features.find((f) => f.id === this.pinned.id) || (keep(this.pinned) ? this.pinned : null);
    if (this.hovered) this.hovered = features.find((f) => f.id === this.hovered.id) || (keep(this.hovered) ? this.hovered : null);
  }

  // Street-level features from the vector tiles covering the viewport, plus
  // the service layers (Wikipedia articles and aircraft around the centre).
  refreshStreet(proj, now) {
    const t = this.app.theme;
    if (proj.mode !== 'flat' || proj.tileZoom < STREET_FROM) {
      this.streetFeatures = [];
      this.streetCounts = {};
      this.streetStatus = '';
      this.streetTiles = [];
      return;
    }
    const tz = proj.tileZoom;
    const z = Math.max(0, Math.min(VECTOR_MAX_ZOOM, Math.floor(tz)));
    const tiles = tilesForBbox(proj.bbox(), z);
    const center = lonLatToTile(proj.center.lon, proj.center.lat, z);
    const dist = (tl) => Math.hypot(tl.xRaw + 0.5 - center.x, tl.y + 0.5 - center.y);
    tiles.sort((a, b) => dist(a) - dist(b));
    this.vectorTiles.beginFrame();
    const lod = Math.round(tz * 2) / 2;
    const enabledKey = STREET_LAYERS.map((l) => (this.layers[l.id] ? 1 : 0)).join('');
    const features = [];
    const counts = {};
    let ready = 0;
    let loading = 0;
    let failed = 0;
    const shown = tiles.slice(0, 24);
    for (const tile of shown) {
      const e = this.vectorTiles.get(tile.z, tile.x, tile.y, dist(tile));
      if (e.status === 'ready') {
        ready++;
        const key = `${e.key}|${lod}|${enabledKey}|${t.id}`;
        let list = this.tileFeatureCache.get(key);
        if (!list) {
          list = tileFeatures(e.value, tile.z, tile.x, tile.y, { t, tileZoom: tz, enabled: this.layers });
          this.tileFeatureCache.set(key, list);
          if (this.tileFeatureCache.size > 64) this.tileFeatureCache.delete(this.tileFeatureCache.keys().next().value);
        }
        for (const f of list) {
          counts[f.layer] = (counts[f.layer] || 0) + 1;
          features.push(f);
        }
      } else if (e.status === 'error') failed++;
      else loading++;
    }
    if (this.layers.wikipedia && tz >= 11) {
      const radius = Math.min(10000, Math.max(300, proj.metersPerDot * proj.w * 0.6));
      const e = this.lookups.wikiNearby(Math.round(proj.center.lat * 100) / 100, Math.round(proj.center.lon * 100) / 100, radius, 50);
      if (e.status === 'ready') {
        for (const a of e.value) {
          features.push({ id: `wiki:${a.pageid}`, layer: 'wikipedia', layerLabel: 'Wikipedia', name: a.title, lat: a.lat, lon: a.lon, glyph: 'W', color: t.accent3, size: 1, bold: true, wiki: a.pageid, url: a.url, streetZoom: 16, info: [['Article', a.title], ['Distance from view centre', `${Math.round(a.dist)} m`]] });
          counts.wikipedia = (counts.wikipedia || 0) + 1;
        }
      }
    }
    if (this.layers.aircraftAll && tz >= 6) {
      const nm = Math.min(250, Math.max(5, (proj.metersPerDot * proj.w * 0.6) / 1852));
      const e = this.lookups.aircraft(Math.round(proj.center.lat * 10) / 10, Math.round(proj.center.lon * 10) / 10, nm);
      if (e.status === 'ready') {
        for (const a of e.value) {
          features.push({
            id: `adsb:${a.hex}`, layer: 'aircraftAll', layerLabel: 'Aircraft (ADS-B)', name: `${a.flight || a.registration || a.hex}${a.type ? ` · ${a.type}` : ''}`,
            lat: a.lat, lon: a.lon, glyph: '✈', color: a.emergency ? t.bad : a.military ? t.accent2 : t.accent, size: a.emergency ? 3 : 1,
            heading: a.track, speedKt: a.groundSpeed, moving: !a.onGround, ts: e.at - (a.seen || 0) * 1000, pulse: Boolean(a.emergency), url: a.url,
            info: [['Flight', a.flight], ['Registration', a.registration], ['Aircraft', [a.type, a.description].filter(Boolean).join(' · ')], ['Altitude', a.onGround ? 'on the ground' : Number.isFinite(a.altitude) ? `${a.altitude.toLocaleString('en-US')} ft` : ''], ['Ground speed', Number.isFinite(a.groundSpeed) ? `${Math.round(a.groundSpeed)} kt` : ''], ['Track', Number.isFinite(a.track) ? `${Math.round(a.track)}°` : ''], ['Vertical rate', a.verticalRate ? `${a.verticalRate} ft/min` : ''], ['Squawk', a.squawk], ['Emergency', a.emergency], ['Military', a.military ? 'yes' : ''], ['Seen', `${Math.round(a.seen || 0)} s ago`]].filter(([, v]) => v),
          });
          counts.aircraftAll = (counts.aircraftAll || 0) + 1;
        }
      }
    }
    this.streetFeatures = features;
    this.streetCounts = counts;
    this.streetTiles = shown;
    const spin = SPIN[Math.floor(now / 80) % 10];
    this.streetStatus = loading ? `${spin} streets ${ready}/${ready + loading}` : failed && !ready ? 'street tiles unavailable' : `streets z${z}${tz > VECTOR_MAX_ZOOM ? ` (zoomed ×${(2 ** (tz - VECTOR_MAX_ZOOM)).toFixed(0)})` : ''}`;
    // Keep hovered / pinned street features pointing at the fresh objects.
    for (const k of ['pinned', 'hovered']) {
      const f = this[k];
      if (f && STREET_LAYER_IDS.has(f.layer)) this[k] = features.find((x) => x.id === f.id) || f;
    }
  }

  // --- rendering -----------------------------------------------------------------

  render(ctx, r) {
    const { s, t, now } = ctx;
    const world = this.ensureWorld();
    const showSidebar = this.sidebar && r.w >= 90;
    // Too narrow for the layer panel: keys stay with the map.
    this.sidebarShown = showSidebar;
    if (!showSidebar && this.focus === 'sidebar') this.focus = 'map';
    this.overlayBoxes = [];
    const [toolbarR, bodyR, footerR] = splitV(r, [1, 'fill', 1]);
    const [mapOuter, sideR] = showSidebar ? splitH(bodyR, ['fill', SIDEBAR_W]) : [bodyR, null];
    // Zoom level for this frame from the size the map will have inside its panel.
    const tz = this.view.mode === 'flat' && mapOuter.w > 4 ? Math.log2(((mapOuter.w - 2) * 2 * this.view.zoom) / 256) : -1;
    const street = tz >= STREET_FROM;
    const zoomText = this.view.mode === 'globe' ? `×${this.view.zoom.toFixed(1)}` : street ? `z${tz.toFixed(1)}` : `zoom ×${this.view.zoom < 10 ? this.view.zoom.toFixed(1) : Math.round(this.view.zoom)}`;
    const inner = panel(ctx, mapOuter, {
      title: `${this.view.mode === 'globe' ? 'Globe' : street ? 'Street map' : 'World map'} · ${this.sat ? (tz >= RASTER_FROM ? 'satellite' : imageryById(this.imagery).short) : 'tactical'}`,
      focused: this.focus === 'map',
      right: `${this.features.length + this.streetFeatures.length} features · ${zoomText}`,
      badge: this.app.anim && this.view.mode === 'globe' && this.rotate && !this.pinned && now - this.lastInteraction > 4000 ? 'ROTATING' : street ? 'STREETS' : null,
      badgeColor: street ? t.good : t.accent3,
    });
    this.mapRect = inner;
    if (!world || inner.w < 10 || inner.h < 4) {
      s.text(inner.x + 1, inner.y + 1, 'terminal too small for the map', { fg: t.dim, bg: t.panel });
      return;
    }
    if (!this.canvas || this.canvas.cols !== inner.w || this.canvas.rows !== inner.h) {
      this.canvas = new DotCanvas(inner.w, inner.h);
      this.base = new DotCanvas(inner.w, inner.h);
      this.street = new DotCanvas(inner.w, inner.h);
      this.baseKey = '';
      this.streetKey = '';
      this.view = normalizeView(this.view, this.canvas.w, this.canvas.h);
    }
    // Idle globe rotation.
    if (this.app.anim && this.view.mode === 'globe' && this.rotate && !this.pinned && !this.drag && now - this.lastInteraction > 4000) {
      this.view = normalizeView({ ...this.view, lon: this.view.lon + 0.12 }, this.canvas.w, this.canvas.h);
    }
    this.refreshFeatures();
    this.pollRemoteSearch();
    this.updateHere(this.pinned);
    this.refreshDetail();
    drawToolbar(this, ctx, toolbarR);
    this.drawMap(ctx, inner);
    if (showSidebar) drawSidebar(this, ctx, sideR);
    drawFooter(this, ctx, footerR);
    if (this.search) drawSearch(this, ctx, inner);
  }

  // --- the map itself ---------------------------------------------------------------

  drawMap(ctx, inner) {
    const { t, now } = ctx;
    const canvas = this.canvas;
    const proj = makeProjector(this.view, canvas.w, canvas.h);
    this.proj = proj;
    const world = this.world;
    const anim = this.app.anim;
    const sun = subsolarPoint(now);
    const night = Boolean(this.layers.dayNight);
    this.refreshStreet(proj, now);
    // From z8 the vector tiles draw land, water and borders themselves.
    const streetBase = proj.mode === 'flat' && proj.tileZoom >= 8;

    // Base: land fill, borders, graticule (cached per view).
    const choro = LAYERS.filter((l) => l.kind === 'choropleth' && this.layers[l.id]);
    const baseKey = [this.view.mode, this.view.lon.toFixed(5), this.view.lat.toFixed(5), this.view.zoom.toFixed(3), canvas.w, canvas.h, t.id, this.sat, this.layers.borders, this.layers.graticule, choro.map((c) => c.id).join(','), choro.length ? this.dataVersion : 0, streetBase].join('|');
    if (baseKey !== this.baseKey) {
      this.baseKey = baseKey;
      this.base.clear();
      const colorFns = choro.map((l) => l.countryColor(this.layerCtx()));
      const land = this.sat ? null : mix(t.mapDim, t.map, 0.22);
      const zoomed = this.view.mode === 'globe' ? this.view.zoom >= 1.6 : this.view.zoom >= 2.2;
      const fillColor = (country) => {
        for (const fn of colorFns) {
          const c = fn(country);
          if (c) return this.sat ? c : mix(t.panel, c, 0.55);
        }
        return land;
      };
      if (this.layers.graticule && !streetBase) renderGraticule(this.base, proj, mix(t.panel, t.muted, 0.7));
      if (!streetBase || choro.length) {
        renderWorld(this.base, proj, world, {
          fill: !this.sat || choro.length > 0,
          // At street zoom only the choropleth colours are drawn under the tiles.
          fillColor: streetBase ? (c) => (colorFns.length ? fillColor(c) : null) : fillColor,
          borders: Boolean(this.layers.borders) && !streetBase,
          coast: this.sat ? mix(t.map, '#ffffff', 0.25) : t.map,
          border: zoomed ? (this.sat ? mix(t.mapDim, '#ffffff', 0.35) : mix(t.mapDim, t.map, 0.45)) : null,
          outline: this.view.mode === 'globe' ? t.border : null,
          pattern: this.sat || streetBase ? 2 : 0,
        });
      }
    }
    canvas.copyFrom(this.base);

    // Street layer: re-rendered only when the view, the tiles or the focus change.
    const focusF = this.pinned || this.hovered;
    if (this.streetFeatures.length) {
      const readyKeys = this.streetTiles.map((tl) => (this.vectorTiles.peek(tl.z, tl.x, tl.y)?.status === 'ready' ? 1 : 0)).join('');
      const streetKey = [baseKey, readyKeys, this.streetFeatures.length, focusF ? focusF.id : '', this.sat].join('|');
      if (streetKey !== this.streetKey) {
        this.streetKey = streetKey;
        this.street.clear();
        this.streetDrawn = this.drawFeatures(ctx, this.street, proj, this.streetFeatures, { street: true, animate: false });
      }
      canvas.mergeFrom(this.street);
    } else {
      this.streetDrawn = { points: [], lines: [], polys: [] };
      this.streetKey = '';
    }

    // Radar sweep (flat, tactical, world scale).
    if (anim && this.view.mode === 'flat' && !this.sat && !streetBase) {
      const sweepX = Math.floor(((now / 40) % (canvas.cols + 24)) - 12);
      for (let dx = -10; dx <= 1; dx++) {
        const cx = sweepX + dx;
        if (cx < 0 || cx >= canvas.cols) continue;
        const f = dx >= 0 ? 1 : 1 + dx / 10;
        for (let cy = 0; cy < canvas.rows; cy++) {
          const ci = cy * canvas.cols + cx;
          if (canvas.code[ci] && canvas.pri[ci] <= 2) canvas.color[ci] = mix(canvas.color[ci] || t.map, t.scan, 0.75 * f);
        }
      }
    }

    // Terminator line.
    if (night && !streetBase) {
      const pts = terminatorPoints(sun);
      let prev = null;
      for (const [lon, lat] of pts) {
        const [x, y, vis] = proj.toDot(lon, lat);
        if (prev && vis && prev[2] && Math.abs(x - prev[0]) < canvas.w / 2) canvas.line(prev[0], prev[1], x, y, mix(t.accent3, t.panel, 0.3), 3, 3, Math.floor(now / 120));
        prev = [x, y, vis];
      }
    }

    const worldDrawn = this.drawFeatures(ctx, canvas, proj, this.features, { street: false, animate: anim });
    // The moving packet runs along the focused street feature only (not every road).
    if (anim && focusF && this.streetDrawn.lines.length) this.drawFlow(canvas, this.streetDrawn.lines, focusF, NO_DIM_LAYERS.has(focusF.layer) ? null : focusF.layer, now);
    this.drawn = { points: [...this.streetDrawn.points, ...worldDrawn.points], lines: [...this.streetDrawn.lines, ...worldDrawn.lines], polys: [...this.streetDrawn.polys, ...worldDrawn.polys] };
    if (this.pinned && this.pinned.layer === 'here') {
      const [x, y, vis] = proj.toDot(this.pinned.lon, this.pinned.lat);
      if (vis) {
        const cx = Math.floor(x / 2);
        const cy = Math.floor(y / 4);
        canvas.glyph(cx, cy, '⌖', anim ? mix(t.accent, '#ffffff', 0.3 + 0.4 * pulse(now, 700)) : t.accent, { pri: 40, attr: ATTR.BOLD });
        if (anim) canvas.circle(x, y, 3 + ((now % 1600) / 1600) * 6, mix(t.panel, t.accent, 1 - (now % 1600) / 1600), 6);
        canvas.label(cx, cy, truncate(visualText(this.pinned.name), 30), '#ffffff', { pri: 41, force: true, attr: ATTR.BOLD });
        this.drawn.points.push({ f: this.pinned, x, y });
      }
    }

    // Labels: country names when zoomed in (the tiles take over at street level).
    if (this.layers.labels && !streetBase && (this.view.zoom >= 2.2 || this.view.mode === 'globe')) {
      // Label the countries that are large enough for the current scale, biggest first.
      const scale = this.view.mode === 'globe' ? this.view.zoom * 2.5 : this.view.zoom;
      const minArea = scale >= 12 ? 0 : scale >= 6 ? 4 : scale >= 3.5 ? 25 : 90;
      let placed = 0;
      const candidates = world.countries.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area);
      for (const c of candidates) {
        if (placed > 50) break;
        const [lon, lat] = c.centroid;
        const [x, y, vis] = proj.toDot(lon, lat);
        if (!vis || x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) continue;
        const name = scale < 6 ? c.name.toUpperCase().slice(0, 16) : c.name.toUpperCase();
        if (canvas.label(Math.floor(x / 2) - Math.floor(name.length / 2), Math.floor(y / 4), name, mix(t.panel, t.dim, 0.9), { pri: -1 })) placed++;
      }
    }

    // Composite: imagery background and night shading.
    const background = this.sat ? (this.rasterActive() ? this.rasterBackground(proj, now) : this.backgroundFn(proj, canvas, now, night ? sun : null)) : null;
    const shade = night && !this.sat && !streetBase ? (cx, cy) => {
      const g = proj.fromDot(cx * 2 + 1, cy * 4 + 2);
      return g ? 0.55 + 0.45 * dayFactor(g.lat, g.lon, sun) : 1;
    } : null;
    canvas.blit(ctx, inner, { background, shade, nightColor: mix(t.panel, '#000000', 0.6), dotBg: streetBase && !this.sat ? mix(t.panel, t.bg, 0.5) : null });

    if (proj.mode === 'flat' && proj.tileZoom >= 6) this.drawMinimap(ctx, inner);
    // Hover / pin card.
    const f = this.pinned || this.hovered;
    if (f) drawCard(this, ctx, inner, f, Boolean(this.pinned));
    if (this.hover && this.app.anim && !this.drag) {
      // crosshair cursor
      const { s } = ctx;
      const cx = inner.x + this.hover.x;
      const cy = inner.y + this.hover.y;
      if (cx < inner.x + inner.w && cy < inner.y + inner.h) {
        const cell = s.cellAt ? s.cellAt(cx, cy) : null;
        if (cell && cell.ch === ' ') s.put(cx, cy, '┼', { fg: mix(t.accent, t.panel, 0.4), bg: cell.bg });
      }
    }
  }

  // Imagery sampler for the current frame: returns (cx, cy) -> { top, bottom } | null.
  // Cells are memoised until the view, the tiles, the sun or the theme change, so
  // a still map does not resample every cell on every frame.
  backgroundFn(proj, canvas, now, sun) {
    const t = this.app.theme;
    const dark = mix(t.panel, '#000000', 0.5);
    const layer = imageryById(this.imagery);
    const time = layer.daily ? latestDailyDate(now) : undefined;
    const base = this.view.mode === 'globe' ? 'globe' : 'view';
    const reqs = imageryRequests(this.view, proj, layer, time);
    const entries = reqs.map((req, i) => this.imageryCache.get(req, i ? `${base}2` : base));
    const nights = sun && layer.id !== 'night' ? reqs.map((req, i) => this.imageryCache.get({ ...req, layer: 'VIIRS_Black_Marble', time: undefined }, i ? 'night2' : 'night')) : [];
    const ready = entries.filter((e) => e.status === 'ready');
    const failed = entries.find((e) => e.status === 'error');
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 80) % 10];
    this.imageryStatus = ready.length === entries.length ? `${layer.short}${time ? ` ${time}` : ''}` : failed ? `imagery error: ${failed.error}` : `${spin} loading imagery`;
    let tiles = ready;
    let fade = 1;
    if (ready.length < entries.length) {
      // Keep the previous ready images of these slots underneath while the new ones load.
      const slots = new Set(entries.map((e) => e.slot));
      const prev = [...this.imageryCache.entries.values()].filter((e) => e.status === 'ready' && slots.has(e.slot) && e.req.layer === layer.gibs && !ready.includes(e)).sort((a, b) => b.at - a.at);
      tiles = [...ready, ...prev];
      if (!tiles.length) return () => ({ top: dark, bottom: dark });
    } else if (this.app.anim) fade = Math.min(1, (now - Math.max(...entries.map((e) => e.readyAt || now))) / 700);
    const nightTiles = nights.filter((e) => e.status === 'ready');
    const v = this.view;
    const key = [v.mode, v.lon, v.lat, v.zoom, canvas.w, canvas.h, t.panel, fade < 1 ? now : 'still', tiles.map((e) => e.key).join(';'), nightTiles.map((e) => e.key).join(';'), sun ? `${sun.lat.toFixed(1)},${sun.lon.toFixed(1)}` : ''].join('|');
    if (!this.bgMemo || this.bgMemo.key !== key) this.bgMemo = { key, cells: new Map() };
    const { cells } = this.bgMemo;
    const sample = this.sampler(tiles, proj, sun, nightTiles, fade);
    return (cx, cy) => {
      const i = cy * 65536 + cx;
      let cell = cells.get(i);
      if (cell === undefined) {
        cell = sample(cx, cy);
        cells.set(i, cell);
      }
      return cell;
    };
  }

  // tiles / nightTiles: ready cache entries, newest first (see map/backdrop.mjs).
  sampler(tiles, proj, sun, nightTiles, fade) {
    return makeSampler(this.app.theme, tiles, proj, sun, nightTiles, fade);
  }

  // Small world inset showing where the current view is; clicking it resets the view.
  drawMinimap(ctx, inner) {
    const { s, t } = ctx;
    const w = 26;
    const h = 8;
    if (inner.w < w + 6 || inner.h < h + 6) return;
    const mask = worldMask(this.world);
    const x0 = inner.x + inner.w - w - 1;
    const y0 = inner.y + 1;
    const box = rect(x0, y0, w, h + 1);
    this.overlayBoxes.push(box);
    s.fill(box, ' ', { bg: t.panel });
    const bits = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        let code = 0;
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const lon = -180 + ((cx * 2 + dx + 0.5) / (w * 2)) * 360;
            const lat = 80 - ((cy * 4 + dy + 0.5) / (h * 4)) * 150;
            if (mask.get(lon, lat)) code |= bits[dy][dx];
          }
        }
        if (code) s.put(x0 + cx, y0 + cy, String.fromCharCode(0x2800 + code), { fg: t.map, bg: t.panel });
      }
    }
    const mx = x0 + Math.floor(((this.view.lon + 180) / 360) * w);
    const my = y0 + Math.floor(((80 - Math.max(-70, Math.min(80, this.view.lat))) / 150) * h);
    s.put(Math.min(x0 + w - 1, Math.max(x0, mx)), Math.min(y0 + h - 1, Math.max(y0, my)), '◎', { fg: t.accent2, bg: t.panel, attr: ATTR.BOLD });
    s.text(x0, y0 + h, '└ you are here ┘'.padEnd(w, ' '), { fg: t.muted, bg: t.panel }, w);
    hit(ctx, box, { onClick: () => this.setView({ ...defaultView(), mode: this.view.mode, zoom: 1 }) });
  }

  // Street-level imagery: Esri World Imagery tiles, with already-loaded parent
  // tiles filling in while the sharper ones arrive.
  rasterBackground(proj, now) {
    const t = this.app.theme;
    const z = Math.max(0, Math.min(RASTER_MAX_ZOOM, Math.round(proj.tileZoom)));
    const tiles = tilesForBbox(proj.bbox(), z).slice(0, 30);
    const center = lonLatToTile(proj.center.lon, proj.center.lat, z);
    this.rasterTiles.beginFrame();
    let ready = 0;
    for (const tile of tiles) {
      const e = this.rasterTiles.get(tile.z, tile.x, tile.y, Math.hypot(tile.xRaw + 0.5 - center.x, tile.y + 0.5 - center.y));
      if (e.status === 'ready') ready++;
    }
    this.imageryStatus = ready === tiles.length ? `Esri z${z}` : `${SPIN[Math.floor(now / 80) % 10]} imagery ${ready}/${tiles.length}`;
    const dark = mix(t.panel, '#000000', 0.5);
    const n = 2 ** z;
    const sampleAt = (lon, lat) => {
      const tt = lonLatToTile(lon, lat, z);
      const ty = Math.floor(tt.y);
      if (ty < 0 || ty >= n) return null;
      const tx = ((Math.floor(tt.x) % n) + n) % n;
      let e = this.rasterTiles.peek(z, tx, ty);
      let u = tt.x - Math.floor(tt.x);
      let v = tt.y - ty;
      let fade = 1;
      if (!e || e.status !== 'ready') {
        // Walk up the pyramid for an already-loaded parent.
        let zz = z;
        let px = tt.x;
        let py = tt.y;
        e = null;
        while (zz > 0 && !e) {
          zz -= 1;
          px /= 2;
          py /= 2;
          const cand = this.rasterTiles.peek(zz, ((Math.floor(px) % 2 ** zz) + 2 ** zz) % 2 ** zz, Math.floor(py));
          if (cand && cand.status === 'ready') {
            e = cand;
            u = px - Math.floor(px);
            v = py - Math.floor(py);
          }
        }
        if (!e) return null;
      } else if (this.app.anim && e.readyAt) fade = Math.min(1, (now - e.readyAt) / 500);
      const px = samplePixel(e.value, u, v);
      if (!px) return null;
      const color = rgb(px);
      return fade < 1 ? mix(t.panel, color, fade) : color;
    };
    return (cx, cy) => {
      const gTop = proj.fromDot(cx * 2 + 1, cy * 4 + 1);
      const gBot = proj.fromDot(cx * 2 + 1, cy * 4 + 3);
      if (!gTop && !gBot) return null;
      const top = gTop ? sampleAt(gTop.lon, gTop.lat) : null;
      const bottom = gBot ? sampleAt(gBot.lon, gBot.lat) : null;
      if (!top && !bottom) return { top: dark, bottom: dark };
      return { top: top || dark, bottom: bottom || dark };
    };
  }

  // Screen paths for a lon/lat polyline: split at the horizon, duplicated
  // across the antimeridian while the world is small enough to repeat.
  projectPath(proj, canvas, pts) {
    const paths = [];
    let cur = [];
    let prevLon = null;
    let acc = 0;
    for (const [lon, lat] of pts) {
      if (prevLon !== null) {
        let d = lon - prevLon;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        acc += d;
      } else acc = wrapLon(lon - proj.center.lon);
      prevLon = lon;
      if (proj.mode === 'flat') {
        cur.push(proj.toDotRel(acc, lat));
      } else {
        const [x, y, vis] = proj.toDot(lon, lat);
        if (!vis) {
          if (cur.length > 1) paths.push(cur);
          cur = [];
          continue;
        }
        cur.push([x, y]);
      }
    }
    if (cur.length > 1) paths.push(cur);
    if (proj.mode === 'flat' && proj.wrapOffset < canvas.w * 4) {
      const extra = [];
      for (const path of paths) {
        let minX = Infinity;
        let maxX = -Infinity;
        for (const p of path) {
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
        }
        for (const off of [-proj.wrapOffset, proj.wrapOffset]) if (maxX + off >= 0 && minX + off < canvas.w) extra.push(path.map(([x, y]) => [x + off, y]));
      }
      paths.push(...extra);
    }
    return paths;
  }

  // Flowing packet along the focused feature (and, for world layers, its whole layer).
  drawFlow(canvas, lines, focusF, focusLayer, now) {
    const t = this.app.theme;
    for (const l of lines) {
      const f = l.f;
      const focused = f === focusF;
      if (!focused && (!focusLayer || f.layer !== focusLayer)) continue;
      const segs = l.segs;
      const total = segs.reduce((a, [x0, y0, x1, y1]) => a + Math.hypot(x1 - x0, y1 - y0), 0);
      if (total <= 4) continue;
      let target = ((now / (focused ? 1800 : 3600)) % 1) * total;
      for (const [x0, y0, x1, y1] of segs) {
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (target <= len) {
          const u = len ? target / len : 0;
          canvas.glyph(Math.floor((x0 + (x1 - x0) * u) / 2), Math.floor((y0 + (y1 - y0) * u) / 4), '●', focused ? '#ffffff' : f.color || t.accent, { pri: 20 });
          break;
        }
        target -= len;
      }
    }
  }

  // Draw a feature list into a canvas; returns the pick index { points, lines, polys }.
  // street: OpenStreetMap features (finer level of detail, labels by zoom).
  drawFeatures(ctx, canvas, proj, features, { street = false, animate = true } = {}) {
    const { t, now } = ctx;
    const anim = animate && this.app.anim;
    const focusF = this.pinned || this.hovered;
    const focusLayer = focusF && !NO_DIM_LAYERS.has(focusF.layer) ? focusF.layer : null;
    const tz = proj.mode === 'flat' ? proj.tileZoom : -1;
    const dimColor = mix(t.panel, t.dim, tz >= STREET_FROM ? 0.85 : 0.7);
    const points = [];
    const lines = [];
    const polys = [];
    const labels = [];
    const colorFor = (f) => {
      if (focusF && f === focusF) return anim ? mix(f.color || t.text, '#ffffff', 0.3 + 0.4 * pulse(now, 700)) : '#ffffff';
      if (focusLayer && f.layer !== focusLayer) return dimColor;
      return f.color || t.text;
    };
    const isFocused = (f) => focusF && f === focusF;
    const dimmed = (f) => focusLayer && f.layer !== focusLayer;
    const ringArea = (ring) => {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
      return Math.abs(a / 2);
    };

    // Polygons first; buildings above land use and water.
    const polygons = features.filter((f) => f.rings);
    if (street) polygons.sort((a, b) => (a.layer === 'buildings' ? 1 : 0) - (b.layer === 'buildings' ? 1 : 0));
    for (const f of polygons) {
      const color = colorFor(f);
      const screenRings = [];
      for (const ring of f.rings) for (const path of this.projectPath(proj, canvas, ring)) screenRings.push(path);
      if (!screenRings.length) continue;
      const focused = isFocused(f);
      if (f.fillOnly) {
        const fill = f.layer === 'water' ? mix(t.panel, color, this.sat ? 0.25 : 0.45) : f.layer === 'buildings' ? mix(t.panel, color, this.sat ? 0.3 : 0.5) : mix(t.panel, color, this.sat ? 0.18 : 0.3);
        const pattern = f.layer === 'water' ? (this.sat ? 3 : 1) : f.layer === 'buildings' ? 2 : 3;
        if (!this.sat || focused || f.layer === 'buildings') canvas.fillRings(screenRings, dimmed(f) ? mix(t.panel, dimColor, 0.5) : focused ? mix(t.panel, color, 0.7) : fill, focused ? 4 : f.layer === 'buildings' ? 3 : 2, focused ? 2 : pattern);
        if (focused || (f.layer === 'water' && tz >= 12)) for (const ring of screenRings) canvas.polyline(ring, focused ? color : mix(t.panel, color, 0.7), focused ? 4 : 2);
      } else {
        if (!this.sat || focused) canvas.fillRings(screenRings, dimmed(f) ? mix(t.panel, dimColor, 0.5) : mix(t.panel, color, focused ? 0.45 : 0.22), 3);
        for (const ring of screenRings) canvas.polyline([...ring, ring[0]], color, 4, focused ? 0 : 3, Math.floor(now / 150));
      }
      polys.push({ f, rings: screenRings, area: screenRings.reduce((a, r) => a + ringArea(r), 0) });
    }

    // Lines.
    for (const f of features) {
      if (!f.points || f.points.length < 2 || f.rings) continue;
      const color = colorFor(f);
      const focused = isFocused(f);
      const dash = focused ? 0 : f.dash || 0;
      const phase = anim && (f.flow || focused) ? Math.floor(now / 90) : 0;
      const paths = this.projectPath(proj, canvas, f.points);
      const segs = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const weight = f.size || 0;
      const pri = street ? (f.layer === 'roads' ? 5 + Math.min(2, weight) : 4) : 5;
      for (const path of paths) {
        canvas.polyline(path, color, focused ? 9 : pri, dash, phase);
        if (weight >= 2 && !dimmed(f)) canvas.polyline(path.map(([x, y]) => [x, y + 1]), color, pri, dash, phase);
        if (weight >= 2 && street && tz >= 15 && !dimmed(f)) canvas.polyline(path.map(([x, y]) => [x + 1, y]), color, pri, dash, phase);
        for (let i = 1; i < path.length; i++) {
          segs.push([path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]]);
          minX = Math.min(minX, path[i - 1][0], path[i][0]);
          maxX = Math.max(maxX, path[i - 1][0], path[i][0]);
          minY = Math.min(minY, path[i - 1][1], path[i][1]);
          maxY = Math.max(maxY, path[i - 1][1], path[i][1]);
        }
      }
      if (!segs.length) continue;
      lines.push({ f, segs, minX, maxX, minY, maxY });
      if (!street && anim && (focused || (focusLayer && f.layer === focusLayer))) this.drawFlow(canvas, [{ f, segs }], focusF, focusLayer, now);
      if (focused && f.nodes) {
        for (const nd of f.nodes) {
          const [x, y, vis] = proj.toDot(nd.lon, nd.lat);
          if (!vis) continue;
          canvas.glyph(Math.floor(x / 2), Math.floor(y / 4), '○', '#ffffff', { pri: 19 });
        }
      }
    }

    // Satellite ground track for the focused satellite.
    if (!street && focusF && focusF.tle) {
      const track = groundTrack(focusF.tle, now, { back: 45, ahead: 95, stepMin: 1 });
      for (const path of this.projectPath(proj, canvas, track)) canvas.polyline(path, mix(focusF.color || t.accent3, t.panel, 0.2), 6, 3, anim ? Math.floor(now / 120) : 0);
    }

    // Points (sorted so important features draw last / on top). At world scale
    // glyphs are reserved for important features; the rest are dots.
    const zoom = this.view.mode === 'globe' ? this.view.zoom * 2.5 : this.view.zoom;
    const glyphMinSize = street ? 0 : zoom < 2.5 ? 2 : zoom < 7 ? 1 : 0;
    const sorted = features.filter((f) => !f.rings && !(f.points && f.points.length >= 2));
    sorted.sort((a, b) => (a.size || 0) - (b.size || 0));
    // Tiles overlap at their edges, so the same named point can arrive twice.
    const seenLabels = new Map();
    const duplicate = (f, x, y) => {
      if (!street || !f.name) return false;
      const key = `${f.layer}|${f.name}`;
      const prev = seenLabels.get(key);
      if (prev && Math.abs(prev[0] - x) < 24 && Math.abs(prev[1] - y) < 12) return true;
      seenLabels.set(key, [x, y]);
      return false;
    };
    for (const f of sorted) {
      let lat = f.lat;
      let lon = f.lon;
      if (f.tle) {
        const p = propagate(f.tle, now);
        lat = p.lat;
        lon = p.lon;
      } else if (f.moving && Number.isFinite(f.heading) && Number.isFinite(f.speedKt) && f.ts && this.app.anim) {
        const ageH = Math.min(10 / 60, Math.max(0, (now - f.ts) / 3600e3));
        const d = destination(lat, lon, f.heading, f.speedKt * 1.852 * ageH);
        lat = d.lat;
        lon = d.lon;
      }
      const [x, y, vis] = proj.toDot(lon, lat);
      if (!vis || x < -2 || y < -2 || x >= canvas.w + 2 || y >= canvas.h + 2) continue;
      const focused = isFocused(f);
      if (!focused && duplicate(f, x, y)) continue;
      const color = colorFor(f);
      const cx = Math.floor(x / 2);
      const cy = Math.floor(y / 4);
      points.push({ f, x, y });
      const size = f.size || 0;
      if (f.labelOnly) {
        // Street names, house numbers: text only, centred on the point.
        const txt = truncate(visualText(f.upper ? f.name.toUpperCase() : f.name), 28);
        labels.push({ cx: cx - Math.floor(strWidth(txt) / 2) - 2, cy, txt, color: focused ? '#ffffff' : color, rank: focused ? 100 : f.layer === 'housenumbers' ? -5 : 1 + size * 3, focused, attr: focused || size >= 2 ? ATTR.BOLD : 0 });
        continue;
      }
      if (size < glyphMinSize && !focused && !(focusLayer && f.layer === focusLayer)) {
        canvas.dot(x, y, color, 8);
        if (size >= 1) {
          canvas.dot(x + 1, y, color, 8);
          canvas.dot(x, y + 1, color, 8);
        }
        continue;
      }
      let glyph = f.glyph || '•';
      if (f.pulse && anim && !dimmed(f) && Math.floor(now / 500) % 2 === 1) glyph = size >= 2 ? '◎' : '◌';
      canvas.glyph(cx, cy, glyph, color, { pri: 10 + size + (focused ? 10 : 0) + (f.bold ? 1 : 0), attr: focused || size >= 2 || f.bold ? ATTR.BOLD : 0 });
      if (f.ring && anim && !dimmed(f)) {
        const r = ((now - (f.ts || now)) % 2400) / 2400;
        canvas.circle(x, y, 2 + r * 10, mix(t.panel, color, 1 - r), 6);
      }
      if (Number.isFinite(f.heading) && f.moving && !dimmed(f)) {
        const a = (f.heading - 90) * (Math.PI / 180);
        canvas.line(x + Math.cos(a) * 2, y + Math.sin(a) * 2, x + Math.cos(a) * 5, y + Math.sin(a) * 5, color, 7);
      }
      const wantLabel = focused || f.labelAlways || (street ? (f.layer === 'worship' && tz >= 13) || (size >= 2 && tz >= 12) || (size >= 1 && tz >= 15) || tz >= 17 : (size >= 2 && this.view.zoom >= 4 && !focusLayer) || (focusLayer && f.layer === focusLayer && this.view.zoom >= 3));
      if (wantLabel && f.name) {
        const txt = truncate(visualText(f.upper ? f.name.toUpperCase() : f.name), street ? 26 : 24);
        labels.push({ cx, cy, txt, color: focused ? '#ffffff' : color, rank: focused ? 100 : (f.labelAlways ? 20 : 0) + (f.layer === 'worship' ? 15 : 0) + size * 5 + (f.bold ? 2 : 0), focused, attr: focused || f.bold || (street && size >= 2) ? ATTR.BOLD : 0 });
      }
    }
    // Labels go last, most important first, so icons never overwrite text and
    // collisions drop the least important names.
    labels.sort((a, b) => b.rank - a.rank);
    for (const l of labels) canvas.label(l.cx, l.cy, l.txt, l.color, { pri: l.focused ? 30 : 9, force: l.focused, attr: l.attr });
    return { points, lines, polys };
  }
}

// Terminals do not apply the bidirectional algorithm, so purely right-to-left
// text (Arabic, Hebrew, Persian, Urdu) would read backwards: reverse it into
// visual order. Mixed strings are left alone.
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LTR = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/;
export function visualText(text) {
  const str = String(text || '');
  if (!RTL.test(str) || LTR.test(str)) return str;
  return [...str].reverse().join('');
}
