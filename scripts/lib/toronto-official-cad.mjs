/**
 * Official Toronto live-CAD / public-safety adapters (#6682).
 *
 * Two independent agencies, two independent last-good keys. Do not fold into
 * canadaAlerts, canadaRoads, or torontoRoads. Do not backfill privacy
 * exclusions from radio, Citizen, tpscalls.live, GTA Update, or news.
 *
 * TFS machine endpoint was discovered from the official page XHR
 * (`/data/fire/livecad.xml`), not invented. TPS FeatureServer URL was
 * extracted from Experience item a22f5295933e48a5b0a4c90cd3c4cae1
 * dataSources (C4S_Public_NoGO). Portal Search API is catalog, not live CAD.
 */

import { decodeHtmlEntities } from '../_html-entities.mjs';
import { CHROME_UA, MAX_PAYLOAD_BYTES } from '../_seed-utils.mjs';

export const TFS_HOST = 'www.toronto.ca';
export const TFS_PAGE_PATH = '/community-people/public-safety-alerts/alerts-notifications/toronto-fire-active-incidents/';
export const TFS_FEED_PATH = '/data/fire/livecad.xml';
export const TFS_FEED_URL = 'https://www.toronto.ca/data/fire/livecad.xml';
export const TFS_SOURCE = 'toronto-tfs';
export const TFS_KEY = 'safety:toronto-tfs:v1';
export const TFS_MAX_STALE_MIN = 15;
export const TFS_TTL_SECONDS = 2700;
export const TFS_SOURCE_VERSION = 'toronto-tfs-livecad-v1';

export const TPS_HOST = 'services.arcgis.com';
export const TPS_ORG_ID = 'S9th0jAJ7bqgIRjw';
export const TPS_LAYER_NAME = 'C4S_Public_NoGO';
export const TPS_LAYER_URL = 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/C4S_Public_NoGO/FeatureServer/0';
export const TPS_METADATA_URL = `${TPS_LAYER_URL}?f=pjson`;
export const TPS_QUERY_URL = 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/C4S_Public_NoGO/FeatureServer/0/query';
export const TPS_SOURCE = 'toronto-tps';
export const TPS_KEY = 'safety:toronto-tps:v1';
export const TPS_MAX_STALE_MIN = 45;
export const TPS_TTL_SECONDS = 5400;
export const TPS_SOURCE_VERSION = 'toronto-tps-c4s-v1';

export const TORONTO_CAD_JURISDICTION = 'Toronto';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const TFS_MAX_RECORDS = 500;
export const TPS_MAX_RECORDS = 2000;
export const TPS_PAGE_SIZE = 500;
export const TPS_MAX_PAGES = 6;

const QUERY_FIELDS = [
  'OBJECTID',
  'OCCURRENCE_TIME',
  'OCCURRENCE_TIME_AGOL',
  'DIVISION',
  'LATITUDE',
  'LONGITUDE',
  'CALL_TYPE_CODE',
  'CALL_TYPE',
  'CROSS_STREETS',
].join(',');

// Official public-map exclusions. KEEP these empty — do not fill from
// radio / news / GTA Update / tpscalls.live / Citizen. The C4S_Public_NoGO
// layer already omits them; this is a residual fail-closed filter only.
export const TPS_PRIVACY_EXCLUSION_PATTERNS = Object.freeze([
  /\bdomestic\b/i,
  /\bdv\b/i,
  /intimate[-\s]?partner/i,
  /sexual\s+assault/i,
  /\bsex\s+assault\b/i,
  /\brape\b/i,
  /\bindecent\b/i,
  /\bmedical\b/i,
  /\bsick\s+person\b/i,
  /active\s+(shooter|op|ops|operation|incident)\b/i,
]);
const TPS_PRIVACY_EXCLUSION_CODES = new Set([
  'DOMVI',
  'SEXAS',
  'MEDIC',
  'ACTOP',
]);

function isHttpsHost(url, host) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === host
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

export function isAllowedTfsHost(url) {
  if (!isHttpsHost(url, TFS_HOST)) return false;
  try {
    return new URL(url).pathname === TFS_FEED_PATH;
  } catch {
    return false;
  }
}

export function isAllowedTpsHost(url) {
  if (!isHttpsHost(url, TPS_HOST)) return false;
  try {
    const parsed = new URL(url);
    const layerPath = `/${TPS_ORG_ID}/arcgis/rest/services/${TPS_LAYER_NAME}/FeatureServer/0`;
    return parsed.pathname === layerPath || parsed.pathname === `${layerPath}/query`;
  } catch {
    return false;
  }
}

function cleanText(raw) {
  return decodeHtmlEntities(String(raw ?? '')).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tagName) {
  const re = new RegExp(
    `<${tagName}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tagName}>`,
    'i',
  );
  return (block.match(re) || [])[1] ?? '';
}

/**
 * Naive TFS timestamps are America/Toronto local (no offset on the CAD XML).
 * Pick the EST/EDT offset that formats back to the same wall clock.
 */
export function parseTorontoLocalMs(raw) {
  const match = String(raw || '').trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const offset of ['-04:00', '-05:00']) {
    const ms = Date.parse(`${iso}${offset}`);
    if (!Number.isFinite(ms)) continue;
    const parts = formatter.formatToParts(new Date(ms));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const wall = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    if (wall === iso) return ms;
  }
  return null;
}

function finiteCoord(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function torontoPoint(lon, lat) {
  if (lon == null || lat == null) return { lat: null, lon: null };
  if (lon < -80.5 || lon > -78.5 || lat < 43.3 || lat > 44.1) return { lat: null, lon: null };
  return { lat, lon };
}

export function parseTfsLivecadXml(xml) {
  if (typeof xml !== 'string'
    || !/<tfs_active_incidents\b[^>]*>[\s\S]*<\/tfs_active_incidents>/i.test(xml)) {
    throw new Error('toronto-tfs: body is not TFS livecad XML');
  }
  const updatedRaw = cleanText(extractTag(xml, 'update_from_db_time'));
  const updatedAt = parseTorontoLocalMs(updatedRaw);
  if (!updatedRaw || updatedAt == null) {
    throw new Error('toronto-tfs: missing or invalid update_from_db_time');
  }
  const records = [];
  const eventRe = /<event\b[^>]*>[\s\S]*?<\/event>/gi;
  const eventOpenCount = (xml.match(/<event\b/gi) || []).length;
  let match;
  let eventIndex = 0;
  while ((match = eventRe.exec(xml)) !== null) {
    eventIndex += 1;
    const block = match[0];
    const incidentNumber = cleanText(extractTag(block, 'event_num'));
    const primeStreet = cleanText(extractTag(block, 'prime_street'));
    const crossStreet = cleanText(extractTag(block, 'cross_streets'));
    const dispatchRaw = cleanText(extractTag(block, 'dispatch_time'));
    const dispatchMs = parseTorontoLocalMs(dispatchRaw);
    const type = cleanText(extractTag(block, 'event_type'));
    if (!incidentNumber || !type || dispatchMs == null || (!primeStreet && !crossStreet)) {
      throw new Error(`toronto-tfs: event ${eventIndex} is missing required fields`);
    }
    const unitsRaw = cleanText(extractTag(block, 'units_disp'));
    records.push({
      id: incidentNumber,
      incidentNumber,
      type,
      primeStreet,
      crossStreet,
      dispatchTime: dispatchRaw || null,
      dispatchMs,
      alarmLevel: cleanText(extractTag(block, 'alarm_lev')),
      area: cleanText(extractTag(block, 'beat')),
      units: unitsRaw ? unitsRaw.split(',').map((unit) => unit.trim()).filter(Boolean) : [],
      source: TFS_SOURCE,
      jurisdiction: TORONTO_CAD_JURISDICTION,
    });
    if (records.length > TFS_MAX_RECORDS) {
      throw new Error(`toronto-tfs: incident count exceeds ${TFS_MAX_RECORDS}`);
    }
  }
  if (eventIndex !== eventOpenCount) {
    throw new Error('toronto-tfs: malformed event structure');
  }
  records.sort((a, b) => (b.dispatchMs ?? 0) - (a.dispatchMs ?? 0) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    agency: 'tfs',
    source: TFS_SOURCE,
    feedUrl: TFS_FEED_URL,
    updatedFromDbTime: updatedRaw || null,
    updatedAt,
    records,
  };
}

export function isTpsPrivacyExcluded(callType, callTypeCode) {
  const normalizedCode = cleanText(callTypeCode).toUpperCase();
  if (TPS_PRIVACY_EXCLUSION_CODES.has(normalizedCode)) return true;
  const haystack = `${callType || ''} ${callTypeCode || ''}`;
  return TPS_PRIVACY_EXCLUSION_PATTERNS.some((pattern) => pattern.test(haystack));
}

function featureAttributes(feature) {
  if (!feature || typeof feature !== 'object') return null;
  if (feature.attributes && typeof feature.attributes === 'object') return feature.attributes;
  if (feature.properties && typeof feature.properties === 'object') return feature.properties;
  return null;
}

function featureCoords(feature, attributes) {
  const geometry = feature?.geometry;
  if (geometry && Number.isFinite(Number(geometry.x)) && Number.isFinite(Number(geometry.y))) {
    return torontoPoint(Number(geometry.x), Number(geometry.y));
  }
  const coords = geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    return torontoPoint(finiteCoord(coords[0]), finiteCoord(coords[1]));
  }
  return torontoPoint(finiteCoord(attributes?.LONGITUDE), finiteCoord(attributes?.LATITUDE));
}

function classifyTpsFeature(feature) {
  const attributes = featureAttributes(feature);
  if (!attributes) return { kind: 'malformed', record: null };
  const callType = cleanText(attributes.CALL_TYPE);
  const callTypeCode = cleanText(attributes.CALL_TYPE_CODE);
  if (isTpsPrivacyExcluded(callType, callTypeCode)) {
    return { kind: 'privacy-excluded', record: null };
  }

  const objectId = attributes.OBJECTID;
  const occurrenceMs = Number(attributes.OCCURRENCE_TIME_AGOL ?? attributes.OCCURRENCE_TIME);
  const timeMs = Number.isFinite(occurrenceMs)
    && occurrenceMs > 0
    && Number.isFinite(new Date(occurrenceMs).getTime())
    ? occurrenceMs
    : null;
  const { lat, lon } = featureCoords(feature, attributes);
  const crossStreets = cleanText(attributes.CROSS_STREETS);
  if (objectId == null || objectId === '' || (!callType && !callTypeCode) || timeMs == null
    || (lat == null && lon == null && !crossStreets)) {
    return { kind: 'malformed', record: null };
  }

  return {
    kind: 'record',
    record: {
      id: `tps-${objectId}`,
      type: callType || callTypeCode,
      callType,
      callTypeCode,
      crossStreets,
      division: cleanText(attributes.DIVISION),
      occurrenceTime: new Date(timeMs).toISOString(),
      occurrenceMs: timeMs,
      lat,
      lon,
      source: TPS_SOURCE,
      jurisdiction: TORONTO_CAD_JURISDICTION,
    },
  };
}

export function parseTpsFeatureServer(body) {
  let data = body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch {
      throw new Error('toronto-tps: body is not parseable FeatureServer JSON');
    }
  }
  if (!data || typeof data !== 'object') {
    throw new Error('toronto-tps: body is not a FeatureServer payload');
  }
  if (data.error) {
    throw new Error(`toronto-tps: FeatureServer error ${data.error.message || data.error.code || 'unknown'}`);
  }
  const features = Array.isArray(data.features) ? data.features : null;
  if (!features) {
    throw new Error('toronto-tps: body is not a FeatureServer feature list');
  }
  const updatedAt = Number(data.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error('toronto-tps: missing or invalid layer edit timestamp');
  }
  const records = [];
  const seen = new Set();
  for (let index = 0; index < features.length; index += 1) {
    const classified = classifyTpsFeature(features[index]);
    if (classified.kind === 'privacy-excluded') continue;
    if (classified.kind === 'malformed') {
      throw new Error(`toronto-tps: feature ${index + 1} is missing required fields`);
    }
    const { record } = classified;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
    if (records.length > TPS_MAX_RECORDS) {
      throw new Error(`toronto-tps: record count exceeds ${TPS_MAX_RECORDS}`);
    }
  }
  records.sort((a, b) => (b.occurrenceMs ?? 0) - (a.occurrenceMs ?? 0) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    agency: 'tps',
    source: TPS_SOURCE,
    feedUrl: TPS_LAYER_URL,
    updatedAt,
    records,
  };
}

export function torontoTfsContentMeta(snapshot) {
  const updatedAt = Number(snapshot?.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt > 0
    ? { newestItemAt: updatedAt, oldestItemAt: updatedAt }
    : null;
}

export function torontoTpsContentMeta(snapshot) {
  const updatedAt = Number(snapshot?.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt > 0
    ? { newestItemAt: updatedAt, oldestItemAt: updatedAt }
    : null;
}

async function readLimitedText(resp, maxBytes, label) {
  const contentLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label}: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`${label}: payload exceeds ${maxBytes} bytes`);
  }
  return buffer.toString('utf8');
}

export async function fetchTorontoTfs(opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const url = opts.url ?? TFS_FEED_URL;
  if (!isAllowedTfsHost(url)) {
    throw new Error(`toronto-tfs: host is not on the allowlist (${TFS_HOST}${TFS_FEED_PATH})`);
  }
  const resp = await fetchFn(url, {
    headers: { Accept: 'application/xml, text/xml, */*', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) throw new Error(`toronto-tfs: HTTP ${resp.status}`);
  return parseTfsLivecadXml(await readLimitedText(resp, maxBytes, 'toronto-tfs'));
}

function buildTpsQueryUrl(offset, baseUrl = TPS_QUERY_URL) {
  const url = new URL(baseUrl);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', QUERY_FIELDS);
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultOffset', String(offset));
  url.searchParams.set('resultRecordCount', String(TPS_PAGE_SIZE));
  url.searchParams.set('orderByFields', 'OCCURRENCE_TIME_AGOL DESC');
  url.searchParams.set('f', 'json');
  return url.toString();
}

export async function fetchTorontoTps(opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const metadataUrl = opts.metadataUrl ?? TPS_METADATA_URL;
  if (!isAllowedTpsHost(metadataUrl) || new URL(metadataUrl).pathname.endsWith('/query')) {
    throw new Error(`toronto-tps: metadata URL is not on the exact layer allowlist (${TPS_ORG_ID} ${TPS_LAYER_NAME})`);
  }
  const metadataResp = await fetchFn(metadataUrl, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!metadataResp.ok) throw new Error(`toronto-tps: metadata HTTP ${metadataResp.status}`);
  const metadataText = await readLimitedText(metadataResp, maxBytes, 'toronto-tps metadata');
  let metadata;
  try { metadata = JSON.parse(metadataText); } catch {
    throw new Error('toronto-tps: layer metadata is not parseable JSON');
  }
  if (metadata?.error) {
    throw new Error(`toronto-tps: layer metadata error ${metadata.error.message || metadata.error.code || 'unknown'}`);
  }
  const updatedAt = Number(metadata?.editingInfo?.dataLastEditDate ?? metadata?.editingInfo?.lastEditDate);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error('toronto-tps: layer metadata has no valid edit timestamp');
  }
  const features = [];
  let offset = 0;
  let exceededTransferLimit = false;

  for (let page = 0; page < TPS_MAX_PAGES; page += 1) {
    const url = buildTpsQueryUrl(offset, opts.url ?? TPS_QUERY_URL);
    if (!isAllowedTpsHost(url) || !new URL(url).pathname.endsWith('/query')) {
      throw new Error(`toronto-tps: query URL is not on the exact layer allowlist (${TPS_ORG_ID} ${TPS_LAYER_NAME})`);
    }
    const resp = await fetchFn(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!resp.ok) throw new Error(`toronto-tps: HTTP ${resp.status}`);
    const text = await readLimitedText(resp, maxBytes, 'toronto-tps');
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error('toronto-tps: body is not parseable FeatureServer JSON');
    }
    if (data?.error) {
      throw new Error(`toronto-tps: FeatureServer error ${data.error.message || data.error.code || 'unknown'}`);
    }
    if (!Array.isArray(data?.features)) {
      throw new Error('toronto-tps: body is not a FeatureServer feature list');
    }
    features.push(...data.features);
    offset += data.features.length;
    exceededTransferLimit = data.exceededTransferLimit === true;
    if (!exceededTransferLimit || data.features.length === 0) break;
  }

  if (exceededTransferLimit) {
    throw new Error(`toronto-tps: pagination remains incomplete after ${TPS_MAX_PAGES} pages`);
  }

  return parseTpsFeatureServer({ features, updatedAt });
}

export function validateTfsEnvelope(data) {
  return data != null
    && typeof data === 'object'
    && data.schemaVersion === 1
    && data.agency === 'tfs'
    && data.source === TFS_SOURCE
    && Number.isFinite(data.updatedAt)
    && data.updatedAt > 0
    && Array.isArray(data.records);
}

export function validateTpsEnvelope(data) {
  return data != null
    && typeof data === 'object'
    && data.schemaVersion === 1
    && data.agency === 'tps'
    && data.source === TPS_SOURCE
    && Number.isFinite(data.updatedAt)
    && data.updatedAt > 0
    && Array.isArray(data.records);
}

export function declareTfsRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

export function declareTpsRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}
