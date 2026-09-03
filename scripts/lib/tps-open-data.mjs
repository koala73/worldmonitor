/**
 * Toronto Police Service Open Data — official occurrence and calls-attended
 * datasets (#7012).
 *
 * On-demand only. Do not add the ~486k MCI corpus to FAST/SLOW bootstrap or
 * as a ninth seed-bundle-canada member. Capacity decision: a full MCI walk
 * at the 2,000-record page cap is ~243 pages and cannot fit the Canada
 * bundle's 570s wall budget with margin. Use this bounded worker / on-demand
 * fetch instead.
 *
 * Licence: the applicable Ontario or Toronto Open Government Licence plus TPS
 * item constraints. Credit TPS without crests. No endorsement. Coordinates
 * are deliberately offset — do not snap or geocode further. Do not join for
 * reidentification. One EVENT_UNIQUE_ID can have several offence/victim rows;
 * keep them all.
 *
 * This is not live CAD (#6682) and must not be labelled as live_dispatch.
 */

import { CHROME_UA, MAX_PAYLOAD_BYTES } from '../_seed-utils.mjs';
import {
  TPS_CALLS_KEY,
  TPS_CALLS_META_KEY,
  TPS_CALLS_SEMANTIC,
  TPS_CALLS_SOURCE,
  TPS_MCI_KEY,
  TPS_MCI_META_KEY,
  TPS_MCI_SEMANTIC,
  TPS_MCI_SOURCE,
} from '../shared/toronto-safety.mjs';

export {
  TPS_CALLS_KEY,
  TPS_CALLS_META_KEY,
  TPS_CALLS_SEMANTIC,
  TPS_CALLS_SOURCE,
  TPS_MCI_KEY,
  TPS_MCI_META_KEY,
  TPS_MCI_SEMANTIC,
  TPS_MCI_SOURCE,
};

export const TPS_ARCGIS_HOST = 'services.arcgis.com';
export const TPS_TORONTO_CKAN_HOST = 'ckan0.cf.opendata.inter.prod-toronto.ca';
export const TPS_OPEN_DATA_HOST = 'www.tps.ca';
export const TPS_PORTAL_HOST = 'data.tps.ca';
export const TPS_ALLOWED_HOSTS = Object.freeze([TPS_ARCGIS_HOST]);
export const TPS_OPEN_DATA_PAGE = 'https://www.tps.ca/data-maps/open-data/';
export const TPS_PORTAL_URL = 'https://data.tps.ca/';
export const TPS_MCI_CATALOG_ITEM = '0a239a5563a344a3bbf8452504ed8d68';
export const TPS_CALLS_CATALOG_ITEM = 'bfffadee-e6e5-4404-8455-e67e9ea11ba7';
export const TPS_CALLS_PACKAGE_NAME = 'police-annual-statistical-report-calls-for-service-attended';
export const TPS_CALLS_RESOURCE_NAME = 'Calls for Service Attended';
export const TPS_MCI_LAYER_URL = 'https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators_Open_Data/FeatureServer/0';
export const TPS_MCI_QUERY_URL = `${TPS_MCI_LAYER_URL}/query`;
export const TPS_CALLS_PACKAGE_URL = `https://${TPS_TORONTO_CKAN_HOST}/api/3/action/package_show`;
export const TPS_CALLS_LAYER_URL = `${TPS_CALLS_PACKAGE_URL}?id=${TPS_CALLS_PACKAGE_NAME}`;
export const TPS_CALLS_QUERY_URL = `https://${TPS_TORONTO_CKAN_HOST}/api/3/action/datastore_search`;

export const TPS_MCI_PAGE_CAP = 2000;
export const TPS_CALLS_PAGE_CAP = 1000;
export const TPS_MCI_SERVICE_ITEM_ID = TPS_MCI_CATALOG_ITEM;
export const TPS_CALLS_SERVICE_ITEM_ID = TPS_CALLS_CATALOG_ITEM;

export const TPS_MCI_ID_NS = 'tps-mci';
export const TPS_CALLS_ID_NS = 'tps-calls';

export const TPS_SCHEMA_VERSION = 1;
export const TPS_SOURCE_VERSION = 'tps-open-data-ondemand-v1';
export const TPS_TTL_SECONDS = 24 * 60 * 60;
export const TPS_MAX_STALE_MIN = 20_160; // 14d — retrospective batch, not live CAD
export const TPS_MCI_MAX_CONTENT_AGE_MIN = 120 * 24 * 60;
export const TPS_CALLS_MAX_CONTENT_AGE_MIN = 400 * 24 * 60;
export const TPS_REQUEST_TIMEOUT_MS = 30_000;
export const TPS_DEFAULT_MCI_MAX_PAGES = 3;
export const TPS_DEFAULT_CALLS_MAX_PAGES = 12;
export const TPS_DEFAULT_MCI_LOOKBACK_DAYS = 90;
export const TPS_OGL_ATTRIBUTION = 'Contains information licensed under the Open Government Licence - Ontario.';
export const TPS_TORONTO_OGL_ATTRIBUTION = 'Contains information licensed under the Open Government Licence - Toronto.';

export const TPS_MCI_REQUIRED_FIELDS = Object.freeze([
  'EVENT_UNIQUE_ID',
  'REPORT_DATE',
  'OCC_DATE',
  'DIVISION',
  'LOCATION_TYPE',
  'PREMISES_TYPE',
  'UCR_CODE',
  'UCR_EXT',
  'OFFENCE',
  'CSI_CATEGORY',
  'HOOD_158',
  'NEIGHBOURHOOD_158',
  'LONG_WGS84',
  'LAT_WGS84',
]);

export const TPS_CALLS_REQUIRED_FIELDS = Object.freeze([
  'EVENT_YEAR',
  'DIVISION_ORIGINAL',
  'DIVISION_FINAL',
  'HOOD_158',
  'NEIGHBOURHOOD_158',
  'EVENT_COUNT',
]);

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);

export class TpsOpenDataError extends Error {
  constructor(reason, { status = null, cause = undefined } = {}) {
    super(`tps-open-data: ${reason}`);
    this.name = 'TpsOpenDataError';
    this.reason = reason;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAllowedTpsHost(url, allowedHosts = TPS_ALLOWED_HOSTS) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && allowedHosts.includes(parsed.hostname.toLowerCase())
      && parsed.pathname.startsWith('/S9th0jAJ7bqgIRjw/')
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

export function isAllowedTpsCkanUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === TPS_TORONTO_CKAN_HOST
      && (parsed.pathname === '/api/3/action/package_show'
        || parsed.pathname === '/api/3/action/datastore_search')
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function textOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function utcEpochToIso(value) {
  const ms = finiteNumber(value);
  if (ms == null) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function assertRequiredFields(attributes, required, label) {
  if (!attributes || typeof attributes !== 'object') {
    throw new TpsOpenDataError(`schema_drift:${label}:missing_attributes`);
  }
  for (const field of required) {
    if (!Object.hasOwn(attributes, field)) {
      throw new TpsOpenDataError(`schema_drift:${label}:missing_${field}`);
    }
  }
}

export function normalizeTpsMciFeature(feature) {
  if (!feature || typeof feature !== 'object') {
    throw new TpsOpenDataError('schema_drift:mci:missing_feature');
  }
  const attributes = feature.attributes ?? feature.properties ?? null;
  assertRequiredFields(attributes, TPS_MCI_REQUIRED_FIELDS, 'mci');
  const eventId = textOrNull(attributes.EVENT_UNIQUE_ID);
  const objectId = finiteNumber(attributes.OBJECTID ?? feature.attributes?.ObjectId);
  if (!eventId) throw new TpsOpenDataError('schema_drift:mci:empty_EVENT_UNIQUE_ID');
  if (objectId == null) throw new TpsOpenDataError('schema_drift:mci:missing_OBJECTID');
  const lon = finiteNumber(attributes.LONG_WGS84);
  const lat = finiteNumber(attributes.LAT_WGS84);
  return {
    id: `${TPS_MCI_ID_NS}:${objectId}`,
    objectId,
    eventUniqueId: eventId,
    semantic: TPS_MCI_SEMANTIC,
    source: TPS_MCI_SOURCE,
    official: true,
    live: false,
    reportDate: utcEpochToIso(attributes.REPORT_DATE),
    reportDateMs: finiteNumber(attributes.REPORT_DATE),
    occDate: utcEpochToIso(attributes.OCC_DATE),
    occDateMs: finiteNumber(attributes.OCC_DATE),
    division: textOrNull(attributes.DIVISION),
    locationType: textOrNull(attributes.LOCATION_TYPE),
    premisesType: textOrNull(attributes.PREMISES_TYPE),
    ucrCode: textOrNull(attributes.UCR_CODE),
    ucrExt: textOrNull(attributes.UCR_EXT),
    offence: textOrNull(attributes.OFFENCE),
    csiCategory: textOrNull(attributes.CSI_CATEGORY),
    hood158: textOrNull(attributes.HOOD_158),
    neighbourhood158: textOrNull(attributes.NEIGHBOURHOOD_158),
    hood140: textOrNull(attributes.HOOD_140),
    neighbourhood140: textOrNull(attributes.NEIGHBOURHOOD_140),
    lon,
    lat,
    approximate: true,
    geocoded: false,
    snapped: false,
  };
}

export function normalizeTpsCallsRow(feature) {
  if (!feature || typeof feature !== 'object') {
    throw new TpsOpenDataError('schema_drift:calls:missing_feature');
  }
  const attributes = feature.attributes ?? feature.properties ?? null;
  assertRequiredFields(attributes, TPS_CALLS_REQUIRED_FIELDS, 'calls');
  const objectId = finiteNumber(attributes.ObjectId ?? attributes.OBJECTID);
  if (objectId == null) throw new TpsOpenDataError('schema_drift:calls:missing_ObjectId');
  const eventYear = finiteNumber(attributes.EVENT_YEAR);
  if (eventYear == null) throw new TpsOpenDataError('schema_drift:calls:empty_EVENT_YEAR');
  return {
    id: `${TPS_CALLS_ID_NS}:${objectId}`,
    objectId,
    semantic: TPS_CALLS_SEMANTIC,
    source: TPS_CALLS_SOURCE,
    official: true,
    live: false,
    incidentPoint: false,
    eventYear,
    divisionOriginal: textOrNull(attributes.DIVISION_ORIGINAL),
    divisionFinal: textOrNull(attributes.DIVISION_FINAL),
    hood158: textOrNull(attributes.HOOD_158),
    neighbourhood158: textOrNull(attributes.NEIGHBOURHOOD_158),
    eventCount: finiteNumber(attributes.EVENT_COUNT),
  };
}

export function parseTpsMciFeatures(features) {
  if (!Array.isArray(features)) throw new TpsOpenDataError('schema_drift:mci:features_not_array');
  return features.map((feature) => normalizeTpsMciFeature(feature));
}

export function parseTpsCallsFeatures(features) {
  if (!Array.isArray(features)) throw new TpsOpenDataError('schema_drift:calls:features_not_array');
  return features.map((feature) => normalizeTpsCallsRow(feature));
}

export function buildTpsMciSnapshot({
  records,
  editingInfo = null,
  fetchedAt = new Date().toISOString(),
  truncated = false,
} = {}) {
  const list = Array.isArray(records) ? records : [];
  const dates = list.map((row) => row.reportDateMs).filter((value) => Number.isFinite(value));
  return {
    schemaVersion: TPS_SCHEMA_VERSION,
    semantic: TPS_MCI_SEMANTIC,
    source: TPS_MCI_SOURCE,
    canonicalKey: TPS_MCI_KEY,
    layerUrl: TPS_MCI_LAYER_URL,
    catalogItem: TPS_MCI_CATALOG_ITEM,
    attribution: TPS_OGL_ATTRIBUTION,
    official: true,
    live: false,
    fetchedAt,
    editingInfo,
    newestContentAt: dates.length ? Math.max(...dates) : null,
    newestContentIso: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    truncated,
    records: list,
  };
}

export function buildTpsCallsSnapshot({
  records,
  editingInfo = null,
  fetchedAt = new Date().toISOString(),
  truncated = false,
} = {}) {
  const list = Array.isArray(records) ? records : [];
  const years = list.map((row) => row.eventYear).filter((value) => Number.isFinite(value));
  return {
    schemaVersion: TPS_SCHEMA_VERSION,
    semantic: TPS_CALLS_SEMANTIC,
    source: TPS_CALLS_SOURCE,
    canonicalKey: TPS_CALLS_KEY,
    layerUrl: TPS_CALLS_LAYER_URL,
    catalogItem: TPS_CALLS_CATALOG_ITEM,
    attribution: TPS_TORONTO_OGL_ATTRIBUTION,
    official: true,
    live: false,
    incidentPoint: false,
    fetchedAt,
    editingInfo,
    newestContentYear: years.length ? Math.max(...years) : null,
    truncated,
    records: list,
  };
}

export function validateTpsMciSnapshot(snapshot) {
  return snapshot?.schemaVersion === TPS_SCHEMA_VERSION
    && snapshot?.semantic === TPS_MCI_SEMANTIC
    && snapshot?.source === TPS_MCI_SOURCE
    && snapshot?.official === true
    && snapshot?.live === false
    && Array.isArray(snapshot?.records)
    && snapshot.records.every((row) => row?.approximate === true && row?.geocoded === false && row?.snapped === false);
}

export function validateTpsCallsSnapshot(snapshot) {
  return snapshot?.schemaVersion === TPS_SCHEMA_VERSION
    && snapshot?.semantic === TPS_CALLS_SEMANTIC
    && snapshot?.source === TPS_CALLS_SOURCE
    && snapshot?.official === true
    && snapshot?.live === false
    && snapshot?.incidentPoint === false
    && Array.isArray(snapshot?.records);
}

export function declareTpsRecords(snapshot) {
  return Array.isArray(snapshot?.records) ? snapshot.records.length : 0;
}

/**
 * Health must combine ArcGIS editingInfo.dataLastEditDate with the newest
 * content date/year. Fetch time alone cannot prove freshness.
 */
export function tpsContentMeta(snapshot) {
  const editMs = finiteNumber(snapshot?.editingInfo?.dataLastEditDate);
  const contentMs = finiteNumber(snapshot?.newestContentAt);
  const year = finiteNumber(snapshot?.newestContentYear);
  const yearMs = year != null ? Date.UTC(year, 11, 31) : null;
  const sourceContentMs = snapshot?.semantic === TPS_MCI_SEMANTIC ? contentMs : yearMs;
  if (!Number.isFinite(editMs) || editMs <= 0 || !Number.isFinite(sourceContentMs) || sourceContentMs <= 0) {
    return null;
  }
  const readinessClock = Math.min(editMs, sourceContentMs);
  return {
    newestItemAt: readinessClock,
    oldestItemAt: readinessClock,
    dataLastEditDate: editMs,
    newestContentAt: contentMs,
    newestContentYear: year,
  };
}

export function resolveTpsPublish(fetchResult, lastGood, validateFn) {
  if (fetchResult?.ok && validateFn(fetchResult.snapshot)) {
    return { persist: true, snapshot: fetchResult.snapshot, sourceState: 'ok' };
  }
  if (validateFn(lastGood)) {
    return {
      persist: false,
      keepLastGood: true,
      sourceState: 'degraded',
      reason: fetchResult?.reason || 'shape_break',
    };
  }
  return {
    persist: false,
    keepLastGood: false,
    sourceState: 'unavailable',
    reason: fetchResult?.reason || 'shape_break',
  };
}

export function mciLookbackWhere(nowMs = Date.now(), lookbackDays = TPS_DEFAULT_MCI_LOOKBACK_DAYS) {
  const since = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
  return `REPORT_DATE >= timestamp '${new Date(since).toISOString().slice(0, 19)}'`;
}

function extractFeatures(body) {
  if (Array.isArray(body?.features)) return body.features;
  if (body?.type === 'FeatureCollection' && Array.isArray(body.features)) return body.features;
  return null;
}

function exceededTransferLimit(body) {
  return body?.exceededTransferLimit === true || body?.properties?.exceededTransferLimit === true;
}

export function interpretArcGisPage({ body, pageSize, label }) {
  if (!body || typeof body !== 'object') {
    throw new TpsOpenDataError(`malformed_json:${label}`);
  }
  if (body.error) {
    throw new TpsOpenDataError(`upstream_error:${label}:${body.error?.message || 'error'}`);
  }
  const features = extractFeatures(body);
  if (!Array.isArray(features)) {
    throw new TpsOpenDataError(`schema_drift:${label}:features_not_array`);
  }
  const exceeded = exceededTransferLimit(body);
  if (features.length < pageSize && exceeded) {
    throw new TpsOpenDataError(`partial_page:${label}`);
  }
  return {
    features,
    exceeded,
    done: features.length === 0 || (features.length < pageSize && !exceeded) || (features.length === pageSize && !exceeded),
  };
}

function buildObjectIdsUrl(baseUrl, { where }) {
  const url = new URL(baseUrl);
  url.searchParams.set('where', where);
  url.searchParams.set('returnIdsOnly', 'true');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');
  return url.toString();
}

function buildQueryForm({
  objectIds,
  pageSize,
  outFields,
  orderByFields,
  returnGeometry,
}) {
  const form = new URLSearchParams();
  form.set('objectIds', objectIds.join(','));
  form.set('outFields', outFields);
  form.set('returnGeometry', returnGeometry ? 'true' : 'false');
  form.set('outSR', '4326');
  form.set('resultRecordCount', String(pageSize));
  form.set('orderByFields', orderByFields);
  form.set('f', 'json');
  return form;
}

async function fetchTpsJson(url, {
  fetchImpl,
  timeoutMs,
  maxBytes,
  label,
  isAllowedUrl,
  form = null,
}) {
  if (!isAllowedUrl(url)) throw new TpsOpenDataError(`host_not_allowlisted:${label}`);
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const message = `${err?.message || err}`;
    if (err?.name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
      throw new TpsOpenDataError(`timeout:${label}`, { cause: err });
    }
    throw new TpsOpenDataError(`fetch_failed:${label}`, { cause: err });
  }
  if (!resp.ok) throw new TpsOpenDataError(`http_${resp.status}:${label}`, { status: resp.status });
  return readLimitedJson(resp, maxBytes, label);
}

function fetchArcGisJson(url, options) {
  return fetchTpsJson(url, { ...options, isAllowedUrl: isAllowedTpsHost });
}

function featureObjectId(feature, objectIdField) {
  const value = finiteNumber(feature?.attributes?.[objectIdField] ?? feature?.properties?.[objectIdField]);
  return Number.isInteger(value) ? value : null;
}

function sortArcGisFeatures(features, orderByFields) {
  const clauses = String(orderByFields || '').split(',').map((part) => {
    const [field, direction] = part.trim().split(/\s+/);
    return { field, direction: direction?.toUpperCase() === 'DESC' ? -1 : 1 };
  }).filter((clause) => clause.field);
  return [...features].sort((left, right) => {
    for (const clause of clauses) {
      const a = left?.attributes?.[clause.field] ?? left?.properties?.[clause.field];
      const b = right?.attributes?.[clause.field] ?? right?.properties?.[clause.field];
      if (a == null && b != null) return 1;
      if (a != null && b == null) return -1;
      if (a < b) return -1 * clause.direction;
      if (a > b) return 1 * clause.direction;
    }
    return 0;
  });
}

async function readLimitedJson(resp, maxBytes, label) {
  const contentLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new TpsOpenDataError(`payload_too_large:${label}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new TpsOpenDataError(`payload_too_large:${label}`);
  }
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new TpsOpenDataError(`malformed_json:${label}`); }
}

export async function queryArcGisPages({
  queryUrl,
  pageSize,
  maxPages,
  where = '1=1',
  outFields = '*',
  orderByFields,
  objectIdField = 'OBJECTID',
  returnGeometry = false,
  fetchImpl = DEFAULT_FETCH,
  timeoutMs = TPS_REQUEST_TIMEOUT_MS,
  maxBytes = MAX_PAYLOAD_BYTES,
  label = 'arcgis',
} = {}) {
  if (!isAllowedTpsHost(queryUrl)) {
    throw new TpsOpenDataError(`host_not_allowlisted:${label}`);
  }
  const idsBody = await fetchArcGisJson(buildObjectIdsUrl(queryUrl, { where }), {
    fetchImpl, timeoutMs, maxBytes, label: `${label}:ids`,
  });
  if (idsBody?.error) throw new TpsOpenDataError(`upstream_error:${label}:ids:${idsBody.error?.message || 'error'}`);
  if (!Array.isArray(idsBody?.objectIds)) throw new TpsOpenDataError(`schema_drift:${label}:object_ids_not_array`);
  if (idsBody.objectIdFieldName && idsBody.objectIdFieldName !== objectIdField) {
    throw new TpsOpenDataError(`schema_drift:${label}:object_id_field_${idsBody.objectIdFieldName}`);
  }
  const objectIds = idsBody.objectIds.map((value) => finiteNumber(value));
  if (objectIds.some((value) => !Number.isInteger(value))) {
    throw new TpsOpenDataError(`schema_drift:${label}:invalid_object_id`);
  }
  if (new Set(objectIds).size !== objectIds.length) {
    throw new TpsOpenDataError(`schema_drift:${label}:duplicate_object_id_snapshot`);
  }
  if (objectIds.length > pageSize * maxPages) {
    throw new TpsOpenDataError(`pagination_incomplete:${label}:max_pages_${maxPages}`);
  }
  if (objectIds.length === 0) return { features: [], truncated: false, pages: 0 };

  const features = [];
  for (let page = 0; page * pageSize < objectIds.length; page += 1) {
    const pageIds = objectIds.slice(page * pageSize, (page + 1) * pageSize);
    const form = buildQueryForm({
      objectIds: pageIds,
      pageSize,
      outFields,
      orderByFields,
      returnGeometry,
    });
    const body = await fetchArcGisJson(queryUrl, {
      fetchImpl,
      timeoutMs,
      maxBytes,
      label,
      form,
    });
    if (body?.error) throw new TpsOpenDataError(`upstream_error:${label}:${body.error?.message || 'error'}`);
    const pageFeatures = extractFeatures(body);
    if (!Array.isArray(pageFeatures)) throw new TpsOpenDataError(`schema_drift:${label}:features_not_array`);
    if (exceededTransferLimit(body)) throw new TpsOpenDataError(`partial_page:${label}`);
    const returnedIds = pageFeatures.map((feature) => featureObjectId(feature, objectIdField));
    if (returnedIds.some((value) => value == null) || new Set(returnedIds).size !== returnedIds.length) {
      throw new TpsOpenDataError(`schema_drift:${label}:invalid_page_object_ids`);
    }
    const pageIdSet = new Set(pageIds);
    if (returnedIds.length !== pageIds.length || returnedIds.some((id) => !pageIdSet.has(id))) {
      throw new TpsOpenDataError(`pagination_incomplete:${label}:object_id_mismatch`);
    }
    features.push(...pageFeatures);
  }
  const fetchedIds = features.map((feature) => featureObjectId(feature, objectIdField));
  const fetchedIdSet = new Set(fetchedIds);
  if (fetchedIds.length !== objectIds.length || fetchedIdSet.size !== objectIds.length
      || objectIds.some((id) => !fetchedIdSet.has(id))) {
    throw new TpsOpenDataError(`pagination_incomplete:${label}:object_id_set_mismatch`);
  }
  return {
    features: sortArcGisFeatures(features, orderByFields),
    truncated: false,
    pages: Math.ceil(objectIds.length / pageSize),
  };
}

async function fetchTpsCkanJson(url, {
  fetchImpl,
  timeoutMs,
  maxBytes,
  label,
}) {
  return fetchTpsJson(url, {
    fetchImpl,
    timeoutMs,
    maxBytes,
    label,
    isAllowedUrl: isAllowedTpsCkanUrl,
  });
}

function ckanTimestampToEpoch(value) {
  const timestamp = textOrNull(value);
  if (!timestamp) return null;
  const normalized = /(?:z|[+-]\d\d:\d\d)$/i.test(timestamp) ? timestamp : `${timestamp}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveTpsCallsPackage(body) {
  if (!body || typeof body !== 'object') {
    throw new TpsOpenDataError('malformed_json:calls:package');
  }
  if (body.success !== true || !body.result || typeof body.result !== 'object') {
    throw new TpsOpenDataError('upstream_error:calls:package');
  }
  const packageId = textOrNull(body.result.id);
  if (packageId !== TPS_CALLS_SERVICE_ITEM_ID) {
    throw new TpsOpenDataError(`service_item_mismatch:calls:${packageId || 'missing'}`);
  }
  const packageName = textOrNull(body.result.name);
  if (packageName !== TPS_CALLS_PACKAGE_NAME) {
    throw new TpsOpenDataError(`package_name_mismatch:calls:${packageName || 'missing'}`);
  }
  if (!Array.isArray(body.result.resources)) {
    throw new TpsOpenDataError('schema_drift:calls:resources_not_array');
  }
  const resources = body.result.resources.filter((resource) => (
    resource?.datastore_active === true
    && textOrNull(resource?.name) === TPS_CALLS_RESOURCE_NAME
    && textOrNull(resource?.format)?.toUpperCase() === 'JSON'
  ));
  if (resources.length === 0) throw new TpsOpenDataError('schema_drift:calls:active_resource_missing');
  if (resources.length > 1) throw new TpsOpenDataError('schema_drift:calls:active_resource_ambiguous');
  const resourceId = textOrNull(resources[0].id);
  if (!resourceId) throw new TpsOpenDataError('schema_drift:calls:resource_id_missing');
  const dataLastEditDate = ckanTimestampToEpoch(body.result.metadata_modified);
  if (dataLastEditDate == null) {
    throw new TpsOpenDataError('schema_drift:calls:metadata_modified_invalid');
  }
  return {
    resourceId,
    editingInfo: { dataLastEditDate, lastEditDate: dataLastEditDate },
  };
}

function interpretTpsCallsPage(body, { resourceId, expectedTotal }) {
  if (!body || typeof body !== 'object') {
    throw new TpsOpenDataError('malformed_json:calls');
  }
  if (body.success !== true || !body.result || typeof body.result !== 'object') {
    throw new TpsOpenDataError('upstream_error:calls');
  }
  if (body.result.resource_id !== resourceId) {
    throw new TpsOpenDataError('schema_drift:calls:resource_id_mismatch');
  }
  const total = finiteNumber(body.result.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new TpsOpenDataError('schema_drift:calls:invalid_total');
  }
  if (expectedTotal != null && total !== expectedTotal) {
    throw new TpsOpenDataError('pagination_incomplete:calls:total_changed');
  }
  if (!Array.isArray(body.result.fields)) {
    throw new TpsOpenDataError('schema_drift:calls:fields_not_array');
  }
  const fields = body.result.fields.map((field) => textOrNull(field?.id)).filter(Boolean);
  const missing = ['_id', ...TPS_CALLS_REQUIRED_FIELDS].filter((field) => !fields.includes(field));
  if (missing.length) {
    throw new TpsOpenDataError(`schema_drift:calls:datastore_missing_${missing.join(',')}`);
  }
  if (!Array.isArray(body.result.records)) {
    throw new TpsOpenDataError('schema_drift:calls:records_not_array');
  }
  return { total, records: body.result.records };
}

async function queryTpsCallsPages({
  resourceId,
  pageSize,
  maxPages,
  fetchImpl,
  timeoutMs = TPS_REQUEST_TIMEOUT_MS,
  maxBytes = MAX_PAYLOAD_BYTES,
}) {
  const rows = [];
  const objectIds = new Set();
  let total = null;
  let pages = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const url = new URL(TPS_CALLS_QUERY_URL);
    url.searchParams.set('resource_id', resourceId);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sort', 'EVENT_YEAR desc, _id asc');
    const body = await fetchTpsCkanJson(url.toString(), {
      fetchImpl,
      timeoutMs,
      maxBytes,
      label: 'calls',
    });
    const interpreted = interpretTpsCallsPage(body, { resourceId, expectedTotal: total });
    total = interpreted.total;
    if (total > pageSize * maxPages) {
      throw new TpsOpenDataError(`pagination_incomplete:calls:max_pages_${maxPages}`);
    }
    const expectedRows = Math.min(pageSize, Math.max(0, total - offset));
    if (interpreted.records.length !== expectedRows) {
      throw new TpsOpenDataError('pagination_incomplete:calls:partial_page');
    }
    for (const row of interpreted.records) {
      const objectId = finiteNumber(row?._id);
      if (!Number.isInteger(objectId) || objectIds.has(objectId)) {
        throw new TpsOpenDataError('schema_drift:calls:invalid_object_id');
      }
      objectIds.add(objectId);
      rows.push({ attributes: { ...row, ObjectId: objectId } });
    }
    pages += 1;
    if (rows.length === total) break;
  }

  if (total == null || rows.length !== total) {
    throw new TpsOpenDataError(`pagination_incomplete:calls:max_pages_${maxPages}`);
  }
  return {
    features: sortArcGisFeatures(rows, 'EVENT_YEAR DESC,ObjectId'),
    truncated: false,
    pages,
  };
}

export async function fetchTpsLayerMetadata(layerUrl, {
  fetchImpl = DEFAULT_FETCH,
  timeoutMs = TPS_REQUEST_TIMEOUT_MS,
} = {}) {
  const url = `${layerUrl}?f=pjson`;
  const body = await fetchArcGisJson(url, {
    fetchImpl,
    timeoutMs,
    maxBytes: MAX_PAYLOAD_BYTES,
    label: 'metadata',
  });
  return {
    maxRecordCount: finiteNumber(body.maxRecordCount),
    editingInfo: body.editingInfo ?? null,
    fields: Array.isArray(body.fields) ? body.fields.map((field) => field.name) : [],
    serviceItemId: textOrNull(body.serviceItemId),
  };
}

export async function fetchTpsMci({
  fetchImpl = DEFAULT_FETCH,
  pageSize = TPS_MCI_PAGE_CAP,
  maxPages = TPS_DEFAULT_MCI_MAX_PAGES,
  lookbackDays = TPS_DEFAULT_MCI_LOOKBACK_DAYS,
  where = null,
  now = Date.now(),
  metadata = null,
} = {}) {
  try {
    const layerMeta = metadata ?? await fetchTpsLayerMetadata(TPS_MCI_LAYER_URL, { fetchImpl });
    if (layerMeta.serviceItemId !== TPS_MCI_SERVICE_ITEM_ID) {
      throw new TpsOpenDataError(`service_item_mismatch:mci:${layerMeta.serviceItemId || 'missing'}`);
    }
    if (layerMeta.maxRecordCount != null && pageSize > layerMeta.maxRecordCount) {
      throw new TpsOpenDataError(`page_exceeds_cap:mci:${layerMeta.maxRecordCount}`);
    }
    const missing = TPS_MCI_REQUIRED_FIELDS.filter((field) => layerMeta.fields.length && !layerMeta.fields.includes(field));
    if (missing.length) {
      throw new TpsOpenDataError(`schema_drift:mci:layer_missing_${missing.join(',')}`);
    }
    const paged = await queryArcGisPages({
      queryUrl: TPS_MCI_QUERY_URL,
      pageSize: Math.min(pageSize, TPS_MCI_PAGE_CAP),
      maxPages,
      where: where ?? mciLookbackWhere(now, lookbackDays),
      outFields: [...TPS_MCI_REQUIRED_FIELDS, 'OBJECTID', 'HOOD_140', 'NEIGHBOURHOOD_140'].join(','),
      orderByFields: 'REPORT_DATE DESC,OBJECTID',
      objectIdField: 'OBJECTID',
      returnGeometry: false,
      fetchImpl,
      label: 'mci',
    });
    const records = parseTpsMciFeatures(paged.features);
    const snapshot = buildTpsMciSnapshot({
      records,
      editingInfo: layerMeta.editingInfo,
      fetchedAt: new Date(now).toISOString(),
    });
    if (!validateTpsMciSnapshot(snapshot)) {
      return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
    }
    return { ok: true, snapshot };
  } catch (err) {
    return {
      ok: false,
      sourceState: 'unavailable',
      reason: err?.reason || 'fetch_failed',
      status: err?.status ?? null,
    };
  }
}

export async function fetchTpsCallsAttended({
  fetchImpl = DEFAULT_FETCH,
  pageSize = TPS_CALLS_PAGE_CAP,
  maxPages = TPS_DEFAULT_CALLS_MAX_PAGES,
  now = Date.now(),
  metadata = null,
} = {}) {
  try {
    const packageUrl = new URL(TPS_CALLS_PACKAGE_URL);
    packageUrl.searchParams.set('id', TPS_CALLS_PACKAGE_NAME);
    const packageBody = metadata ?? await fetchTpsCkanJson(packageUrl.toString(), {
      fetchImpl,
      timeoutMs: TPS_REQUEST_TIMEOUT_MS,
      maxBytes: MAX_PAYLOAD_BYTES,
      label: 'calls:package',
    });
    const packageMeta = resolveTpsCallsPackage(packageBody);
    const paged = await queryTpsCallsPages({
      resourceId: packageMeta.resourceId,
      pageSize: Math.min(pageSize, TPS_CALLS_PAGE_CAP),
      maxPages,
      fetchImpl,
    });
    const records = parseTpsCallsFeatures(paged.features);
    const snapshot = buildTpsCallsSnapshot({
      records,
      editingInfo: packageMeta.editingInfo,
      fetchedAt: new Date(now).toISOString(),
    });
    if (!validateTpsCallsSnapshot(snapshot)) {
      return { ok: false, sourceState: 'unavailable', reason: 'shape_break' };
    }
    return { ok: true, snapshot };
  } catch (err) {
    return {
      ok: false,
      sourceState: 'unavailable',
      reason: err?.reason || 'fetch_failed',
      status: err?.status ?? null,
    };
  }
}

/**
 * Combined on-demand fetch. One source failing must not erase the other.
 */
export async function fetchTpsOpenData({
  fetchImpl = DEFAULT_FETCH,
  lastGood = { mci: null, calls: null },
  now = Date.now(),
} = {}) {
  const [mciResult, callsResult] = await Promise.all([
    fetchTpsMci({ fetchImpl, now }),
    fetchTpsCallsAttended({ fetchImpl, now }),
  ]);
  return {
    mci: resolveTpsPublish(mciResult, lastGood.mci, validateTpsMciSnapshot),
    calls: resolveTpsPublish(callsResult, lastGood.calls, validateTpsCallsSnapshot),
  };
}
