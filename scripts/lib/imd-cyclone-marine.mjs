/**
 * IMD cyclone, port, coastal, and marine products (#7005).
 *
 * Not district/nowcast (#7004) and not NDMA SACHET (#7002).
 * Products stay typed. They are not merged into weather:alerts:v1.
 *
 * Live fetch requires an API key. Disabled is not all-clear.
 */

import { CHROME_UA, roundGeoCoordinate } from '../_seed-utils.mjs';

export const IMD_HOST = 'api.imd.gov.in';
export const IMD_API_ORIGIN = 'https://api.imd.gov.in';
export const IMD_API_REFERENCE_URL = 'https://api.imd.gov.in/public/api_reference.html';
export const IMD_RSMC_URL = 'https://rsmcnewdelhi.imd.gov.in/';
export const IMD_PORT_WARNING_PAGE = 'https://rsmcnewdelhi.imd.gov.in/port-warning.php';
export const IMD_SEA_BULLETIN_PAGE = 'https://mausam.imd.gov.in/responsive/marine_forecast.php';
export const IMD_COASTAL_BULLETIN_PAGE = 'https://mausam.imd.gov.in/responsive/coastal_forecast.php';
export const IMD_SOURCE_NAME = 'India Meteorological Department';
export const IMD_CANONICAL_KEY = 'weather:imd-cyclone-marine:v1';
export const IMD_SOURCE_VERSION = 'imd-cyclone-marine-v1';
export const IMD_MAX_BYTES = 2 * 1024 * 1024;
export const IMD_TIMEOUT_MS = 15_000;
export const IMD_MAX_CONTENT_AGE_MIN = 3 * 24 * 60;
export const IMD_COUNTRY = 'IN';

export const IMD_PRODUCTS = Object.freeze({
  cycloneTrack: Object.freeze({
    id: 'cycloneTrack',
    kind: 'cyclone-track',
    path: '/api/v1/cyclone_track',
    schema: 'documented',
    sourceUrl: IMD_RSMC_URL,
  }),
  cycloneWind: Object.freeze({
    id: 'cycloneWind',
    kind: 'cyclone-wind',
    path: '/api/v1/cyclone_wind',
    schema: 'documented',
    sourceUrl: IMD_RSMC_URL,
    geometryKind: 'forecast-wind-radii',
  }),
  cycloneCou: Object.freeze({
    id: 'cycloneCou',
    kind: 'cyclone-cone',
    path: '/api/v1/cyclone_cou',
    schema: 'documented',
    sourceUrl: IMD_RSMC_URL,
    geometryKind: 'cone-of-uncertainty',
  }),
  portWarning: Object.freeze({
    id: 'portWarning',
    kind: 'port-warning',
    path: '/api/v1/portwarning',
    schema: 'documented',
    sourceUrl: IMD_PORT_WARNING_PAGE,
  }),
  seaBulletin: Object.freeze({
    id: 'seaBulletin',
    kind: 'sea-area-bulletin',
    path: '/api/v1/seabulletin',
    schema: 'documented',
    sourceUrl: IMD_SEA_BULLETIN_PAGE,
  }),
  coastalBulletin: Object.freeze({
    id: 'coastalBulletin',
    kind: 'coastal-bulletin',
    path: '/api/v1/coastalbulletin',
    schema: 'documented',
    sourceUrl: IMD_COASTAL_BULLETIN_PAGE,
  }),
  fishermenWarning: Object.freeze({
    id: 'fishermenWarning',
    kind: 'fishermen-warning',
    path: '/api/v1/fishermenwarning',
    schema: 'undocumented',
    sourceUrl: IMD_API_REFERENCE_URL,
    disabledReason: 'INDEXED_WITHOUT_FIELD_REFERENCE',
  }),
});

export const IMD_PRODUCT_IDS = Object.freeze(Object.keys(IMD_PRODUCTS));

export const IMD_RIGHTS_DECISION = Object.freeze({
  status: 'reviewed',
  redistribution: 'validated',
  publicDisplay: 'validated',
  retention: 'validated',
  commercialUse: 'rti-non-commercial-only',
  attribution: 'Data source: India Meteorological Department. Link the official product page.',
  references: Object.freeze([
    IMD_API_REFERENCE_URL,
    'https://internal.imd.gov.in/section/rti/rticases/20260112_rti_211.pdf',
  ]),
});

const NIL_RE = /^(?:nil(?:\s+at\s+all\s+ports)?|n\/?a|none|no\s+warning|-)?$/i;
const WIND_THRESHOLDS_KT = Object.freeze(['27kt', '34kt', '50kt', '64kt']);

/** Gazetteer precision only — not official IMD polygons. */
export const IMD_AREA_CENTROIDS = Object.freeze({
  mumbai: [72.85, 18.95],
  kandla: [70.22, 23.03],
  mundra: [69.71, 22.74],
  chennai: [80.29, 13.08],
  kolkata: [88.31, 22.55],
  visakhapatnam: [83.29, 17.69],
  kochi: [76.27, 9.97],
  cochin: [76.27, 9.97],
  paradip: [86.67, 20.26],
  tuticorin: [78.17, 8.75],
  mangalore: [74.83, 12.92],
  mormugao: [73.80, 15.40],
  ennore: [80.33, 13.26],
  haldia: [88.06, 22.03],
  'port blair': [92.74, 11.67],
  'south west bay': [84.0, 12.0],
  'bay of bengal': [88.0, 15.0],
  'andaman sea': [94.0, 10.0],
  'arabian sea': [68.0, 15.0],
  'south tamilnadu coast': [78.5, 8.5],
  'west coast': [72.5, 15.0],
  'east coast': [84.0, 16.0],
});

export function imdProductUrl(product) {
  return `${IMD_API_ORIGIN}${product.path}`;
}

export function isAllowedImdHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === IMD_HOST
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

export function isNilText(value) {
  return NIL_RE.test(String(value || '').trim());
}

export function asFiniteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validLonLat(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat)
    && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180;
}

export function parseImdTrackDateTime(raw) {
  const match = String(raw || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{2})\/(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[3]) + (Number(match[3]) >= 70 ? 1900 : 2000);
  const ms = Date.UTC(year, Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]));
  return Number.isFinite(ms) ? ms : null;
}

export function parseImdDateTime(raw, { assumeIst = false } = {}) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(assumeIst ? `${text}T00:00:00+05:30` : `${text}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(isoish)) {
    const ms = Date.parse(isoish);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(`${isoish}${assumeIst ? '+05:30' : 'Z'}`);
  return Number.isFinite(ms) ? ms : null;
}

export function lookupAreaCentroid(name) {
  const key = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (IMD_AREA_CENTROIDS[key]) return IMD_AREA_CENTROIDS[key];
  for (const [label, pair] of Object.entries(IMD_AREA_CENTROIDS)) {
    if (key.includes(label) || label.includes(key)) return pair;
  }
  return null;
}

export function imdApiKey(env = process.env) {
  const key = String(env.IMD_API_KEY || '').trim();
  return key || null;
}

function imdApiKeyHeader(env = process.env) {
  return String(env.IMD_API_KEY_HEADER || 'X-API-Key').trim() || 'X-API-Key';
}

function imdLiveFetchDisabledReason(env = process.env) {
  const key = imdApiKey(env);
  if (!key) return 'IMD_API_KEY_MISSING';
  if (!/^[\u0009\u0020-\u007E\u0080-\u00FF]+$/.test(key)) return 'IMD_API_KEY_INVALID';
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(imdApiKeyHeader(env))
    ? null
    : 'IMD_API_KEY_HEADER_INVALID';
}

export function imdLiveFetchEnabled(env = process.env) {
  return imdLiveFetchDisabledReason(env) === null;
}

function field(row, ...names) {
  if (!row || typeof row !== 'object') return '';
  for (const name of names) {
    if (row[name] != null && String(row[name]).trim() !== '') return row[name];
  }
  const keys = Object.keys(row);
  for (const name of names) {
    const match = keys.find((key) => key.toLowerCase().replace(/[\s_]+/g, '') === name.toLowerCase().replace(/[\s_]+/g, ''));
    if (match != null && row[match] != null && String(row[match]).trim() !== '') return row[match];
  }
  return '';
}

function slug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function roundPair(lon, lat) {
  return [roundGeoCoordinate(lon), roundGeoCoordinate(lat)];
}

export function validateLonLatRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const out = [];
  for (const pair of ring) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const lon = asFiniteNumber(pair[0]);
    const lat = asFiniteNumber(pair[1]);
    if (!validLonLat(lon, lat)) return null;
    out.push(roundPair(lon, lat));
  }
  return out;
}

export function parseMultiPolygon(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const type = String(geometry.type || '').trim();
  if (type !== 'MultiPolygon' && type !== 'Polygon') return null;
  const raw = geometry.coordinates;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const polygons = type === 'Polygon' ? [raw] : raw;
  const out = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) return null;
    const rings = [];
    for (const ring of polygon) {
      const validated = validateLonLatRing(ring);
      if (!validated) return null;
      rings.push(validated);
    }
    out.push(rings);
  }
  return out;
}

export function parseCycloneTrackPoint(row, pointKind) {
  if (pointKind !== 'observed' && pointKind !== 'forecast') return null;
  const lat = asFiniteNumber(field(row, 'lat', 'Latitude'));
  const lon = asFiniteNumber(field(row, 'lon', 'Longitude', 'lng'));
  if (!validLonLat(lon, lat)) return null;
  const rawTime = field(row, 'Date/Time', 'DateTime', 'datetime');
  const at = parseImdTrackDateTime(rawTime);
  const name = String(field(row, 'CYCLONE_NAME', 'Cyclone_Name', 'name') || '').trim();
  const category = String(field(row, 'Category', 'category') || '').trim();
  const windKt = asFiniteNumber(field(row, 'MSW (kt)', 'MSW_kt', 'mswKt'));
  const meanMswKmph = asFiniteNumber(field(row, 'Mean MSW (kmph)', 'Mean_MSW_kmph'));
  const mswRangeKmph = String(field(row, 'MSW range (kmph)', 'MSW_range_kmph') || '').trim();
  const hour = String(field(row, 'Hour', 'hour') || '').trim();
  return {
    product: 'cycloneTrack',
    kind: 'cyclone-track',
    pointKind,
    geometryKind: pointKind === 'observed' ? 'observed-position' : 'forecast-position',
    id: `imd-cyclone-${slug(name)}-${pointKind}-${slug(rawTime || hour)}`,
    stormName: name,
    category,
    lat: roundGeoCoordinate(lat),
    lon: roundGeoCoordinate(lon),
    at,
    rawTime,
    hour,
    windKt,
    meanMswKmph,
    mswRangeKmph,
    countryCode: IMD_COUNTRY,
    issuedBy: 'RSMC New Delhi / IMD',
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_RSMC_URL,
    source: 'imd-cyclone-track',
  };
}

export function parseCycloneTrackPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!data || typeof data !== 'object') {
    throw new TypeError('cyclone_track payload is missing data');
  }
  const observed = Array.isArray(data.observed) ? data.observed : [];
  const forecast = Array.isArray(data.forecast) ? data.forecast : [];
  const records = [];
  for (const row of observed) {
    const point = parseCycloneTrackPoint(row, 'observed');
    if (point) records.push(point);
  }
  for (const row of forecast) {
    const point = parseCycloneTrackPoint(row, 'forecast');
    if (point) records.push(point);
  }
  return records;
}

export function parseCycloneWindPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!data || typeof data !== 'object') {
    throw new TypeError('cyclone_wind payload is missing data');
  }
  const records = [];
  for (const threshold of WIND_THRESHOLDS_KT) {
    const geometry = data[threshold];
    if (geometry == null) continue;
    const polygons = parseMultiPolygon(geometry);
    if (!polygons) {
      throw new TypeError(`cyclone_wind ${threshold} is not a valid MultiPolygon`);
    }
    const kt = Number.parseInt(threshold, 10);
    records.push({
      product: 'cycloneWind',
      kind: 'cyclone-wind',
      geometryKind: 'forecast-wind-radii',
      id: `imd-cyclone-wind-${threshold}`,
      thresholdKt: Number.isFinite(kt) ? kt : null,
      thresholdLabel: threshold,
      polygons,
      countryCode: IMD_COUNTRY,
      issuedBy: 'RSMC New Delhi / IMD',
      sourceName: IMD_SOURCE_NAME,
      sourceUrl: IMD_RSMC_URL,
      source: 'imd-cyclone-wind',
    });
  }
  return records;
}

export function parseCycloneCouPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const polygons = parseMultiPolygon(data);
  if (!polygons) throw new TypeError('cyclone_cou payload is not a valid MultiPolygon');
  return [{
    product: 'cycloneCou',
    kind: 'cyclone-cone',
    geometryKind: 'cone-of-uncertainty',
    id: 'imd-cyclone-cou',
    polygons,
    countryCode: IMD_COUNTRY,
    issuedBy: 'RSMC New Delhi / IMD',
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_RSMC_URL,
    source: 'imd-cyclone-cou',
  }];
}

export function parsePortWarningRow(row) {
  const portId = String(field(row, 'Port Id', 'Port_Id', 'PortId', 'Id') || '').trim();
  const portName = String(field(row, 'Port Name', 'Port_Name', 'PortName') || '').trim();
  const warning = String(field(row, 'Warning', 'warning') || '').trim();
  const issuedBy = String(field(row, 'Issued By', 'Issued_By', 'IssuedBy') || '').trim();
  const dateOfIssue = String(field(row, 'Date of Issue', 'Date_of_Issue', 'Date') || '').trim();
  if (!portId && !portName) return null;
  const issuedAt = parseImdDateTime(dateOfIssue, { assumeIst: true });
  const centroid = lookupAreaCentroid(portName);
  const nil = isNilText(warning);
  return {
    product: 'portWarning',
    kind: 'port-warning',
    id: `imd-port-${slug(portId || portName)}-${slug(dateOfIssue)}`,
    portId,
    portName,
    issuedBy,
    dateOfIssue,
    issuedAt,
    warning,
    isNil: nil,
    isWarning: !nil,
    centroid,
    lon: centroid ? centroid[0] : null,
    lat: centroid ? centroid[1] : null,
    countryCode: IMD_COUNTRY,
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_PORT_WARNING_PAGE,
    source: 'imd-port-warning',
  };
}

export function parsePortWarningPayload(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload ? [payload] : [];
  return rows.map(parsePortWarningRow).filter(Boolean);
}

function parseMarineBulletinRow(row, product) {
  const spec = IMD_PRODUCTS[product];
  const id = String(field(row, 'Id', 'ID') || '').trim();
  const layer = String(field(row, 'Layer', 'layer') || '').trim();
  const issuedBy = String(field(row, 'Issued by', 'Issued_by', 'IssuedBy') || '').trim();
  const dateOfObservation = String(field(row, 'Date of Observation', 'Date_of_Observation') || '').trim();
  const validFromRaw = String(field(row, 'Valid From', 'Valid_From', 'ValidFrom') || '').trim();
  const validityHours = asFiniteNumber(field(row, 'Validity', 'validity'));
  const tttWarning = String(field(row, 'TTT Warning', 'TTT_Warning', 'TTTWarning') || '').trim();
  const wind = String(field(row, 'Wind', 'wind') || '').trim();
  const visibility = String(field(row, 'Visibility', 'visibility') || '').trim();
  const seaCondition = String(field(row, 'Sea Condition', 'Sea_Condition', 'seaCondition') || '').trim();
  const weather = String(field(row, 'Weather', 'weather') || '').trim();
  const synoptic = String(field(row, 'Synoptic Situation', 'Synoptic_Situation') || '').trim();
  const portSignal = String(field(row, 'Port Signal', 'Port_Signal', 'PortSignal') || '').trim();
  const updateTime = String(field(row, 'Update Time', 'Update_Time', 'UpdateTime') || '').trim();
  const validFrom = parseImdDateTime(validFromRaw, { assumeIst: true });
  const updatedAt = parseImdDateTime(updateTime, { assumeIst: true });
  const expiresAt = validFrom != null && validityHours != null && validityHours > 0
    ? validFrom + validityHours * 60 * 60 * 1000
    : null;
  const centroid = lookupAreaCentroid(layer);
  const tttNil = isNilText(tttWarning);
  const portSignalNil = isNilText(portSignal);
  if (!id && !layer) return null;
  return {
    product,
    kind: spec.kind,
    id: `imd-${product}-${slug(id || layer)}-${slug(validFromRaw || dateOfObservation)}`,
    bulletinId: id,
    area: layer,
    issuedBy,
    dateOfObservation,
    validFromRaw,
    validFrom,
    validityHours,
    expiresAt,
    updatedAt,
    tttWarning,
    hasTttWarning: !tttNil,
    wind,
    visibility,
    seaCondition,
    weather,
    synopticSituation: synoptic,
    portSignal: portSignal || null,
    hasPortSignal: product === 'coastalBulletin' && !portSignalNil,
    isForecastBulletin: true,
    centroid,
    lon: centroid ? centroid[0] : null,
    lat: centroid ? centroid[1] : null,
    countryCode: IMD_COUNTRY,
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: spec.sourceUrl,
    source: `imd-${spec.kind}`,
  };
}

export function parseSeaBulletinPayload(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload ? [payload] : [];
  return rows.map((row) => parseMarineBulletinRow(row, 'seaBulletin')).filter(Boolean);
}

export function parseCoastalBulletinPayload(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload ? [payload] : [];
  return rows.map((row) => parseMarineBulletinRow(row, 'coastalBulletin')).filter(Boolean);
}

export function parseImdProductPayload(productId, payload) {
  switch (productId) {
    case 'cycloneTrack': return parseCycloneTrackPayload(payload);
    case 'cycloneWind': return parseCycloneWindPayload(payload);
    case 'cycloneCou': return parseCycloneCouPayload(payload);
    case 'portWarning': return parsePortWarningPayload(payload);
    case 'seaBulletin': return parseSeaBulletinPayload(payload);
    case 'coastalBulletin': return parseCoastalBulletinPayload(payload);
    case 'fishermenWarning':
      throw new Error('FISHERMEN_WARNING_SCHEMA_UNDOCUMENTED');
    default:
      throw new Error(`UNKNOWN_IMD_PRODUCT:${productId}`);
  }
}

function recordStamp(record) {
  const stamp = record?.updatedAt ?? record?.issuedAt ?? record?.at ?? record?.validFrom;
  return Number.isFinite(stamp) ? stamp : null;
}

function isImdGeometryProduct(product) {
  return product === 'cycloneWind' || product === 'cycloneCou';
}

export function stampImdGeometryRecords(records, nowMs) {
  return (records || []).map((record) => {
    if (!isImdGeometryProduct(record?.product)) return record;
    if (recordStamp(record) != null) return record;
    return { ...record, updatedAt: nowMs };
  });
}

export function dropExpiredRecords(records, nowMs = Date.now()) {
  const horizon = nowMs - IMD_MAX_CONTENT_AGE_MIN * 60 * 1000;
  return (records || []).filter((record) => {
    if (record?.expiresAt != null && Number.isFinite(record.expiresAt) && record.expiresAt <= nowMs) {
      return false;
    }
    const stamp = recordStamp(record);
    if (isImdGeometryProduct(record?.product) && stamp == null) return false;
    if (stamp != null && stamp < horizon) return false;
    return true;
  });
}

export function dedupeRecords(records) {
  const byId = new Map();
  for (const record of records || []) {
    if (!record?.id) continue;
    const existing = byId.get(record.id);
    const stamp = recordStamp(record) ?? 0;
    const existingStamp = recordStamp(existing) ?? 0;
    if (!existing || stamp >= existingStamp) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function productHealth({
  status,
  reason = null,
  recordCount = 0,
  warningCount = 0,
  carried = false,
  requestCount = 0,
} = {}) {
  return {
    status,
    reason,
    recordCount,
    warningCount,
    carried,
    requestCount,
    emptyMeans: status === 'ok' && recordCount === 0 ? 'no-active-product' : null,
  };
}

export function emptyProductHealth(productId, status, reason) {
  return productHealth({ status, reason, recordCount: 0, warningCount: 0, requestCount: 0 });
}

function warningCountFor(productId, records) {
  if (productId === 'portWarning') return records.filter((row) => row.isWarning).length;
  if (productId === 'seaBulletin' || productId === 'coastalBulletin') {
    return records.filter((row) => row.hasTttWarning || row.hasPortSignal).length;
  }
  if (productId === 'cycloneTrack') return records.filter((row) => row.pointKind === 'observed' || row.pointKind === 'forecast').length;
  return records.length;
}

export function buildDisabledSnapshot({ now = Date.now(), reason = 'IMD_API_KEY_MISSING' } = {}) {
  const products = {};
  for (const id of IMD_PRODUCT_IDS) {
    const undocumented = IMD_PRODUCTS[id].schema === 'undocumented';
    products[id] = emptyProductHealth(
      id,
      undocumented ? 'disabled' : 'disabled',
      undocumented ? IMD_PRODUCTS[id].disabledReason : reason,
    );
  }
  return decorateSnapshotSurfaces({
    coverageState: 'disabled',
    skipReason: reason,
    rights: { ...IMD_RIGHTS_DECISION },
    generatedAt: now,
    products,
    cyclones: [],
    windRadii: [],
    cones: [],
    portWarnings: [],
    seaBulletins: [],
    coastalBulletins: [],
    fishermenWarnings: [],
    records: [],
    failedProducts: [],
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_API_REFERENCE_URL,
    attribution: IMD_RIGHTS_DECISION.attribution,
  });
}

function groupRecords(records) {
  const cyclones = records.filter((row) => row.product === 'cycloneTrack');
  const windRadii = records.filter((row) => row.product === 'cycloneWind');
  const cones = records.filter((row) => row.product === 'cycloneCou');
  const portWarnings = records.filter((row) => row.product === 'portWarning');
  const seaBulletins = records.filter((row) => row.product === 'seaBulletin');
  const coastalBulletins = records.filter((row) => row.product === 'coastalBulletin');
  return { cyclones, windRadii, cones, portWarnings, seaBulletins, coastalBulletins };
}

export function assembleImdSnapshot({
  productResults,
  previous = null,
  now = Date.now(),
  rights = IMD_RIGHTS_DECISION,
} = {}) {
  const products = {};
  const failedProducts = [];
  const collected = [];
  const previousByProduct = {
    cycloneTrack: previous?.cyclones || [],
    cycloneWind: previous?.windRadii || [],
    cycloneCou: previous?.cones || [],
    portWarning: previous?.portWarnings || [],
    seaBulletin: previous?.seaBulletins || [],
    coastalBulletin: previous?.coastalBulletins || [],
    fishermenWarning: previous?.fishermenWarnings || [],
  };

  for (const id of IMD_PRODUCT_IDS) {
    const spec = IMD_PRODUCTS[id];
    const result = productResults?.[id];
    if (spec.schema === 'undocumented') {
      products[id] = emptyProductHealth(id, 'disabled', spec.disabledReason);
      continue;
    }
    if (!result) {
      products[id] = emptyProductHealth(id, 'disabled', 'NOT_REQUESTED');
      continue;
    }
    if (result.status === 'ok') {
      const records = dedupeRecords(dropExpiredRecords(stampImdGeometryRecords(result.records || [], now), now));
      collected.push(...records);
      products[id] = productHealth({
        status: 'ok',
        recordCount: records.length,
        warningCount: warningCountFor(id, records),
        requestCount: 1,
      });
      continue;
    }
    failedProducts.push(id);
    const carried = dropExpiredRecords(previousByProduct[id] || [], now);
    collected.push(...carried);
    products[id] = productHealth({
      status: 'failed',
      reason: result.reason || 'FETCH_FAILED',
      recordCount: carried.length,
      warningCount: warningCountFor(id, carried),
      carried: carried.length > 0,
      requestCount: result.requestCount ?? 1,
    });
  }

  const grouped = groupRecords(collected);
  const anyOk = IMD_PRODUCT_IDS.some((id) => products[id]?.status === 'ok');
  const anyFailed = failedProducts.length > 0;
  let coverageState = 'ok';
  if (!anyOk && anyFailed) coverageState = 'unavailable';
  else if (anyFailed) coverageState = 'degraded';
  else if (!anyOk) coverageState = 'disabled';

  return decorateSnapshotSurfaces({
    coverageState,
    skipReason: coverageState === 'ok' ? null : failedProducts.join(',') || 'NO_PRODUCTS',
    rights: { ...rights },
    generatedAt: now,
    products,
    ...grouped,
    fishermenWarnings: [],
    records: collected,
    failedProducts,
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_API_REFERENCE_URL,
    attribution: IMD_RIGHTS_DECISION.attribution,
  });
}

function decorateSnapshotSurfaces(snapshot) {
  return {
    ...snapshot,
    cycloneEvents: cycloneEventsFromSnapshot(snapshot),
    portAlerts: weatherAlertsFromSnapshot(snapshot),
    marineBulletins: marineBulletinsFromSnapshot(snapshot),
  };
}

export async function fetchApprovedImdJson(url, {
  fetchFn = globalThis.fetch,
  userAgent = CHROME_UA,
  maxBytes = IMD_MAX_BYTES,
  timeoutMs = IMD_TIMEOUT_MS,
  apiKey = null,
  apiKeyHeader = 'X-API-Key',
} = {}) {
  if (!isAllowedImdHost(url)) throw new Error('UNTRUSTED_SOURCE_HOST');
  const headers = { Accept: 'application/json', 'User-Agent': userAgent };
  if (apiKey) headers[apiKeyHeader] = apiKey;
  const response = await fetchFn(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.httpStatus = response.status;
    throw err;
  }
  const chunks = [];
  let size = 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new Error(`IMD_RESPONSE_TOO_LARGE:${bytes}`);
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) throw new Error(`IMD_RESPONSE_TOO_LARGE:${size}`);
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
}

function imdFetchFailureReason(err) {
  const message = String(err?.message || '');
  if (
    /^HTTP \d{3}$/.test(message)
    || message === 'UNTRUSTED_SOURCE_HOST'
    || /^IMD_RESPONSE_TOO_LARGE:\d+$/.test(message)
  ) {
    return message;
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'IMD_FETCH_TIMEOUT';
  return 'IMD_FETCH_FAILED';
}

export async function fetchImdProduct(productId, options = {}) {
  const spec = IMD_PRODUCTS[productId];
  if (!spec) throw new Error(`UNKNOWN_IMD_PRODUCT:${productId}`);
  if (spec.schema === 'undocumented') {
    return { status: 'disabled', reason: spec.disabledReason, records: [], requestCount: 0 };
  }
  try {
    const payload = await fetchApprovedImdJson(imdProductUrl(spec), options);
    const records = parseImdProductPayload(productId, payload);
    return { status: 'ok', records, requestCount: 1 };
  } catch (err) {
    return { status: 'failed', reason: imdFetchFailureReason(err), records: [], requestCount: 1 };
  }
}

export async function fetchImdCycloneMarine({
  env = process.env,
  fetchFn = globalThis.fetch,
  previous = null,
  now = Date.now(),
  userAgent = CHROME_UA,
} = {}) {
  const disabledReason = imdLiveFetchDisabledReason(env);
  if (disabledReason) {
    return buildDisabledSnapshot({ now, reason: disabledReason });
  }
  const apiKey = imdApiKey(env);
  const apiKeyHeader = imdApiKeyHeader(env);
  const productResults = {};
  await Promise.all(IMD_PRODUCT_IDS.map(async (id) => {
    productResults[id] = await fetchImdProduct(id, {
      fetchFn,
      userAgent,
      apiKey,
      apiKeyHeader,
    });
  }));
  return assembleImdSnapshot({ productResults, previous, now });
}

export function cycloneEventsFromSnapshot(snapshot) {
  const points = snapshot?.cyclones || [];
  if (points.length === 0) return [];
  const byStorm = new Map();
  for (const point of points) {
    const key = slug(point.stormName || 'unnamed');
    if (!byStorm.has(key)) byStorm.set(key, []);
    byStorm.get(key).push(point);
  }
  const cones = snapshot?.cones || [];
  const windRadii = snapshot?.windRadii || [];
  const events = [];
  for (const [stormKey, stormPoints] of byStorm) {
    const observed = stormPoints.filter((row) => row.pointKind === 'observed').sort((a, b) => (a.at || 0) - (b.at || 0));
    const forecast = stormPoints.filter((row) => row.pointKind === 'forecast').sort((a, b) => (a.at || 0) - (b.at || 0));
    const latestObserved = observed[observed.length - 1] || forecast[0];
    if (!latestObserved) continue;
    events.push({
      id: `imd-cyclone-${stormKey}`,
      title: `${latestObserved.category || 'Cyclone'} ${latestObserved.stormName}`.trim(),
      description: `IMD RSMC New Delhi · observed ${observed.length} · forecast ${forecast.length}`,
      category: 'severeStorms',
      categoryTitle: 'Tropical Cyclone',
      lat: latestObserved.lat,
      lon: latestObserved.lon,
      date: latestObserved.at || snapshot.generatedAt,
      closed: false,
      stormId: stormKey,
      stormName: latestObserved.stormName,
      basin: 'NI',
      classification: latestObserved.category,
      windKt: latestObserved.windKt,
      sourceName: IMD_SOURCE_NAME,
      sourceUrl: IMD_RSMC_URL,
      pastTrack: observed.map((row) => ({
        lat: row.lat,
        lon: row.lon,
        windKt: row.windKt || 0,
        timestamp: row.at || 0,
        geometryKind: 'observed-position',
      })),
      forecastTrack: forecast.map((row, index) => ({
        lat: row.lat,
        lon: row.lon,
        hour: Number(row.hour) || (index + 1) * 12,
        windKt: row.windKt || 0,
        category: 0,
        geometryKind: 'forecast-position',
      })),
      conePolygon: cones[0]?.polygons?.[0] ? cones[0].polygons.map((poly) => poly[0]) : [],
      coneGeometryKind: 'cone-of-uncertainty',
      windRadii: windRadii.map((band) => ({
        thresholdKt: band.thresholdKt,
        thresholdLabel: band.thresholdLabel,
        polygons: band.polygons,
        geometryKind: 'forecast-wind-radii',
      })),
      agencyObservations: [{
        agency: 'IMD',
        agencyId: stormKey,
        observedAt: latestObserved.at || snapshot.generatedAt,
        lat: latestObserved.lat,
        lon: latestObserved.lon,
        windKt: latestObserved.windKt,
        classification: latestObserved.category,
        status: 'active',
        sourceName: IMD_SOURCE_NAME,
        sourceUrl: IMD_RSMC_URL,
      }],
    });
  }
  return events;
}

function marineSeverity(record) {
  if (record.isWarning || record.hasTttWarning || record.hasPortSignal) return 'Severe';
  return 'Minor';
}

export function weatherAlertsFromSnapshot(snapshot) {
  const alerts = [];
  for (const row of snapshot?.portWarnings || []) {
    if (!row.isWarning) continue;
    alerts.push({
      id: row.id,
      event: 'IMD Port Warning',
      severity: marineSeverity(row),
      headline: `${row.portName || row.portId}: ${row.warning}`,
      description: row.warning,
      areaDesc: row.portName || row.portId,
      onset: row.issuedAt || snapshot.generatedAt,
      expires: row.issuedAt ? row.issuedAt + 24 * 60 * 60 * 1000 : snapshot.generatedAt + 24 * 60 * 60 * 1000,
      coordinates: row.centroid ? [row.centroid] : [],
      centroid: row.centroid || undefined,
      countryCode: IMD_COUNTRY,
      source: row.source,
      productKind: 'imd-port-warning',
      issuedBy: row.issuedBy,
      sourceUrl: row.sourceUrl,
      geometryPrecision: row.centroid ? 'point' : undefined,
    });
  }
  return alerts;
}

export function marineBulletinsFromSnapshot(snapshot) {
  return [...(snapshot?.seaBulletins || []), ...(snapshot?.coastalBulletins || [])].map((row) => ({
    id: row.id,
    event: row.kind === 'coastal-bulletin' ? 'IMD Coastal Bulletin' : 'IMD Sea Area Bulletin',
    severity: marineSeverity(row),
    headline: `${row.area}: ${row.hasTttWarning ? row.tttWarning : (row.weather || row.seaCondition || 'Marine bulletin')}`,
    description: [
      row.wind && `Wind: ${row.wind}`,
      row.visibility && `Visibility: ${row.visibility}`,
      row.seaCondition && `Sea: ${row.seaCondition}`,
      row.tttWarning && `TTT: ${row.tttWarning}`,
      row.portSignal && `Port signal: ${row.portSignal}`,
    ].filter(Boolean).join(' · '),
    areaDesc: row.area,
    onset: row.validFrom || row.updatedAt || snapshot.generatedAt,
    expires: row.expiresAt || snapshot.generatedAt + 12 * 60 * 60 * 1000,
    coordinates: row.centroid ? [row.centroid] : [],
    centroid: row.centroid || undefined,
    countryCode: IMD_COUNTRY,
    source: row.source,
    productKind: row.kind,
    issuedBy: row.issuedBy,
    wind: row.wind,
    visibility: row.visibility,
    seaState: row.seaCondition,
    sourceUrl: row.sourceUrl,
    geometryPrecision: row.centroid ? 'point' : undefined,
    isForecastBulletin: true,
  }));
}

export function validateImdEnvelope(data) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.cyclones) || !Array.isArray(data.portWarnings)
    || !Array.isArray(data.seaBulletins) || !Array.isArray(data.coastalBulletins)
    || !Array.isArray(data.windRadii) || !Array.isArray(data.cones)
    || !Array.isArray(data.cycloneEvents) || !Array.isArray(data.portAlerts)
    || !Array.isArray(data.marineBulletins)
    || !data.products || typeof data.products !== 'object') {
    return false;
  }
  for (const id of IMD_PRODUCT_IDS) {
    if (!data.products[id] || typeof data.products[id].status !== 'string') return false;
  }
  const cones = data.cones || [];
  if (cones.some((row) => row.geometryKind !== 'cone-of-uncertainty')) return false;
  const winds = data.windRadii || [];
  if (winds.some((row) => row.geometryKind !== 'forecast-wind-radii')) return false;
  const tracks = data.cyclones || [];
  if (tracks.some((row) => row.pointKind !== 'observed' && row.pointKind !== 'forecast')) return false;
  return true;
}

export function declareImdRecords(data) {
  if (!data || typeof data !== 'object') return 0;
  if (data.coverageState === 'disabled') return 0;
  return (data.cyclones?.length || 0)
    + (data.windRadii?.length || 0)
    + (data.cones?.length || 0)
    + (data.portWarnings?.length || 0)
    + (data.seaBulletins?.length || 0)
    + (data.coastalBulletins?.length || 0);
}

export function imdContentMeta(data, nowMs = Date.now()) {
  const stamps = [];
  const bags = [
    data?.cyclones,
    data?.portWarnings,
    data?.seaBulletins,
    data?.coastalBulletins,
  ];
  for (const bag of bags) {
    for (const row of bag || []) {
      for (const key of ['at', 'issuedAt', 'updatedAt', 'validFrom']) {
        const value = row?.[key];
        if (Number.isFinite(value) && value > 0 && value <= nowMs + 60 * 60 * 1000) stamps.push(value);
      }
    }
  }
  if (stamps.length === 0) return null;
  return { newestItemAt: Math.max(...stamps), oldestItemAt: Math.min(...stamps) };
}

export function imdAfterPublish(data) {
  if (data?.coverageState === 'disabled') {
    return {
      freshnessMetaPatch: {
        sourceState: 'unavailable',
        errorCode: data.skipReason || 'IMD_API_KEY_MISSING',
        coverageState: 'disabled',
      },
    };
  }
  if (data?.coverageState === 'degraded') {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'IMD_PRODUCT_PARTIAL',
        failedProducts: data.failedProducts,
        coverageState: 'degraded',
      },
    };
  }
  if (data?.coverageState === 'unavailable') {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'IMD_PRODUCTS_UNAVAILABLE',
        failedProducts: data.failedProducts,
        coverageState: 'unavailable',
      },
    };
  }
  return { freshnessMetaPatch: { sourceState: 'ok', coverageState: 'ok' } };
}
