// Keyless lookup services the street-level map uses on demand: Nominatim
// (addresses, place search), Overpass (full OpenStreetMap tags for a place),
// Open-Meteo (weather and elevation at a point), Wikipedia (articles nearby
// and summaries) and adsb.lol (live aircraft around a point). Every call goes
// through one cache with per-host pacing so the free services are never hammered.

export const HOSTS = {
  nominatim: { base: 'https://nominatim.openstreetmap.org', minIntervalMs: 1100 },
  overpass: { base: 'https://overpass-api.de/api/interpreter', minIntervalMs: 1500 },
  meteo: { base: 'https://api.open-meteo.com/v1', minIntervalMs: 250 },
  wikipedia: { base: 'https://en.wikipedia.org/w/api.php', minIntervalMs: 300 },
  adsb: { base: 'https://api.adsb.lol/v2', minIntervalMs: 2000 },
};

export class Lookups {
  constructor({ fetch = (...a) => globalThis.fetch(...a), now = () => Date.now(), userAgent = 'worldmonitor-tui', onChange = () => {}, hosts = HOSTS, retryDelayMs = 1500 } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.userAgent = userAgent;
    this.onChange = onChange;
    this.hosts = hosts;
    this.entries = new Map();
    this.lastCall = {};
    this.queues = {};
    this.requests = 0;
    this.retryDelayMs = retryDelayMs;
  }

  // Returns { status: 'loading' | 'ready' | 'error', value, error }.
  get(key, { host, url, body, parse, ttlMs = 10 * 60000 }) {
    let e = this.entries.get(key);
    if (e) {
      if (e.status === 'ready' && this.now() - e.at < ttlMs) return e;
      if (e.status === 'loading') return e;
      if (e.status === 'error' && this.now() - e.at < 30000) return e;
    }
    e = { key, status: 'loading', value: null, error: null, at: this.now(), host };
    this.entries.set(key, e);
    this.schedule(host, async () => {
      try {
        const request = () => {
          this.requests += 1;
          return this.fetch(url, {
            method: body ? 'POST' : 'GET',
            headers: { 'User-Agent': this.userAgent, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            body,
          });
        };
        let res = await request();
        if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) {
          // Busy public servers: try once more after a short pause.
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          res = await request();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        e.value = parse ? parse(json) : json;
        e.status = 'ready';
      } catch (err) {
        e.status = 'error';
        e.error = err && err.message ? err.message : String(err);
      } finally {
        e.at = this.now();
        if (!this.closed) this.onChange(e);
      }
    });
    return e;
  }

  peek(key) {
    return this.entries.get(key) || null;
  }

  // Quitting drops queued lookups so they never hold the process open.
  close() {
    this.closed = true;
    for (const q of Object.values(this.queues)) q.tasks.length = 0;
  }

  // Per-host serial queue with a minimum interval between calls.
  schedule(host, task) {
    if (this.closed) return;
    const q = this.queues[host] || (this.queues[host] = { tasks: [], running: false });
    q.tasks.push(task);
    if (!q.running) this.drain(host);
  }

  async drain(host) {
    const q = this.queues[host];
    q.running = true;
    const minInterval = this.hosts[host]?.minIntervalMs || 0;
    while (q.tasks.length) {
      const wait = minInterval - (this.now() - (this.lastCall[host] || 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall[host] = this.now();
      const task = q.tasks.shift();
      await task();
    }
    q.running = false;
  }

  // --- Nominatim ---------------------------------------------------------------

  search(query, limit = 8) {
    const q = String(query || '').trim();
    if (!q) return { status: 'ready', value: [] };
    const url = `${this.hosts.nominatim.base}/search?format=jsonv2&addressdetails=1&accept-language=en&limit=${limit}&q=${encodeURIComponent(q)}`;
    return this.get(`search:${q.toLowerCase()}`, { host: 'nominatim', url, ttlMs: 60 * 60000, parse: (json) => (Array.isArray(json) ? json : []).map((r) => ({ name: r.name || r.display_name.split(',')[0], display: r.display_name, lat: Number(r.lat), lon: Number(r.lon), type: `${r.category || r.class || ''}${r.type ? ` / ${r.type}` : ''}`, osmType: r.osm_type, osmId: r.osm_id, importance: r.importance, bbox: r.boundingbox && r.boundingbox.map(Number) })) });
  }

  reverse(lat, lon, zoom = 18) {
    const key = `rev:${lat.toFixed(4)},${lon.toFixed(4)},${zoom}`;
    const url = `${this.hosts.nominatim.base}/reverse?format=jsonv2&addressdetails=1&accept-language=en&zoom=${zoom}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
    return this.get(key, { host: 'nominatim', url, ttlMs: 60 * 60000, parse: (r) => (r && r.display_name ? { name: r.name || r.display_name.split(',')[0], display: r.display_name, type: `${r.category || ''}${r.type ? ` / ${r.type}` : ''}`, osmType: r.osm_type, osmId: r.osm_id, address: r.address || {} } : null) });
  }

  // --- Overpass: full tags for a named feature near a point ----------------------

  tags(name, lat, lon, radiusM = 80) {
    const n = String(name || '').replace(/["\\]/g, '');
    const key = `tags:${n}:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const query = n
      ? `[out:json][timeout:15];(nwr["name"="${n}"](around:${radiusM},${lat.toFixed(6)},${lon.toFixed(6)});nwr["name:en"="${n}"](around:${radiusM},${lat.toFixed(6)},${lon.toFixed(6)}););out tags center 3;`
      : `[out:json][timeout:15];nwr(around:25,${lat.toFixed(6)},${lon.toFixed(6)})["name"];out tags center 5;`;
    return this.get(key, { host: 'overpass', url: this.hosts.overpass.base, body: `data=${encodeURIComponent(query)}`, ttlMs: 60 * 60000, parse: (json) => (json.elements || []).map((el) => ({ type: el.type, id: el.id, tags: el.tags || {}, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon })) });
  }

  // --- Open-Meteo ----------------------------------------------------------------

  weather(lat, lon) {
    const key = `wx:${lat.toFixed(2)},${lon.toFixed(2)}`;
    const url = `${this.hosts.meteo.base}/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`;
    return this.get(key, { host: 'meteo', url, ttlMs: 15 * 60000, parse: (j) => ({
      temperature: j.current?.temperature_2m,
      feelsLike: j.current?.apparent_temperature,
      humidity: j.current?.relative_humidity_2m,
      precipitation: j.current?.precipitation,
      wind: j.current?.wind_speed_10m,
      windDir: j.current?.wind_direction_10m,
      clouds: j.current?.cloud_cover,
      code: j.current?.weather_code,
      description: weatherText(j.current?.weather_code),
      timezone: j.timezone,
      utcOffset: j.utc_offset_seconds,
      elevation: j.elevation,
      sunrise: j.daily?.sunrise?.[0],
      sunset: j.daily?.sunset?.[0],
      tmax: j.daily?.temperature_2m_max?.[0],
      tmin: j.daily?.temperature_2m_min?.[0],
      time: j.current?.time,
    }) });
  }

  // --- Wikipedia -----------------------------------------------------------------

  wikiNearby(lat, lon, radiusM = 5000, limit = 40) {
    const r = Math.max(10, Math.min(10000, Math.round(radiusM)));
    const key = `wiki:${lat.toFixed(2)},${lon.toFixed(2)},${r}`;
    const url = `${this.hosts.wikipedia.base}?action=query&list=geosearch&gscoord=${lat.toFixed(4)}%7C${lon.toFixed(4)}&gsradius=${r}&gslimit=${limit}&format=json`;
    return this.get(key, { host: 'wikipedia', url, ttlMs: 30 * 60000, parse: (j) => (j.query?.geosearch || []).map((g) => ({ pageid: g.pageid, title: g.title, lat: g.lat, lon: g.lon, dist: g.dist, url: `https://en.wikipedia.org/?curid=${g.pageid}` })) });
  }

  wikiSummary(pageid) {
    const url = `${this.hosts.wikipedia.base}?action=query&prop=extracts%7Cinfo&exintro=1&explaintext=1&exsentences=4&inprop=url&pageids=${pageid}&format=json`;
    return this.get(`wikisum:${pageid}`, { host: 'wikipedia', url, ttlMs: 6 * 3600000, parse: (j) => {
      const p = j.query?.pages?.[pageid];
      return p ? { title: p.title, extract: p.extract, url: p.fullurl } : null;
    } });
  }

  // --- adsb.lol: aircraft within `nm` nautical miles -------------------------------

  aircraft(lat, lon, nm = 100) {
    const d = Math.max(1, Math.min(250, Math.round(nm)));
    const key = `adsb:${lat.toFixed(1)},${lon.toFixed(1)},${d}`;
    const url = `${this.hosts.adsb.base}/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${d}`;
    return this.get(key, { host: 'adsb', url, ttlMs: 10000, parse: (j) => (j.ac || []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map((a) => ({
      hex: a.hex,
      flight: (a.flight || '').trim(),
      registration: a.r,
      type: a.t,
      description: a.desc,
      lat: a.lat,
      lon: a.lon,
      altitude: a.alt_baro === 'ground' ? 0 : a.alt_baro,
      onGround: a.alt_baro === 'ground',
      groundSpeed: a.gs,
      track: a.track,
      verticalRate: a.baro_rate,
      squawk: a.squawk,
      emergency: a.emergency && a.emergency !== 'none' ? a.emergency : '',
      category: a.category,
      seen: a.seen,
      military: Boolean(a.dbFlags & 1),
      url: `https://globe.adsb.lol/?icao=${a.hex}`,
    })) });
  }

  stats() {
    return { entries: this.entries.size, requests: this.requests };
  }
}

export function weatherText(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return '';
  if (c === 0) return 'clear sky';
  if (c <= 2) return 'partly cloudy';
  if (c === 3) return 'overcast';
  if (c <= 48) return 'fog';
  if (c <= 57) return 'drizzle';
  if (c <= 67) return 'rain';
  if (c <= 77) return 'snow';
  if (c <= 82) return 'rain showers';
  if (c <= 86) return 'snow showers';
  return 'thunderstorm';
}

// Compact address from Nominatim address details.
export function shortAddress(address = {}) {
  const road = [address.house_number, address.road || address.pedestrian || address.footway].filter(Boolean).join(' ');
  const locality = address.neighbourhood || address.suburb || address.quarter || address.village || address.town || address.city_district || '';
  const city = address.city || address.town || address.village || address.municipality || address.county || '';
  const region = address.state || address.region || '';
  return [road, locality, city !== locality ? city : '', region, address.country].filter(Boolean).join(', ');
}
