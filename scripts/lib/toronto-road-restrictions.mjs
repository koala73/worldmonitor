/**
 * City of Toronto road restrictions (CART v3) adapter.
 *
 * Separate from Ontario 511: different host, licence, and schema.
 * Do not import the vendor 511 limiter or that province adapter here.
 */

export const TORONTO_ROADS_HOST = 'secure.toronto.ca';
export const TORONTO_ROADS_URL =
  'https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json';
export const TORONTO_ROADS_SOURCE = 'toronto-roads';
export const TORONTO_ROADS_JURISDICTION = 'Toronto';
export const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
// Live CART was 2379 on 2026-08-14 (448 ROAD_CLOSED + 1931 construction).
// 400 kept only ROAD_CLOSED and dropped leftover closures + all High construction.
export const MAX_RECORDS = 4000;
export const MAX_PATH_POINTS = 32;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const RESTRICTION_TYPES = new Set(['CONSTRUCTION', 'ROAD_CLOSED', 'HAZARD']);

export function isAllowedTorontoHost(url) {
  try {
    return new URL(url).hostname.toLowerCase() === TORONTO_ROADS_HOST;
  } catch {
    return false;
  }
}

/**
 * The live CART feed sometimes emits invalid JSON escapes (e.g. `\ ` in
 * descriptions). JSON.parse first; on failure, escape unknown `\<char>`
 * sequences and retry. Still-unparseable bodies are rejected.
 */
export function sanitizeJsonEscapes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\\(.)/g, (match, ch) => {
    if ('"\\/bfnrtu'.includes(ch)) return match;
    return `\\\\${ch}`;
  });
}

export function parseRestrictionsJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('toronto-roads: body is not a parseable restrictions list');
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(sanitizeJsonEscapes(text));
    } catch {
      throw new Error('toronto-roads: body is not a parseable restrictions list');
    }
  }
}

function looksLikeRestriction(item) {
  if (!item || typeof item !== 'object') return false;
  const type = String(item.type || item.Type || '').toUpperCase();
  if (RESTRICTION_TYPES.has(type)) return true;
  return item.district != null || item.geoPolyline != null
    || item.latitude != null || item.Latitude != null;
}

export function extractRestrictionsList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.Closure)) return body.Closure;
  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.data)) return body.data;
  for (const value of Object.values(body)) {
    if (Array.isArray(value) && value.length > 0 && value.every((item) => item == null || typeof item === 'object')) {
      if (value.some(looksLikeRestriction)) return value;
    }
  }
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Decode a Google-encoded polyline into [lon, lat] pairs.
 * CART v3 ships geoPolyline as "[lon,lat],[lon,lat],..." but keep this
 * decoder so an encoded payload still yields a centroid/path.
 */
export function decodeEncodedPolyline(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += dlng;
    coordinates.push([lon / 1e5, lat / 1e5]);
  }
  return coordinates;
}

export function parseGeoPolyline(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const point of value) {
      if (Array.isArray(point) && point.length >= 2) {
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
      } else if (typeof point === 'string') {
        out.push(...parseGeoPolyline(point));
      }
    }
    return out;
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const pairs = [];
    const re = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
    let match;
    while ((match = re.exec(trimmed))) {
      const lon = Number(match[1]);
      const lat = Number(match[2]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) pairs.push([lon, lat]);
    }
    return pairs;
  }
  return decodeEncodedPolyline(trimmed);
}

export function downsamplePath(path) {
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

function epochMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function restrictionType(item) {
  return String(item?.type || item?.Type || '').toUpperCase() || 'CONSTRUCTION';
}

function severityOf(item, { isFullClosure, type } = {}) {
  if (isFullClosure || type === 'ROAD_CLOSED') return 'Extreme';
  const impact = String(item?.currImpact || item?.maxImpact || '').trim().toLowerCase();
  if (type === 'HAZARD' && impact === 'high') return 'Extreme';
  if (type === 'HAZARD' || impact === 'high') return 'Severe';
  if (impact === 'low' || impact === 'medium' || impact === 'moderate') return 'Moderate';
  return 'Unknown';
}

export function normalizeTorontoRoadRecord(item) {
  const type = restrictionType(item);
  const lat = finiteCoord(item?.latitude ?? item?.Latitude ?? item?.lat);
  const lon = finiteCoord(item?.longitude ?? item?.Longitude ?? item?.lon ?? item?.lng);
  const decoded = parseGeoPolyline(
    item?.geoPolyline ?? item?.GeoPolyline ?? item?.EncodedPolyline ?? item?.encodedPolyline,
  );
  const path = downsamplePath(decoded);
  const centroid = (lat != null && lon != null) ? [lon, lat] : centroidOfPath(decoded);
  const isFullClosure = type === 'ROAD_CLOSED';
  const id = String(item?.id ?? item?.ID ?? item?.Id ?? '');
  return {
    id,
    kind: 'event',
    lat,
    lon,
    centroid,
    severity: severityOf(item, { isFullClosure, type }),
    eventType: type,
    type,
    isFullClosure,
    lanesAffected: item?.directionsAffected ?? item?.lanesAffected ?? null,
    roadwayName: textOf(item?.road, item?.roadwayName),
    headline: textOf(item?.name, item?.road, item?.headline),
    description: textOf(item?.description, item?.name),
    path: path && path.length > 1 ? path : null,
    jurisdiction: TORONTO_ROADS_JURISDICTION,
    source: TORONTO_ROADS_SOURCE,
    district: textOf(item?.district, item?.District) || null,
    currImpact: item?.currImpact ?? item?.maxImpact ?? null,
    createdTime: epochMs(item?.createdTime ?? item?.created),
    lastUpdated: epochMs(item?.lastUpdated ?? item?.updated),
    startTime: epochMs(item?.startTime ?? item?.start),
    endTime: epochMs(item?.endTime ?? item?.end),
    resource: 'road_restrictions',
  };
}

export function normalizeTorontoRoadList(body) {
  const items = extractRestrictionsList(body);
  if (!Array.isArray(items)) {
    throw new Error('toronto-roads: body is not a parseable restrictions list');
  }
  const records = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    records.push(normalizeTorontoRoadRecord(item));
  }
  return records;
}

export function rankRecord(record) {
  if (record.isFullClosure || record.type === 'ROAD_CLOSED') return 0;
  if (record.severity === 'Extreme') return 1;
  if (record.type === 'HAZARD' || record.severity === 'Severe') return 2;
  if (String(record.currImpact || '').toLowerCase() === 'high') return 3;
  if (record.centroid) return 4;
  return 5;
}

export function selectTorontoRoadRecords(records) {
  if (!Array.isArray(records) || records.length <= MAX_RECORDS) return records || [];
  return [...records]
    .sort((a, b) => rankRecord(a) - rankRecord(b) || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_RECORDS);
}

export function declareTorontoRoadRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

export function validateTorontoRoadEnvelope(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.records);
}

async function readLimitedText(resp, maxBytes) {
  const contentLength = resp.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`toronto-roads: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`toronto-roads: payload exceeds ${maxBytes} bytes`);
  }
  return buffer.toString('utf8');
}

/**
 * Fetch and normalise the CART v3 restrictions list.
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   url?: string,
 * }} [opts]
 */
export async function fetchTorontoRoadRestrictions(opts = {}) {
  const url = opts.url || TORONTO_ROADS_URL;
  if (!isAllowedTorontoHost(url)) {
    throw new Error(`toronto-roads: host is not on the allowlist (${TORONTO_ROADS_HOST})`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  const resp = await fetchFn(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) {
    throw new Error(`toronto-roads: HTTP ${resp.status}`);
  }
  const text = await readLimitedText(resp, maxBytes);
  const body = parseRestrictionsJson(text);
  const all = normalizeTorontoRoadList(body);
  const records = selectTorontoRoadRecords(all);
  return {
    records,
    ...(all.length > MAX_RECORDS ? { truncated: true } : {}),
  };
}

export { CHROME_UA };
