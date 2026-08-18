// CWFIS / CWFIF national WFS client (GeoServer WFS 2.0).
// Tests import this module, not the seeder entrypoint.
//
// Live capture 2026-08-14 (UTC+4) with CHROME_UA against
// geoserver.cwfif.nrcan.gc.ca:
//   GetCapabilities lists public:cwfif_national_activefires,
//   public:cwfif_national_prescribedfires, public:cwfif_national_reportedfires.
//   application/json is advertised and works. startIndex without sortBy returns
//   HTTP 400 ("Cannot do natural order without a primary key"); sortBy=id fixes it.
//   Attribute names below are from DescribeFeatureType + GetFeature, not guessed.
//   Geometry is EPSG:3978; WGS84 lat/lon live in properties.latitude/longitude.

import { CHROME_UA } from '../_seed-utils.mjs';

export const CWFIS_WFS_HOST = 'geoserver.cwfif.nrcan.gc.ca';
export const CWFIS_WFS_BASE = 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows';
export const CWFIS_WFS_VERSION = '2.0.0';

export const CWFIS_ACTIVE_LAYER = 'public:cwfif_national_activefires';
export const CWFIS_PRESCRIBED_LAYER = 'public:cwfif_national_prescribedfires';
export const CWFIS_REPORTED_LAYER = 'public:cwfif_national_reportedfires';

export const CWFIS_ALLOWED_LAYERS = Object.freeze([
  CWFIS_ACTIVE_LAYER,
  CWFIS_PRESCRIBED_LAYER,
  CWFIS_REPORTED_LAYER,
]);

export const CWFIS_REJECTED_HOSTS = Object.freeze([
  'cwfis.cfs.nrcan.gc.ca',
  'www.cwfis.cfs.nrcan.gc.ca',
]);
export const CWFIS_REJECTED_LAYERS = Object.freeze(['public:activefires_current']);

// 10 000 JSON features measured 7.4MB on 2026-08-13; GML is larger. 12MB
// covers a national JSON page and a GML fallback page without reading the
// 187k-record historical archive in one shot.
export const MAX_CWFIS_RESPONSE_BYTES = 12 * 1024 * 1024;
export const CWFIS_PAGE_SIZE = 1000;
export const CWFIS_MAX_PAGES = 8;
export const CWFIS_FETCH_TIMEOUT_MS = 30_000;
// Live no-CQL GetFeature is 187,566 historical rows (2010+). Current-valid
// record_end >= now is hundreds. Anything at this scale is the archive.
export const CWFIS_ARCHIVE_MATCHED_REFUSAL = 20_000;

const AGENCY_REGION = Object.freeze({
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PC: 'Parks Canada',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
});

export class CwfisWfsError extends Error {
  constructor(message, { code = 'SEED_ERROR', status } = {}) {
    super(message);
    this.name = 'CwfisWfsError';
    this.code = code;
    if (status != null) this.status = status;
  }
}

export function assertCwfisHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host !== CWFIS_WFS_HOST || CWFIS_REJECTED_HOSTS.includes(host)) {
    throw new CwfisWfsError('UNTRUSTED_SOURCE_HOST');
  }
}

export function assertCwfisLayer(typeName) {
  const name = String(typeName || '');
  if (CWFIS_REJECTED_LAYERS.includes(name) || !CWFIS_ALLOWED_LAYERS.includes(name)) {
    throw new CwfisWfsError(`CWFIS layer not allowed: ${name}`);
  }
}

export function cwfisWfsCacheKey({ typeName, bbox, startIndex } = {}) {
  assertCwfisLayer(typeName);
  const bboxPart = bbox == null || bbox === '' ? '' : String(bbox);
  const start = Number.isFinite(Number(startIndex)) ? Number(startIndex) : 0;
  return `cwfis-wfs:${typeName}:bbox=${bboxPart}:startIndex=${start}`;
}

export function currentValidCql(now = new Date()) {
  const iso = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `record_end >= ${iso}`;
}

export function resolveCwfisCqlFilter(cqlFilter, now = new Date()) {
  const raw = cqlFilter == null ? '' : String(cqlFilter).trim();
  const resolved = raw || currentValidCql(now);
  if (!/\brecord_end\s*>=/i.test(resolved)) {
    throw new CwfisWfsError('CWFIS CQL must keep record_end >= now; refusing the historical archive');
  }
  return resolved;
}

export function assertNotCwfisArchive(numberMatched) {
  if (numberMatched != null && Number(numberMatched) >= CWFIS_ARCHIVE_MATCHED_REFUSAL) {
    throw new CwfisWfsError(
      `CWFIS archive shape refused (numberMatched=${numberMatched}); default CQL record_end >= now is required`,
    );
  }
}

function asFiniteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTimestamp(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

function regionForAgency(code) {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return 'Canada';
  return AGENCY_REGION[key] || `Canada (${key})`;
}

/**
 * Stable fire id. #6620 (BC provincial points) may join ONLY on
 * cwfis:${national_fire_id}. Native row ids and lat-lon-time buckets are
 * version-unstable and must not be join keys. Missing or blank
 * national_fire_id is not publishable. FireDetection.id is proto-capped at 100.
 */
export function stableCwfisFireId(props = {}, kind = 'active') {
  const national = String(props.national_fire_id || '').trim();
  if (!national) return '';
  const prefix = kind === 'prescribed' ? 'cwfis:prescribed:' : 'cwfis:';
  const id = `${prefix}${national}`;
  return id.length <= 100 ? id : id.slice(0, 100);
}

export function isEmergencyPagingCandidate(detection) {
  if (!detection || typeof detection !== 'object') return false;
  if (detection.kind === 'prescribed') return false;
  if (detection.emergency === false) return false;
  if (detection.fireWasPrescribed === 1 || detection.fireWasPrescribed === true) return false;
  return true;
}

export function normalizeCwfisFeature(feature, kind) {
  const props = feature?.properties && typeof feature.properties === 'object'
    ? feature.properties
    : (feature && typeof feature === 'object' ? feature : {});
  const lat = asFiniteNumber(props.latitude);
  const lon = asFiniteNumber(props.longitude);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const prescribed = kind === 'prescribed' || Number(props.fire_was_prescribed) === 1;
  const resolvedKind = prescribed ? 'prescribed' : 'active';
  const id = stableCwfisFireId(props, resolvedKind);
  if (!id) return null;

  const detectedAt = parseTimestamp(props.status_date || props.situation_report_date || props.record_start);
  const fireSize = asFiniteNumber(props.fire_size);

  return {
    id,
    location: { latitude: lat, longitude: lon },
    brightness: 0,
    frp: 0,
    confidence: resolvedKind === 'prescribed' ? 'FIRE_CONFIDENCE_UNSPECIFIED' : 'FIRE_CONFIDENCE_HIGH',
    satellite: 'CWFIS',
    detectedAt,
    region: regionForAgency(props.agency_code),
    dayNight: '',
    possibleExplosion: false,
    source: 'cwfis',
    kind: resolvedKind,
    emergency: resolvedKind !== 'prescribed',
    nationalFireId: String(props.national_fire_id || '').trim(),
    agencyFireId: String(props.agency_fire_id || '').trim(),
    agencyCode: String(props.agency_code || '').trim(),
    stageOfControl: String(props.stage_of_control_status || '').trim(),
    fireSize: fireSize == null ? 0 : fireSize,
    fireWasPrescribed: prescribed ? 1 : 0,
  };
}

function looksLikeExceptionReport(text) {
  return /<ows:ExceptionReport\b/i.test(text) || /<ExceptionReport\b/i.test(text);
}

function exceptionMessage(text) {
  const match = text.match(/<ows:ExceptionText>([\s\S]*?)<\/ows:ExceptionText>/i)
    || text.match(/<ExceptionText>([\s\S]*?)<\/ExceptionText>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : 'CWFIS WFS exception';
}

export function parseCwfisGeoJson(payload, kind = 'active') {
  const doc = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!doc || typeof doc !== 'object' || doc.type !== 'FeatureCollection' || !Array.isArray(doc.features)) {
    throw new CwfisWfsError('CWFIS GeoJSON is not a FeatureCollection');
  }
  const fireDetections = [];
  const pageRowKeys = [];
  for (let index = 0; index < doc.features.length; index += 1) {
    const feature = doc.features[index];
    const props = feature?.properties && typeof feature.properties === 'object'
      ? feature.properties
      : {};
    pageRowKeys.push(String(
      feature?.id
      || props.id
      || props.national_fire_id
      || props.agency_fire_id
      || JSON.stringify(feature)
      || `row:${index}`,
    ));
    const normalized = normalizeCwfisFeature(feature, kind);
    if (normalized) fireDetections.push(normalized);
  }
  const declaredNumberReturned = asFiniteNumber(doc.numberReturned);
  if (declaredNumberReturned != null && declaredNumberReturned !== doc.features.length) {
    throw new CwfisWfsError(
      `CWFIS numberReturned mismatch: declared ${declaredNumberReturned}, received ${doc.features.length}`,
    );
  }
  const nextHref = Array.isArray(doc.links)
    ? doc.links.find((link) => link?.rel === 'next')?.href
    : undefined;
  return {
    fireDetections,
    pageRowKeys,
    numberMatched: asFiniteNumber(doc.numberMatched ?? doc.totalFeatures),
    numberReturned: doc.features.length,
    nextHref: typeof nextHref === 'string' ? nextHref : null,
  };
}

function gmlField(block, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i');
  const match = block.match(re);
  return match ? match[1].trim() : '';
}

export function parseCwfisGml(xml, kind = 'active') {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new CwfisWfsError('CWFIS GML is empty');
  }
  if (looksLikeExceptionReport(xml) || /<html[\s>]/i.test(xml)) {
    throw new CwfisWfsError(exceptionMessage(xml));
  }
  if (!/<wfs:FeatureCollection\b/i.test(xml) && !/<FeatureCollection\b/i.test(xml)) {
    throw new CwfisWfsError('CWFIS GML is not a FeatureCollection');
  }

  const collectionOpen = xml.match(/<(?:wfs:)?FeatureCollection\b([^>]*)>/i);
  const attrs = collectionOpen ? collectionOpen[1] : '';
  const numberMatched = asFiniteNumber((attrs.match(/\bnumberMatched="([^"]+)"/i) || [])[1]);
  const numberReturned = asFiniteNumber((attrs.match(/\bnumberReturned="([^"]+)"/i) || [])[1]);
  const nextHref = ((attrs.match(/\bnext="([^"]+)"/i) || [])[1] || '').replace(/&amp;/g, '&') || null;

  const fireDetections = [];
  const pageRowKeys = [];
  let rawRowCount = 0;
  const memberRe = /<(?:wfs:)?member\b[^>]*>([\s\S]*?)<\/(?:wfs:)?member>/gi;
  let match;
  while ((match = memberRe.exec(xml)) !== null) {
    rawRowCount += 1;
    const block = match[1];
    const props = {
      id: gmlField(block, 'id'),
      agency_code: gmlField(block, 'agency_code'),
      region_code: gmlField(block, 'region_code'),
      national_fire_id: gmlField(block, 'national_fire_id'),
      agency_fire_id: gmlField(block, 'agency_fire_id'),
      national_fire_cause: gmlField(block, 'national_fire_cause'),
      fire_was_prescribed: gmlField(block, 'fire_was_prescribed'),
      fire_size: gmlField(block, 'fire_size'),
      stage_of_control_status: gmlField(block, 'stage_of_control_status'),
      situation_report_date: gmlField(block, 'situation_report_date'),
      status_date: gmlField(block, 'status_date'),
      latitude: gmlField(block, 'latitude'),
      longitude: gmlField(block, 'longitude'),
      record_start: gmlField(block, 'record_start'),
      record_end: gmlField(block, 'record_end'),
    };
    pageRowKeys.push(String(
      props.id
      || props.national_fire_id
      || props.agency_fire_id
      || block,
    ));
    const normalized = normalizeCwfisFeature({ properties: props }, kind);
    if (normalized) fireDetections.push(normalized);
  }
  if (numberReturned != null && numberReturned !== rawRowCount) {
    throw new CwfisWfsError(
      `CWFIS numberReturned mismatch: declared ${numberReturned}, received ${rawRowCount}`,
    );
  }

  return {
    fireDetections,
    pageRowKeys,
    numberMatched,
    numberReturned: rawRowCount,
    nextHref,
  };
}

async function readBoundedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new CwfisWfsError('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new CwfisWfsError('RESPONSE_TOO_LARGE');
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CwfisWfsError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseWfsUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new CwfisWfsError('UNTRUSTED_SOURCE_HOST');
  assertCwfisHost(parsed.hostname);
  const typeName = parsed.searchParams.get('typeNames')
    || parsed.searchParams.get('typeName')
    || parsed.searchParams.get('TYPENAMES')
    || parsed.searchParams.get('TYPENAME');
  if (typeName) assertCwfisLayer(typeName);
  return parsed;
}

export function buildCwfisGetFeatureUrl({
  typeName,
  startIndex = 0,
  count = CWFIS_PAGE_SIZE,
  bbox,
  cqlFilter,
  outputFormat = 'application/json',
  now,
} = {}) {
  assertCwfisLayer(typeName);
  const url = new URL(CWFIS_WFS_BASE);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', CWFIS_WFS_VERSION);
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', typeName);
  url.searchParams.set('count', String(count));
  url.searchParams.set('startIndex', String(startIndex));
  url.searchParams.set('sortBy', 'id');
  if (outputFormat) url.searchParams.set('outputFormat', outputFormat);
  if (bbox) url.searchParams.set('bbox', String(bbox));
  url.searchParams.set('CQL_FILTER', resolveCwfisCqlFilter(cqlFilter, now));
  return url.toString();
}

export async function fetchApprovedWfs(url, {
  allowedHosts = [CWFIS_WFS_HOST],
  maxBytes = MAX_CWFIS_RESPONSE_BYTES,
  fetchFn = globalThis.fetch,
  cache,
  accept = 'application/json, application/gml+xml; version=3.2, application/xml, */*',
} = {}) {
  const parsed = parseWfsUrl(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    throw new CwfisWfsError('UNTRUSTED_SOURCE_HOST');
  }
  const typeName = parsed.searchParams.get('typeNames')
    || parsed.searchParams.get('typeName')
    || parsed.searchParams.get('TYPENAMES')
    || CWFIS_ACTIVE_LAYER;
  const bbox = parsed.searchParams.get('bbox') || parsed.searchParams.get('BBOX') || '';
  const startIndex = parsed.searchParams.get('startIndex') || parsed.searchParams.get('STARTINDEX') || '0';
  const cacheKey = cwfisWfsCacheKey({ typeName, bbox, startIndex });
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const response = await fetchFn(parsed.toString(), {
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(CWFIS_FETCH_TIMEOUT_MS),
  });
  const text = await readBoundedText(response, maxBytes);
  if (!response.ok) {
    const err = new CwfisWfsError(
      looksLikeExceptionReport(text) ? exceptionMessage(text) : `HTTP_${response.status}`,
      { status: response.status },
    );
    throw err;
  }
  if (looksLikeExceptionReport(text)) {
    throw new CwfisWfsError(exceptionMessage(text), { status: response.status });
  }
  const result = { text, contentType: response.headers?.get?.('content-type') || '', cacheKey };
  cache?.set(cacheKey, result);
  return result;
}

function parseWfsBody(text, contentType, kind) {
  const looksJson = /^\s*\{/.test(text) || /json/i.test(contentType || '');
  if (looksJson) {
    try {
      return parseCwfisGeoJson(text, kind);
    } catch (err) {
      if (err instanceof CwfisWfsError) throw err;
      throw new CwfisWfsError(`CWFIS JSON parse failed: ${err.message}`);
    }
  }
  return parseCwfisGml(text, kind);
}

async function fetchWfsPage(url, { kind, fetchFn, cache, preferJson = true } = {}) {
  const parsed = new URL(url);
  if (preferJson && !parsed.searchParams.get('outputFormat')) {
    parsed.searchParams.set('outputFormat', 'application/json');
  }
  try {
    const page = await fetchApprovedWfs(parsed.toString(), {
      fetchFn,
      cache,
      accept: preferJson
        ? 'application/json, application/geo+json, application/gml+xml; version=3.2, application/xml, */*'
        : 'application/gml+xml; version=3.2, application/xml, text/xml, */*',
    });
    return parseWfsBody(page.text, page.contentType, kind);
  } catch (err) {
    const status = err?.status;
    if (preferJson && (status === 400 || status === 406)) {
      const gmlUrl = new URL(url);
      gmlUrl.searchParams.delete('outputFormat');
      const page = await fetchApprovedWfs(gmlUrl.toString(), {
        fetchFn,
        cache,
        accept: 'application/gml+xml; version=3.2, application/xml, text/xml, */*',
      });
      return parseWfsBody(page.text, page.contentType, kind);
    }
    throw err;
  }
}

function startIndexFromHref(href) {
  try {
    const parsed = new URL(href);
    const raw = parsed.searchParams.get('startIndex') || parsed.searchParams.get('STARTINDEX');
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function fetchCwfisLayer(typeName, {
  kind,
  fetchFn = globalThis.fetch,
  cache,
  bbox,
  cqlFilter,
  pageSize = CWFIS_PAGE_SIZE,
  maxPages = CWFIS_MAX_PAGES,
  now = new Date(),
} = {}) {
  assertCwfisLayer(typeName);
  const resolvedKind = kind || (typeName === CWFIS_PRESCRIBED_LAYER ? 'prescribed' : 'active');
  const filter = resolveCwfisCqlFilter(cqlFilter, now);
  const fireDetections = [];
  const seen = new Set();
  const seenPageRows = new Set();
  let startIndex = 0;
  let nextHref = null;
  let paginationComplete = false;
  let lastProgress = 0;
  let lastMatched = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = nextHref || buildCwfisGetFeatureUrl({
      typeName,
      startIndex,
      count: pageSize,
      bbox,
      cqlFilter: filter,
      outputFormat: 'application/json',
    });
    if (nextHref) parseWfsUrl(nextHref);
    const parsed = await fetchWfsPage(url, { kind: resolvedKind, fetchFn, cache, preferJson: true });
    assertNotCwfisArchive(parsed.numberMatched);
    let newPageRows = 0;
    for (const rowKey of parsed.pageRowKeys || []) {
      if (seenPageRows.has(rowKey)) continue;
      seenPageRows.add(rowKey);
      newPageRows += 1;
    }
    for (const detection of parsed.fireDetections) {
      if (seen.has(detection.id)) continue;
      seen.add(detection.id);
      fireDetections.push(detection);
    }
    const returned = parsed.numberReturned ?? parsed.fireDetections.length;
    if (returned > 0 && newPageRows === 0) {
      throw new CwfisWfsError(`CWFIS pagination repeated a page at startIndex=${startIndex}`);
    }
    const matched = parsed.numberMatched;
    const progress = startIndex + returned;
    lastProgress = progress;
    lastMatched = matched;
    nextHref = parsed.nextHref;
    if (nextHref) {
      try {
        const parsedNext = parseWfsUrl(nextHref);
        if (!parsedNext.searchParams.get('CQL_FILTER') && !parsedNext.searchParams.get('cql_filter')) {
          parsedNext.searchParams.set('CQL_FILTER', filter);
        }
        nextHref = parsedNext.toString();
      } catch (err) {
        throw new CwfisWfsError(`CWFIS pagination next URL rejected: ${err.message}`);
      }
    }

    const matchedComplete = matched != null && progress >= matched;
    const shortPageComplete = matched == null && returned < pageSize;
    if (!nextHref && (matchedComplete || shortPageComplete)) {
      paginationComplete = true;
      break;
    }

    if (returned === 0) {
      throw new CwfisWfsError(`CWFIS pagination made no progress at startIndex=${startIndex}`);
    }
    const nextStart = nextHref ? startIndexFromHref(nextHref) : startIndex + (returned || pageSize);
    if (nextStart == null || nextStart <= startIndex) {
      throw new CwfisWfsError(`CWFIS pagination did not advance from startIndex=${startIndex}`);
    }
    startIndex = nextStart;
  }

  if (!paginationComplete) {
    const expected = lastMatched == null ? 'unknown' : lastMatched;
    throw new CwfisWfsError(
      `CWFIS pagination incomplete after ${maxPages} page(s): ${lastProgress} of ${expected}`,
    );
  }

  return { fireDetections, typeName, kind: resolvedKind };
}

function mergeById(primary = [], secondary = []) {
  const seen = new Set();
  const out = [];
  for (const row of [...primary, ...secondary]) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export async function fetchCwfisFires(options = {}) {
  const [activeResult, prescribedResult] = await Promise.allSettled([
    fetchCwfisLayer(CWFIS_ACTIVE_LAYER, { kind: 'active', ...options }),
    fetchCwfisLayer(CWFIS_PRESCRIBED_LAYER, { kind: 'prescribed', ...options }),
  ]);
  const activeOk = activeResult.status === 'fulfilled';
  const prescribedOk = prescribedResult.status === 'fulfilled';
  if (!activeOk) {
    const activeErr = activeResult.reason?.message || activeResult.reason;
    throw new CwfisWfsError(`CWFIS active layer failed: ${activeErr}`);
  }
  if (!prescribedOk) console.warn(`[cwfis] prescribed layer failed: ${prescribedResult.reason?.message || prescribedResult.reason}`);

  const active = activeResult.value.fireDetections || [];
  const prescribed = prescribedOk ? (prescribedResult.value.fireDetections || []) : [];
  return {
    fireDetections: mergeById(active, prescribed),
    _cwfisActiveCount: active.length,
    _cwfisPrescribedCount: prescribed.length,
    _cwfisState: prescribedOk ? 'ok' : 'degraded',
    _cwfisErrorCode: prescribedOk ? null : 'CWFIS_PRESCRIBED_FAILED',
  };
}

export function cwfisWildfireAfterPublish(data) {
  // FIRMS is the GLOBAL source for this key: losing it drops the canonical
  // payload from worldwide coverage to Canada only. That outranks any Canadian
  // degradation, so it is checked first and reported first.
  const firmsFailed = data?._firmsState === 'failed';
  const cwfisOk = data?._cwfisState === 'ok';
  if (!firmsFailed && cwfisOk) {
    return { freshnessMetaPatch: { sourceState: 'ok' } };
  }
  let errorCode;
  if (firmsFailed) errorCode = 'FIRMS_SOURCE_FAILED';
  else if (data?._cwfisErrorCode === 'CWFIS_PRESCRIBED_FAILED') errorCode = 'CWFIS_PRESCRIBED_FAILED';
  else errorCode = 'CWFIS_SOURCE_FAILED';
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode,
      canadaSourceFailureCount: cwfisOk ? 0 : 1,
    },
  };
}

export function tagFirmsDetections(detections = []) {
  return detections.map((detection) => ({
    ...detection,
    source: detection.source || 'firms',
    kind: detection.kind || 'active',
    emergency: detection.emergency !== false && detection.kind !== 'prescribed',
  }));
}

export async function mergeWildfireSources({ fetchFirms, fetchCwfis }) {
  const [firmsResult, cwfisResult] = await Promise.allSettled([
    fetchFirms(),
    fetchCwfis(),
  ]);
  const firmsOk = firmsResult.status === 'fulfilled';
  const cwfisOk = cwfisResult.status === 'fulfilled';
  if (!firmsOk && !cwfisOk) {
    const firmsErr = firmsResult.reason?.message || firmsResult.reason;
    const cwfisErr = cwfisResult.reason?.message || cwfisResult.reason;
    throw new CwfisWfsError(`All wildfire upstreams failed (firms: ${firmsErr}; cwfis: ${cwfisErr})`);
  }
  if (!firmsOk) console.warn(`[wildfire] FIRMS failed: ${firmsResult.reason?.message || firmsResult.reason}`);
  if (!cwfisOk) console.warn(`[wildfire] CWFIS failed: ${cwfisResult.reason?.message || cwfisResult.reason}`);

  const firmsDetections = firmsOk
    ? tagFirmsDetections(firmsResult.value?.fireDetections || [])
    : [];
  const cwfisDetections = cwfisOk ? (cwfisResult.value?.fireDetections || []) : [];
  const cwfisState = cwfisOk ? (cwfisResult.value?._cwfisState || 'ok') : 'failed';
  const cwfisErrorCode = cwfisOk
    ? (cwfisResult.value?._cwfisErrorCode ?? null)
    : 'CWFIS_SOURCE_FAILED';
  return {
    fireDetections: mergeById(firmsDetections, cwfisDetections),
    _firmsCount: firmsDetections.length,
    _firmsState: firmsOk ? 'ok' : 'failed',
    _firmsErrorCode: firmsOk ? null : 'FIRMS_SOURCE_FAILED',
    _cwfisCount: cwfisDetections.length,
    _cwfisActiveCount: cwfisOk ? (cwfisResult.value?._cwfisActiveCount ?? null) : null,
    _cwfisPrescribedCount: cwfisOk ? (cwfisResult.value?._cwfisPrescribedCount ?? null) : null,
    _cwfisState: cwfisState,
    _cwfisErrorCode: cwfisErrorCode,
  };
}
