/**
 * B.C. Evacuation Orders and Alerts adapter (#6659).
 *
 * This uses the B.C. Data Catalogue ArcGIS layer licensed under OGL-BC. It
 * intentionally does not scrape EmergencyInfoBC's RSS/WordPress content,
 * whose website terms do not grant redistribution rights.
 */

import { CHROME_UA, MAX_PAYLOAD_BYTES } from '../_seed-utils.mjs';

export const BC_ALERTS_HOST = 'services6.arcgis.com';
export const BC_ALERTS_QUERY_URL = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/Evacuation_Orders_and_Alerts/FeatureServer/0/query';
export const BC_ALERTS_CATALOGUE_URL = 'https://catalogue.data.gov.bc.ca/dataset/7efd46d0-b5d3-4dff-af80-d376c42aec33';
export const BC_ALERTS_SOURCE = 'bc-evacuation-orders-alerts';
export const BC_ALERTS_PROVINCE = 'BC';
export const BRITISH_COLUMBIA_CENTROID = Object.freeze([-124.5, 54.5]);
export const BC_ALERTS_MAX_CONTENT_AGE_MIN = 3 * 24 * 60;

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 6;
const MAX_ALERTS = 1_000;
const INACTIVE_ORDER_ALERT_STATUSES = new Set(['', 'all clear']);
const KNOWN_ACTIVE_ORDER_ALERT_STATUSES = new Set([
  'alert',
  'order',
  'tactical evacuation',
]);
const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });

const QUERY_FIELDS = [
  'EMRG_OAA_SYSID',
  'EVENT_NAME',
  'EVENT_TYPE',
  'ORDER_ALERT_NAME',
  'ORDER_ALERT_STATUS',
  'ISSUING_AGENCY',
  'DATE_MODIFIED',
  'EVENT_START_DATE',
].join(',');

export function isAllowedBcAlertsHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === BC_ALERTS_HOST
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * The source is not CAP. Its official lifecycle/level field is the only
 * severity input: Order and Tactical Evacuation require immediate departure;
 * Alert means prepare to leave on short notice. Unknown values fail closed.
 */
export function mapBcAlertSeverity(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'order' || normalized === 'tactical evacuation') return 'Extreme';
  if (normalized === 'alert') return 'Severe';
  return null;
}

function finiteTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function isoTimestamp(value) {
  const ms = finiteTimestamp(value);
  return ms == null ? '' : new Date(ms).toISOString();
}

function flattenPositions(value, out = [], limit = 256) {
  if (!Array.isArray(value) || out.length >= limit) return out;
  if (
    value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
  ) {
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) out.push([lon, lat]);
    return out;
  }
  for (const child of value) {
    flattenPositions(child, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

function centroidOf(coords) {
  if (coords.length === 0) return [...BRITISH_COLUMBIA_CENTROID];
  const [lon, lat] = coords.reduce(
    (sum, coordinate) => [sum[0] + coordinate[0], sum[1] + coordinate[1]],
    [0, 0],
  );
  return [lon / coords.length, lat / coords.length];
}

function normalizeFeature(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const properties = feature.properties;
  if (!properties || typeof properties !== 'object') return null;

  const sysId = String(properties.EMRG_OAA_SYSID ?? '').trim();
  if (!sysId) {
    throw new Error('bc-emergency-info: feature is missing EMRG_OAA_SYSID');
  }

  const status = String(properties.ORDER_ALERT_STATUS ?? '').trim();
  const normalizedStatus = status.toLowerCase();
  if (INACTIVE_ORDER_ALERT_STATUSES.has(normalizedStatus)) return null;
  if (!KNOWN_ACTIVE_ORDER_ALERT_STATUSES.has(normalizedStatus)) {
    throw new Error(`bc-emergency-info: unknown ORDER_ALERT_STATUS: ${status || '(empty)'}`);
  }

  const severity = mapBcAlertSeverity(status);
  if (!severity) {
    throw new Error(`bc-emergency-info: unknown ORDER_ALERT_STATUS: ${status || '(empty)'}`);
  }
  const eventName = String(properties.EVENT_NAME || '').trim();
  const areaName = String(properties.ORDER_ALERT_NAME || '').trim();
  const eventType = String(properties.EVENT_TYPE || '').trim();
  const issuingAgency = String(properties.ISSUING_AGENCY || '').trim();
  const coords = flattenPositions(feature.geometry?.coordinates);
  const centroid = centroidOf(coords);
  const updatedAt = finiteTimestamp(properties.DATE_MODIFIED);
  const publishedAt = finiteTimestamp(properties.EVENT_START_DATE);

  return {
    id: `bc-evacuation-${sysId}`,
    province: BC_ALERTS_PROVINCE,
    severity,
    event: eventType || status,
    headline: [eventName || status, areaName].filter(Boolean).join(' — '),
    description: [status, issuingAgency ? `Issued by ${issuingAgency}` : ''].filter(Boolean).join('. '),
    areaDesc: areaName,
    onset: isoTimestamp(properties.EVENT_START_DATE) || isoTimestamp(properties.DATE_MODIFIED),
    expires: '',
    updatedAt,
    publishedAt,
    lat: centroid[1],
    lon: centroid[0],
    centroid,
    url: BC_ALERTS_CATALOGUE_URL,
    source: BC_ALERTS_SOURCE,
  };
}

export function parseBcEmergencyInfoGeoJson(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('bc-emergency-info: body is not parseable GeoJSON'); }
  }
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('bc-emergency-info: body is not a GeoJSON FeatureCollection');
  }
  const alerts = [];
  const seen = new Set();
  for (const feature of data.features) {
    const alert = normalizeFeature(feature);
    if (!alert || seen.has(alert.id)) continue;
    seen.add(alert.id);
    alerts.push(alert);
    if (alerts.length > MAX_ALERTS) {
      throw new Error(`bc-emergency-info: normalized alert count exceeds ${MAX_ALERTS}`);
    }
  }
  alerts.sort((a, b) => (
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  ));
  return alerts;
}

async function readLimitedJson(resp, maxBytes) {
  const contentLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`bc-emergency-info: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`bc-emergency-info: payload exceeds ${maxBytes} bytes`);
  }
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('bc-emergency-info: body is not parseable GeoJSON'); }
}

function buildQueryUrl(offset) {
  const url = new URL(BC_ALERTS_QUERY_URL);
  url.searchParams.set('where', "ORDER_ALERT_STATUS IN ('Alert','Order','Tactical Evacuation')");
  url.searchParams.set('outFields', QUERY_FIELDS);
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultOffset', String(offset));
  url.searchParams.set('resultRecordCount', String(PAGE_SIZE));
  url.searchParams.set('orderByFields', 'DATE_MODIFIED DESC,EMRG_OAA_SYSID');
  url.searchParams.set('f', 'geojson');
  return url.toString();
}

export async function fetchBcEmergencyInfoAlerts(opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const features = [];
  let offset = 0;
  let exceededTransferLimit = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = buildQueryUrl(offset);
    if (!isAllowedBcAlertsHost(url)) throw new Error(`bc-emergency-info: host is not on the allowlist (${BC_ALERTS_HOST})`);
    const resp = await fetchFn(url, {
      headers: { Accept: 'application/geo+json, application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!resp.ok) throw new Error(`bc-emergency-info: HTTP ${resp.status}`);
    const data = await readLimitedJson(resp, maxBytes);
    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
      throw new Error('bc-emergency-info: body is not a GeoJSON FeatureCollection');
    }
    features.push(...data.features);
    offset += data.features.length;
    exceededTransferLimit = data.properties?.exceededTransferLimit === true;
    if (!exceededTransferLimit || data.features.length === 0) break;
  }

  if (exceededTransferLimit) {
    throw new Error(`bc-emergency-info: pagination remains incomplete after ${MAX_PAGES} pages`);
  }

  return { alerts: parseBcEmergencyInfoGeoJson({ type: 'FeatureCollection', features }) };
}

export function validateBcAlertsEnvelope(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.alerts);
}

export function declareBcAlertRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

export function bcAlertsContentMeta(data, nowMs = Date.now()) {
  const timestamps = (data?.alerts ?? [])
    .map((alert) => alert.updatedAt ?? alert.publishedAt)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= nowMs + 60 * 60 * 1000);
  if (timestamps.length === 0) return null;
  return { newestItemAt: Math.max(...timestamps), oldestItemAt: Math.min(...timestamps) };
}
