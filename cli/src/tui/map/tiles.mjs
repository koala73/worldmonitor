// Slippy-map tile caches: OpenFreeMap vector tiles (roads, buildings, places,
// points of interest, water…) and Esri World Imagery raster tiles for
// street-level satellite. Both are keyless. Requests are prioritised by the
// distance the caller supplies (centre first), limited in flight, and
// dropped when a frame no longer needs them.
import { decodeTile } from './pbf.mjs';
import { decodeJpeg } from './jpeg.mjs';
import { decodePng } from './png.mjs';

export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OPENFREEMAP_FALLBACK = 'https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf';
export const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_CREDIT = 'Esri, Maxar, Earthstar Geographics';
export const VECTOR_MAX_ZOOM = 14; // OpenFreeMap planet tiles stop at z14; deeper zooms overzoom them
export const RASTER_MAX_ZOOM = 19;

export const tileKey = (z, x, y) => `${z}/${x}/${y}`;

export class TileCache {
  constructor({ fetch = (...a) => globalThis.fetch(...a), now = () => Date.now(), decode, urlFor, maxEntries = 256, concurrency = 6, timeoutMs = 25000, onChange = () => {}, headers = {} } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.decode = decode;
    this.urlFor = urlFor;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.onChange = onChange;
    this.headers = headers;
    this.entries = new Map();
    this.active = 0;
    this.frame = 0;
    this.requests = 0;
    this.bytes = 0;
    this.failures = 0;
  }

  // Call once per frame before get(): requests not renewed this frame are dropped from the queue.
  beginFrame() {
    this.frame += 1;
  }

  get(z, x, y, priority = 0) {
    const key = tileKey(z, x, y);
    let e = this.entries.get(key);
    if (e) {
      e.at = this.now();
      e.frame = this.frame;
      e.priority = priority;
      if (e.status === 'error' && this.now() - e.failedAt > 60000) {
        this.entries.delete(key);
        e = null;
      } else return e;
    }
    e = { key, z, x, y, status: 'queued', value: null, error: null, at: this.now(), frame: this.frame, priority };
    this.entries.set(key, e);
    this.pump();
    this.evict();
    return e;
  }

  peek(z, x, y) {
    return this.entries.get(tileKey(z, x, y)) || null;
  }

  // Quitting aborts in-flight fetches so they never hold the process open.
  close() {
    this.closed = true;
    for (const e of this.entries.values()) if (e.controller) e.controller.abort();
  }

  pump() {
    while (!this.closed && this.active < this.concurrency) {
      let best = null;
      for (const e of this.entries.values()) {
        if (e.status !== 'queued') continue;
        if (e.frame !== this.frame) {
          this.entries.delete(e.key); // nobody wanted it in the current frame
          continue;
        }
        if (!best || e.priority < best.priority) best = e;
      }
      if (!best) return;
      best.status = 'loading';
      this.active += 1;
      this.load(best).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  async load(e) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    e.controller = controller;
    try {
      const url = await this.urlFor(e.z, e.x, e.y);
      this.requests += 1;
      const res = await this.fetch(url, { signal: controller?.signal, headers: this.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      this.bytes += buf.length;
      e.value = this.decode(buf);
      e.status = 'ready';
      e.readyAt = this.now();
    } catch (err) {
      e.status = 'error';
      e.error = err && err.message ? err.message : String(err);
      e.failedAt = this.now();
      this.failures += 1;
    } finally {
      if (timer) clearTimeout(timer);
      e.controller = null;
      if (!this.closed) this.onChange(e);
    }
  }

  evict() {
    if (this.entries.size <= this.maxEntries) return;
    const victims = [...this.entries.values()].filter((e) => e.frame !== this.frame && e.status !== 'loading').sort((a, b) => a.at - b.at);
    for (const v of victims) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(v.key);
    }
  }

  stats() {
    let ready = 0;
    let loading = 0;
    for (const e of this.entries.values()) {
      if (e.status === 'ready') ready++;
      else if (e.status === 'loading' || e.status === 'queued') loading++;
    }
    return { entries: this.entries.size, ready, loading, requests: this.requests, bytes: this.bytes, failures: this.failures };
  }
}

// Vector tiles: resolve the dated tile template from the TileJSON once.
export function createVectorTileCache({ fetch = (...a) => globalThis.fetch(...a), now, onChange, userAgent = '', tilejsonUrl = OPENFREEMAP_TILEJSON, template = null } = {}) {
  let resolved = template;
  let resolving = null;
  const headers = userAgent ? { 'User-Agent': userAgent } : {};
  const resolve = async () => {
    if (resolved) return resolved;
    if (!resolving) {
      resolving = (async () => {
        try {
          const res = await fetch(tilejsonUrl, { headers });
          const json = await res.json();
          resolved = Array.isArray(json.tiles) && json.tiles[0] ? json.tiles[0] : OPENFREEMAP_FALLBACK;
        } catch {
          resolved = OPENFREEMAP_FALLBACK;
        }
        return resolved;
      })();
    }
    return resolving;
  };
  return new TileCache({
    fetch,
    now,
    onChange,
    headers,
    maxEntries: 160,
    concurrency: 6,
    decode: decodeTile,
    urlFor: async (z, x, y) => (await resolve()).replace('{z}', z).replace('{x}', x).replace('{y}', y),
  });
}

// Raster imagery tiles (JPEG or PNG).
export function createRasterTileCache({ fetch = (...a) => globalThis.fetch(...a), now, onChange, userAgent = '', template = ESRI_IMAGERY } = {}) {
  const headers = userAgent ? { 'User-Agent': userAgent } : {};
  return new TileCache({
    fetch,
    now,
    onChange,
    headers,
    maxEntries: 320,
    concurrency: 6,
    decode: (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? decodePng(buf) : decodeJpeg(buf)),
    urlFor: async (z, x, y) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
  });
}
