// Satellite imagery for the map: NASA GIBS (Global Imagery Browse Services)
// serves public-domain Earth imagery through a keyless WMS endpoint. The map
// asks for exactly the viewport's bounding box at the cell resolution it
// paints, decodes the PNG and samples it into half-block colours. Images are
// cached per viewport and fetched with a small concurrency budget so panning
// never piles up requests.
import { decodePng } from './png.mjs';

export const GIBS_BASE_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

export const IMAGERY = [
  { id: 'bluemarble', label: 'Blue Marble', short: 'BLUE MARBLE', gibs: 'BlueMarble_ShadedRelief_Bathymetry', daily: false, credit: 'NASA Blue Marble NG' },
  { id: 'truecolor', label: 'VIIRS true colour (latest day)', short: 'TRUE COLOUR', gibs: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', daily: true, credit: 'NASA GIBS · VIIRS/SNPP' },
  { id: 'night', label: 'Black Marble night lights', short: 'NIGHT LIGHTS', gibs: 'VIIRS_Black_Marble', daily: false, credit: 'NASA Black Marble' },
];

export const IMAGERY_IDS = IMAGERY.map((i) => i.id);

export function imageryById(id) {
  return IMAGERY.find((i) => i.id === id) || IMAGERY[0];
}

export function nextImageryId(id, step = 1) {
  const i = Math.max(0, IMAGERY_IDS.indexOf(id));
  return IMAGERY_IDS[(i + step + IMAGERY_IDS.length) % IMAGERY_IDS.length];
}

// The latest complete day of a daily product (UTC yesterday).
export function latestDailyDate(now = Date.now()) {
  return new Date(now - 36 * 3600 * 1000).toISOString().slice(0, 10);
}

// WMS 1.3.0 with EPSG:4326 orders the bounding box lat,lon (south, west, north, east).
export function gibsUrl({ layer, bbox, width, height, time, base = GIBS_BASE_URL }) {
  const [w, s, e, n] = bbox.map((v) => Math.round(v * 1000) / 1000);
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: layer,
    CRS: 'EPSG:4326',
    BBOX: `${s},${w},${n},${e}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
  });
  if (time) q.set('TIME', time);
  return `${base}?${q.toString()}`;
}

// GIBS renders an uncached WMS request on demand: a 1080x540 Blue Marble globe
// took 61 s cold (1.7 s once cached), so a short timeout never lets it load.
// Quitting aborts in-flight fetches (close()), so the long wait never blocks exit.
export const IMAGERY_TIMEOUT_MS = 90000;

export class ImageryCache {
  constructor({ fetch = (...a) => globalThis.fetch(...a), now = () => Date.now(), maxEntries = 32, concurrency = 2, timeoutMs = IMAGERY_TIMEOUT_MS, base = GIBS_BASE_URL, onChange = () => {} } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.base = base;
    this.onChange = onChange;
    this.entries = new Map(); // key -> { status, image, error, at, slot }
    this.queue = [];
    this.active = 0;
    this.latest = new Map(); // slot -> key currently wanted
    this.bytes = 0;
    this.requests = 0;
  }

  key(req) {
    const bbox = req.bbox.map((v) => Math.round(v * 1000) / 1000).join(',');
    return `${req.layer}|${req.time || ''}|${bbox}|${req.width}x${req.height}`;
  }

  // Returns the cache entry for a request, starting a fetch when needed.
  // slot: 'view' | 'globe' | 'night' — only the newest request per slot is fetched.
  get(req, slot = 'view') {
    const key = this.key(req);
    const prevKey = this.latest.get(slot);
    this.latest.set(slot, key);
    if (prevKey && prevKey !== key) {
      // The viewport moved on: stop the old fetch so it does not hold a slot.
      const old = this.entries.get(prevKey);
      if (old && old.controller && ![...this.latest.values()].includes(prevKey)) {
        old.controller.abort();
        this.entries.delete(prevKey);
      }
    }
    let entry = this.entries.get(key);
    if (entry) {
      entry.at = this.now();
      if (entry.status === 'error' && this.now() - entry.failedAt > 30000) {
        this.entries.delete(key);
        entry = null;
      } else return entry;
    }
    entry = { status: 'loading', image: null, error: null, at: this.now(), slot, key, req };
    this.entries.set(key, entry);
    this.queue.push(entry);
    this.pump();
    this.evict();
    return entry;
  }

  peek(req) {
    return this.entries.get(this.key(req)) || null;
  }

  // Abort in-flight fetches so quitting does not wait out the request timeout.
  close() {
    this.closed = true;
    this.queue = [];
    for (const e of this.entries.values()) if (e.controller) e.controller.abort();
  }

  pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.pop(); // newest first
      if (this.latest.get(entry.slot) !== entry.key) {
        this.entries.delete(entry.key); // superseded before it started
        continue;
      }
      this.active += 1;
      this.load(entry).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  async load(entry) {
    const url = gibsUrl({ ...entry.req, base: this.base });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    entry.controller = controller;
    try {
      this.requests += 1;
      const res = await this.fetch(url, { signal: controller?.signal, headers: { Accept: 'image/png' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      this.bytes += buf.length;
      entry.image = decodePng(buf);
      entry.status = 'ready';
      entry.readyAt = this.now();
    } catch (err) {
      entry.status = 'error';
      entry.error = err && err.message ? err.message : String(err);
      entry.failedAt = this.now();
    } finally {
      if (timer) clearTimeout(timer);
      entry.controller = null;
      if (!this.closed) this.onChange(entry);
    }
  }

  evict() {
    if (this.entries.size <= this.maxEntries) return;
    const wanted = new Set(this.latest.values());
    const victims = [...this.entries.values()].filter((e) => !wanted.has(e.key) && e.status !== 'loading').sort((a, b) => a.at - b.at);
    for (const v of victims) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(v.key);
    }
  }

  stats() {
    const ready = [...this.entries.values()].filter((e) => e.status === 'ready').length;
    return { entries: this.entries.size, ready, loading: this.active + this.queue.length, requests: this.requests, bytes: this.bytes };
  }
}
