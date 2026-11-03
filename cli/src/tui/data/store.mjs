// Data store: declares every remote source, loads them on a schedule, merges
// bootstrap keys into one `data` object and notifies listeners. Lazy sources
// (military flights, vessels) load only while a view asks for them.
import { EventEmitter } from 'node:events';

const MIN = 60000;

export const SOURCES = {
  fast: { label: 'fast tier', path: '/api/bootstrap?tier=fast&public=1', every: MIN, bootstrap: true },
  slow: { label: 'slow tier', path: '/api/bootstrap?tier=slow&public=1', every: 5 * MIN, bootstrap: true },
  cyberThreats: { label: 'cyber threats', path: '/api/bootstrap?keys=cyberThreats&public=1', every: 2 * MIN, bootstrap: true },
  liveVideoResolved: { label: 'live video ids', path: '/api/bootstrap?keys=liveVideoResolved&public=1', every: 10 * MIN, bootstrap: true },
  flightDelays: { label: 'airport delays', path: '/api/bootstrap?keys=flightDelays&public=1', every: 2 * MIN, bootstrap: true },
  forecasts: { label: 'forecasts', path: '/api/bootstrap?keys=forecasts&public=1', every: 5 * MIN, bootstrap: true },
  correlationCards: { label: 'correlations', path: '/api/bootstrap?keys=correlationCards&public=1', every: 5 * MIN, bootstrap: true },
  digest: { label: 'news digest', path: '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', every: 2 * MIN },
  health: { label: 'health', path: '/api/health?compact=1', every: 2 * MIN },
  version: { label: 'version', path: '/api/version', every: 60 * MIN },
  flights: {
    label: 'military flights',
    path: '/api/military/v1/list-military-flights?ne_lat=85&ne_lon=180&sw_lat=-85&sw_lon=-180',
    every: MIN,
    auth: 'session',
    lazy: true,
  },
  vessels: { label: 'vessel snapshot', path: '/api/maritime/v1/get-vessel-snapshot', every: 2 * MIN, auth: 'session', lazy: true },
  satellites: { label: 'satellite elements', path: '/api/intelligence/v1/list-satellites?country=', every: 30 * MIN, auth: 'session', lazy: true },
  // Map-only registries (on-demand bootstrap keys), loaded while their layer is on.
  pipelinesGas: { label: 'gas pipeline status', path: '/api/bootstrap?keys=pipelinesGas&public=1', every: 15 * MIN, bootstrap: true, lazy: true },
  pipelinesOil: { label: 'oil pipeline status', path: '/api/bootstrap?keys=pipelinesOil&public=1', every: 15 * MIN, bootstrap: true, lazy: true },
  storageFacilities: { label: 'energy storage', path: '/api/bootstrap?keys=storageFacilities&public=1', every: 30 * MIN, bootstrap: true, lazy: true },
  energyDisruptions: { label: 'energy disruptions', path: '/api/bootstrap?keys=energyDisruptions&public=1', every: 15 * MIN, bootstrap: true, lazy: true },
  canadaRoads: { label: 'canada roads', path: '/api/bootstrap?keys=canadaRoads&public=1', every: 15 * MIN, bootstrap: true, lazy: true },
};

// Sources loaded during the boot sequence, in order of usefulness.
export const BOOT_ORDER = ['fast', 'digest', 'slow', 'cyberThreats', 'liveVideoResolved', 'forecasts', 'correlationCards', 'flightDelays', 'health', 'version'];

export class Store extends EventEmitter {
  constructor(client, { now = () => Date.now(), sources = SOURCES } = {}) {
    super();
    this.client = client;
    this.now = now;
    this.sources = sources;
    this.data = {}; // merged bootstrap payloads by key
    this.raw = {}; // non-bootstrap payloads by source id
    this.meta = {}; // per source: { loadedAt, error, loading, attempts }
    this.wanted = new Set(); // lazy sources currently requested
    this.timer = null;
    this.stopped = false;
    for (const id of Object.keys(sources)) this.meta[id] = { loadedAt: 0, retryAt: 0, error: null, loading: false, attempts: 0 };
  }

  // Load one source. Resolves to true when the data changed.
  async refresh(id, { force = false } = {}) {
    const src = this.sources[id];
    const m = this.meta[id];
    if (!src || !m || m.loading) return false;
    if (!force && m.retryAt && this.now() < m.retryAt) return false;
    if (!force && !m.retryAt && m.loadedAt && this.now() - m.loadedAt < src.every) return false;
    m.loading = true;
    this.emit('loading', id);
    try {
      const body = await this.client.getJson(src.path, { auth: src.auth || 'none' });
      if (src.bootstrap) {
        const payload = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : {};
        for (const [key, value] of Object.entries(payload)) {
          if (value !== null && value !== undefined) this.data[key] = value;
        }
        if (Array.isArray(body?.missing) && body.missing.length) m.missing = body.missing;
      } else {
        this.raw[id] = body;
      }
      m.loadedAt = this.now();
      m.retryAt = 0;
      m.error = null;
      m.attempts = 0;
      this.emit('update', id);
      return true;
    } catch (err) {
      m.error = err && err.message ? err.message : String(err);
      m.attempts += 1;
      // Back off before the next attempt; loadedAt keeps the last success.
      m.retryAt = this.now() + Math.min(src.every, 15000 * m.attempts);
      // 'error' throws on an EventEmitter with no listener; the failure is already in meta.
      if (this.listenerCount('error')) this.emit('error', id, m.error);
      return false;
    } finally {
      m.loading = false;
    }
  }

  // Boot: load sources in order, reporting progress 0..1.
  async boot(onProgress = () => {}) {
    let done = 0;
    const total = BOOT_ORDER.length;
    for (const id of BOOT_ORDER) {
      if (this.stopped) return; // the dashboard quit mid-boot
      await this.refresh(id, { force: true });
      done += 1;
      onProgress(done / total, id);
    }
  }

  want(id, on = true) {
    if (on) {
      if (!this.wanted.has(id)) {
        this.wanted.add(id);
        this.refresh(id).catch(() => {});
      }
    } else {
      this.wanted.delete(id);
    }
  }

  tick() {
    for (const [id, src] of Object.entries(this.sources)) {
      if (src.lazy && !this.wanted.has(id)) continue;
      this.refresh(id).catch(() => {});
    }
  }

  start(intervalMs = 5000) {
    this.stop();
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  // Age in ms of a source's last successful load, or Infinity.
  age(id) {
    const m = this.meta[id];
    return m && m.loadedAt ? this.now() - m.loadedAt : Infinity;
  }

  get(key, fallback = undefined) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  status() {
    const ids = Object.keys(this.sources);
    const loaded = ids.filter((id) => this.meta[id].loadedAt && !this.meta[id].error).length;
    const errors = ids.filter((id) => this.meta[id].error);
    const loading = ids.filter((id) => this.meta[id].loading);
    return { loaded, total: ids.length, errors, loading };
  }
}
