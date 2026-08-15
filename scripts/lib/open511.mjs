/**
 * Open511 protocol adapter (events list + pagination).
 *
 * BC DriveBC (`api.open511.gov.bc.ca`) is the first jurisdiction. This is NOT
 * the vendor 511 client in provincial-511.mjs — do not pass a
 * 511on.ca baseUrl here, and do not copy that vendor path layout.
 *
 * Host allowlist is derived from the configured baseUrl hostname so a future
 * Open511 jurisdiction is a config entry, not a forked client.
 */

import { acquire511Slot } from '../_511-rate-limit.mjs';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PATH_POINTS = 32;
const MAX_PAGES = 20;
const DEFAULT_LIMIT = 500;

/** Hosts that speak the Open511 `/events` contract. */
const _open511Hosts = {
  'api.open511.gov.bc.ca': Object.freeze({
    jurisdiction: 'BC',
    source: 'bc-open511',
  }),
};
export const OPEN511_HOSTS = Object.freeze(_open511Hosts);

export const BC_OPEN511 = Object.freeze({
  baseUrl: 'https://api.open511.gov.bc.ca',
  jurisdiction: 'BC',
  source: 'bc-open511',
});

export function isOpen511Host(host) {
  return Object.prototype.hasOwnProperty.call(OPEN511_HOSTS, String(host || '').toLowerCase());
}

function hostnameOf(baseUrl) {
  let hostname;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new TypeError(`open511: invalid baseUrl ${baseUrl}`);
  }
  if (!isOpen511Host(hostname)) {
    throw new Error(
      `open511: host ${hostname} is not on the Open511 allowlist `
      + `(vendor 511 APIs use provincial-511.mjs)`,
    );
  }
  return hostname;
}

function finiteCoord(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textOf(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function downsamplePath(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (path.length <= MAX_PATH_POINTS) return path;
  const out = [];
  const last = path.length - 1;
  for (let i = 0; i < MAX_PATH_POINTS; i++) {
    const idx = Math.round((i / (MAX_PATH_POINTS - 1)) * last);
    out.push(path[idx]);
  }
  return out;
}

export function centroidOfPath(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const point of path) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / path.length, lat / path.length];
}

function pairFrom(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  // Help-page Point samples sometimes wrap [lon, lat] in an extra array.
  if (Array.isArray(value[0])) return pairFrom(value[0]);
  const lon = finiteCoord(value[0]);
  const lat = finiteCoord(value[1]);
  if (lon == null || lat == null) return null;
  return [lon, lat];
}

export function geometryFromOpen511(geography) {
  if (!geography || typeof geography !== 'object') {
    return { lat: null, lon: null, centroid: null, path: null };
  }
  const type = String(geography.type || '');
  const coordinates = geography.coordinates;
  if (type === 'Point') {
    const pair = pairFrom(coordinates);
    if (!pair) return { lat: null, lon: null, centroid: null, path: null };
    return { lon: pair[0], lat: pair[1], centroid: pair, path: null };
  }
  if (type === 'LineString' && Array.isArray(coordinates)) {
    const path = [];
    for (const item of coordinates) {
      const pair = pairFrom(item);
      if (pair) path.push(pair);
    }
    const down = downsamplePath(path);
    const centroid = centroidOfPath(path);
    return {
      lon: centroid ? centroid[0] : null,
      lat: centroid ? centroid[1] : null,
      centroid,
      path: down && down.length > 1 ? down : null,
    };
  }
  return { lat: null, lon: null, centroid: null, path: null };
}

function roadsOf(item) {
  return Array.isArray(item?.roads) ? item.roads.filter((r) => r && typeof r === 'object') : [];
}

function isFullClosureOf(item, roads) {
  if (roads.some((road) => String(road.state || '').toUpperCase() === 'CLOSED')) return true;
  const blob = `${item?.headline || ''} ${item?.description || ''}`;
  return /\b(road is closed|all lanes closed|bridge is closed|highway is closed)\b/i.test(blob);
}

function severityOf(item, { isFullClosure } = {}) {
  if (isFullClosure) return 'Extreme';
  const raw = String(item?.severity || '').trim().toUpperCase();
  if (raw === 'MAJOR') return 'Severe';
  if (raw === 'MODERATE') return 'Moderate';
  if (raw === 'MINOR') return 'Minor';
  if (raw === 'UNKNOWN') return 'Unknown';
  return raw ? item.severity : 'Unknown';
}

/**
 * @param {object} item
 * @param {{ jurisdiction?: string, source?: string }} [ctx]
 */
export function normalizeOpen511Event(item, ctx = {}) {
  const jurisdiction = ctx.jurisdiction || 'BC';
  const source = ctx.source || 'bc-open511';
  const geo = geometryFromOpen511(item?.geography || item?.geometry);
  const roads = roadsOf(item);
  const isFullClosure = isFullClosureOf(item, roads);
  const roadwayName = textOf(roads[0]?.name);
  const lanesAffected = roads[0]?.state || null;
  return {
    id: String(item?.id || item?.url || ''),
    kind: 'event',
    lat: geo.lat,
    lon: geo.lon,
    centroid: geo.centroid,
    severity: severityOf(item, { isFullClosure }),
    eventType: textOf(item?.event_type, 'event') || 'event',
    isFullClosure,
    lanesAffected,
    roadwayName,
    headline: textOf(item?.headline, roadwayName),
    description: textOf(item?.description, item?.headline),
    path: geo.path,
    jurisdiction,
    resource: 'events',
    source,
  };
}

export function normalizeOpen511List(body, ctx = {}) {
  const items = Array.isArray(body)
    ? body
    : Array.isArray(body?.events) ? body.events
    : [];
  const records = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    records.push(normalizeOpen511Event(item, ctx));
  }
  return records;
}

export function declareOpen511Records(envelope) {
  if (!envelope || typeof envelope !== 'object') return 0;
  return Array.isArray(envelope.records) ? envelope.records.length : 0;
}

export function validateOpen511Envelope(envelope) {
  return envelope != null && typeof envelope === 'object' && Array.isArray(envelope.records);
}

async function readLimitedJson(resp, maxBytes) {
  const contentLength = resp.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`open511: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`open511: payload exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(buffer.toString('utf8'));
}

function eventsUrl(baseUrl, { status = 'ACTIVE', limit = DEFAULT_LIMIT, offset } = {}) {
  const url = new URL('events', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (status) url.searchParams.set('status', status);
  url.searchParams.set('limit', String(limit));
  if (offset != null && offset !== '') url.searchParams.set('offset', String(offset));
  return url;
}

function applyStatus(url, status) {
  if (status) url.searchParams.set('status', status);
  return url;
}

function nextPageUrl(body, currentUrl, { status, limit, offset }) {
  const pagination = body?.pagination && typeof body.pagination === 'object' ? body.pagination : {};
  const next = pagination.next_url || pagination.next || null;
  if (typeof next === 'string' && next.trim()) {
    // DriveBC next_url sometimes drops status=ACTIVE; later pages then
    // include archived events. Re-apply the requested status on every page.
    return applyStatus(new URL(next, currentUrl), status);
  }
  const events = Array.isArray(body?.events) ? body.events : [];
  const currentOffset = Number(pagination.offset ?? offset ?? 0) || 0;
  const total = Number(pagination.total ?? pagination.count ?? body?.total);
  const hasMore = pagination.has_more === true
    || pagination.hasMore === true
    || (Number.isFinite(total) && total > currentOffset + events.length);
  if (events.length === 0) {
    if (hasMore) {
      throw new Error('open511: pagination claims more results after an empty page');
    }
    return null;
  }
  const nextOffset = currentOffset + events.length;
  if (!hasMore && events.length < Number(limit)) return null;
  return eventsUrl(currentUrl.origin + '/', { status, limit, offset: nextOffset });
}

function validateOpen511Page(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
    throw new Error('open511: page is missing an events array');
  }
  if ('pagination' in body && (body.pagination == null
    || typeof body.pagination !== 'object'
    || Array.isArray(body.pagination))) {
    throw new Error('open511: page has malformed pagination metadata');
  }
  const pagination = body.pagination ?? {};
  for (const key of ['next_url', 'next']) {
    const value = pagination[key];
    if (value != null && typeof value !== 'string') {
      throw new Error(`open511: pagination ${key} must be a string`);
    }
  }
  for (const [owner, key] of [[pagination, 'offset'], [pagination, 'total'], [pagination, 'count'], [body, 'total']]) {
    if (!(key in owner)) continue;
    const value = owner[key];
    if ((typeof value !== 'number' && typeof value !== 'string')
      || value === ''
      || !Number.isFinite(Number(value))
      || Number(value) < 0) {
      throw new Error(`open511: pagination ${key} must be a non-negative number`);
    }
  }
  for (const key of ['has_more', 'hasMore']) {
    if (key in pagination && typeof pagination[key] !== 'boolean') {
      throw new Error(`open511: pagination ${key} must be a boolean`);
    }
  }
}

/**
 * Fetch one Open511 page. Calls acquire511Slot(hostname) before the request.
 */
export async function fetchOpen511Page(url, opts = {}) {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = hostnameOf(parsed.origin);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const acquireSlot = opts.acquireSlot ?? acquire511Slot;

  await acquireSlot(hostname);

  const resp = await fetchFn(parsed.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) {
    throw new Error(`open511 events: HTTP ${resp.status}`);
  }
  return readLimitedJson(resp, maxBytes);
}

/**
 * @param {string} baseUrl
 * @param {{
 *   status?: string,
 *   limit?: number,
 *   fetchFn?: typeof fetch,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   acquireSlot?: (host: string) => Promise<void>,
 *   maxPages?: number,
 *   jurisdiction?: string,
 *   source?: string,
 * }} [opts]
 */
export async function fetchEvents(baseUrl, opts = {}) {
  const hostname = hostnameOf(baseUrl);
  const meta = OPEN511_HOSTS[hostname] || {};
  const status = opts.status || 'ACTIVE';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const ctx = {
    jurisdiction: opts.jurisdiction || meta.jurisdiction || 'BC',
    source: opts.source || meta.source || 'bc-open511',
  };

  const records = [];
  let url = eventsUrl(baseUrl, { status, limit });
  let pages = 0;
  let offset = 0;
  const visited = new Set();

  while (pages < maxPages) {
    if (url.hostname.toLowerCase() !== hostname) {
      throw new Error(`open511: pagination left allowlisted host ${hostname} -> ${url.hostname}`);
    }
    const pageUrl = url.toString();
    if (visited.has(pageUrl)) {
      throw new Error(`open511: pagination did not advance from ${pageUrl}`);
    }
    visited.add(pageUrl);
    const body = await fetchOpen511Page(url, opts);
    validateOpen511Page(body);
    const pageRecords = normalizeOpen511List(body, ctx);
    records.push(...pageRecords);
    pages += 1;
    const next = nextPageUrl(body, url, { status, limit, offset });
    if (!next) break;
    if (pages >= maxPages) {
      throw new Error(`open511: hit maxPages=${maxPages} on ${hostname} before pagination completed`);
    }
    offset = Number(new URL(next).searchParams.get('offset') || 0) || offset + pageRecords.length;
    url = next;
  }

  return { records, pages };
}

/**
 * Protocol adapter parameterized by Open511 baseUrl.
 *
 * @param {string} baseUrl
 * @param {object} [defaults]
 */
export function open511Adapter(baseUrl, defaults = {}) {
  const hostname = hostnameOf(baseUrl);
  const meta = OPEN511_HOSTS[hostname];
  return {
    baseUrl,
    hostname,
    jurisdiction: defaults.jurisdiction || meta.jurisdiction,
    source: defaults.source || meta.source,
    async fetchEvents(query = {}) {
      return fetchEvents(baseUrl, { ...defaults, ...query });
    },
  };
}

export { CHROME_UA, MAX_PAYLOAD_BYTES, MAX_PAGES, DEFAULT_LIMIT };

export const MAX_RECORDS = 400;

function isAccidentEvent(record) {
  const type = String(record?.eventType || '');
  if (/construction/i.test(type)) return false;
  const blob = `${type} ${record?.headline || ''} ${record?.description || ''}`;
  return /accident|incident|collision|crash/i.test(blob);
}

/** Lower is kept first so the 400-record cap cannot drop closures/accidents. */
export function rankOpen511Record(record) {
  if (record?.isFullClosure) return 0;
  if (record?.severity === 'Extreme') return 1;
  if (isAccidentEvent(record)) return 2;
  if (record?.severity === 'Severe') return 3;
  if (record?.severity === 'Moderate') return 4;
  if (record?.centroid) return 5;
  return 6;
}

export function selectOpen511Records(records, maxRecords = MAX_RECORDS) {
  const list = Array.isArray(records) ? records : [];
  if (list.length <= maxRecords) return { records: list, truncated: false };
  return {
    records: [...list]
      .sort((a, b) => rankOpen511Record(a) - rankOpen511Record(b) || String(a.id).localeCompare(String(b.id)))
      .slice(0, maxRecords),
    truncated: true,
  };
}
