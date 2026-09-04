// BC Wildfire current fire points (OpenMaps KML + same-host WFS fallback).
// Tests import this module, not the seeder entrypoint.
//
// Live capture 2026-08-14 (UTC+4) with CHROME_UA against openmaps.gov.bc.ca:
//   Catalogue KML
//   https://openmaps.gov.bc.ca/kml/geo/layers/WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP_loader.kml
//   is a NetworkLink to PROT_CURRENT_FIRE_PNTS_SP.kml, which is WMS GroundOverlay
//   tiles (no Placemark coordinates). GeoServer WFS KML outputFormat returns
//   empty <Placemark id="..."/> stubs. Vector points for the same layer are on
//   WFS GetFeature application/json with properties.LATITUDE/LONGITUDE (do not
//   use SHAPE — default CRS is EPSG:3005). Dataset licence: OGL-BC.

import { CHROME_UA } from '../_seed-utils.mjs';

export const BC_OPENMAPS_HOST = 'openmaps.gov.bc.ca';
export const BC_FIRE_LAYER = 'PROT_CURRENT_FIRE_PNTS_SP';
export const BC_FIRE_TYPENAME = 'pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP';
export const BC_FIRE_KML_URL = 'https://openmaps.gov.bc.ca/kml/geo/layers/WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP_loader.kml';
export const BC_FIRE_WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub/ows';
export const BC_SOURCE = 'bc-wildfire';

export const MAX_BC_RESPONSE_BYTES = 12 * 1024 * 1024;
export const BC_FETCH_TIMEOUT_MS = 30_000;
export const BC_WFS_PAGE_SIZE = 1000;
export const BC_WFS_MAX_PAGES = 8;
export const BC_MAX_NETWORKLINK_HOPS = 2;

export class BcFirePointsError extends Error {
  constructor(message, { code = 'SEED_ERROR', status } = {}) {
    super(message);
    this.name = 'BcFirePointsError';
    this.code = code;
    if (status != null) this.status = status;
  }
}

export function assertBcOpenmapsHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host !== BC_OPENMAPS_HOST) {
    throw new BcFirePointsError('UNTRUSTED_SOURCE_HOST');
  }
}

export function bcFireCacheKey({ layer = BC_FIRE_LAYER, startIndex, kind = 'kml' } = {}) {
  const name = String(layer || BC_FIRE_LAYER);
  if (!name.includes(BC_FIRE_LAYER) && name !== BC_FIRE_LAYER) {
    throw new BcFirePointsError(`BC wildfire layer not allowed: ${name}`);
  }
  const start = Number.isFinite(Number(startIndex)) ? Number(startIndex) : 0;
  if (kind === 'wfs') return `bc-wildfire-wfs:${BC_FIRE_LAYER}:startIndex=${start}`;
  return `bc-wildfire-kml:${BC_FIRE_LAYER}`;
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
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}Z$/.test(text)) text = `${text.slice(0, 10)}T00:00:00Z`;
  const ts = Date.parse(text);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}

export function latLonTimeKey(lat, lon, detectedAt = 0) {
  const timeBucket = detectedAt > 0 ? Math.round(detectedAt / 60_000) : 0;
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)},${timeBucket}`;
}

function looksPrescribed(props = {}) {
  const blob = [
    props.FIRE_TYPE, props.fire_type, props.FIRE_STATUS, props.fire_status,
    props.FIRE_CAUSE, props.INCIDENT_NAME, props.kind,
  ].filter(Boolean).join(' ');
  return /prescribed|rx[\s-]?burn/i.test(blob);
}

function isInactiveStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'out' || s === 'inactive' || s === 'extinguished' || s === 'gone out';
}

function fireNumberFromProps(props = {}, fallbackName = '') {
  return String(
    props.FIRE_NUMBER || props.fire_number || props.FIRE_ID_NUMBER || fallbackName || '',
  ).trim();
}

/**
 * Native BC id is `bc-wildfire:${FIRE_NUMBER}`. Missing native id uses a
 * lat-lon-time bucket for BC-only identity. That bucket is not a CWFIS join
 * key — #6664 allows only `cwfis:${year}_BC_${year}-${FIRE_NUMBER}`.
 */
export function stableBcFireId(props = {}, coords = {}) {
  const fireNumber = fireNumberFromProps(props);
  if (fireNumber) {
    const id = `${BC_SOURCE}:${fireNumber}`;
    return id.length <= 100 ? id : id.slice(0, 100);
  }
  const lat = asFiniteNumber(coords.latitude ?? props.LATITUDE ?? props.latitude);
  const lon = asFiniteNumber(coords.longitude ?? props.LONGITUDE ?? props.longitude);
  if (lat == null || lon == null) return '';
  const detectedAt = parseTimestamp(props.IGNITION_DATE || props.ignition_date || props.status_date);
  const id = `${BC_SOURCE}:${latLonTimeKey(lat, lon, detectedAt)}`;
  return id.length <= 100 ? id : id.slice(0, 100);
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function xmlField(block, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i');
  const match = block.match(re);
  return match ? decodeXml(match[1]) : '';
}

function parseExtendedData(block) {
  const props = {};
  const dataRe = /<(?:[\w.-]+:)?Data\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Data>/gi;
  let match;
  while ((match = dataRe.exec(block)) !== null) {
    const name = ((match[1].match(/\bname="([^"]+)"/i) || [])[1] || '').trim();
    const value = xmlField(match[2], 'value') || decodeXml(match[2].replace(/<[^>]+>/g, ''));
    if (name) props[name] = value;
  }
  const simpleRe = /<(?:[\w.-]+:)?SimpleData\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?SimpleData>/gi;
  while ((match = simpleRe.exec(block)) !== null) {
    const name = ((match[1].match(/\bname="([^"]+)"/i) || [])[1] || '').trim();
    if (name) props[name] = decodeXml(match[2]);
  }
  const description = xmlField(block, 'description');
  if (description) {
    const cellRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    const cells = [];
    let cell;
    while ((cell = cellRe.exec(description)) !== null) {
      cells.push(decodeXml(cell[1].replace(/<[^>]+>/g, '')));
    }
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i];
      if (key && !(key in props)) props[key] = cells[i + 1];
    }
  }
  return props;
}

function parseKmlPoint(block) {
  const coordText = xmlField(block, 'coordinates');
  if (!coordText) return null;
  const first = coordText.split(/\s+/)[0];
  const parts = first.split(',').map((part) => Number(part));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { longitude: parts[0], latitude: parts[1] };
}

export function normalizeBcFeature(props = {}, coords = {}) {
  const lat = asFiniteNumber(coords.latitude ?? props.LATITUDE ?? props.latitude);
  const lon = asFiniteNumber(coords.longitude ?? props.LONGITUDE ?? props.longitude);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const prescribed = looksPrescribed(props);
  const status = String(props.FIRE_STATUS || props.fire_status || '').trim();
  const resolvedKind = prescribed ? 'prescribed' : 'active';
  const id = stableBcFireId(props, { latitude: lat, longitude: lon });
  if (!id) return null;

  const detectedAt = parseTimestamp(props.IGNITION_DATE || props.ignition_date || props.status_date);
  const fireSize = asFiniteNumber(props.CURRENT_SIZE ?? props.current_size ?? props.FIRE_SIZE);
  const fireNumber = fireNumberFromProps(props);

  return {
    id,
    location: { latitude: lat, longitude: lon },
    brightness: 0,
    frp: 0,
    confidence: resolvedKind === 'prescribed' ? 'FIRE_CONFIDENCE_UNSPECIFIED' : 'FIRE_CONFIDENCE_HIGH',
    satellite: 'BC Wildfire Service',
    detectedAt,
    region: 'British Columbia',
    dayNight: '',
    possibleExplosion: false,
    source: BC_SOURCE,
    kind: resolvedKind,
    emergency: resolvedKind !== 'prescribed' && !isInactiveStatus(status),
    fireNumber,
    nationalFireId: '',
    agencyFireId: fireNumber,
    agencyCode: 'BC',
    stageOfControl: status,
    fireSize: fireSize == null ? 0 : fireSize,
    fireWasPrescribed: prescribed ? 1 : 0,
    fireUrl: String(props.FIRE_URL || props.fire_url || '').trim(),
    incidentName: String(props.INCIDENT_NAME || props.incident_name || '').trim(),
    geographicDescription: String(props.GEOGRAPHIC_DESCRIPTION || props.geographic_description || '').trim(),
    fireYear: asFiniteNumber(props.FIRE_YEAR || props.fire_year) || 0,
  };
}

export function parseBcFireKml(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new BcFirePointsError('BC wildfire KML is empty');
  }
  if (/<(?:ows:)?ExceptionReport\b/i.test(xml) || /<ServiceExceptionReport\b/i.test(xml)) {
    throw new BcFirePointsError('BC wildfire KML exception report');
  }

  const networkLinks = [];
  const linkRe = /<(?:[\w.-]+:)?(?:NetworkLink|Link)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:NetworkLink|Link)>/gi;
  let linkMatch;
  while ((linkMatch = linkRe.exec(xml)) !== null) {
    const href = xmlField(linkMatch[1], 'href');
    if (href) networkLinks.push(href);
  }

  const fireDetections = [];
  const seen = new Set();
  const placemarkRe = /<(?:[\w.-]+:)?Placemark\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Placemark>/gi;
  let match;
  while ((match = placemarkRe.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const block = match[2];
    const point = parseKmlPoint(block);
    const props = parseExtendedData(block);
    const name = xmlField(block, 'name');
    if (name && !props.FIRE_NUMBER) props.FIRE_NUMBER = name;
    const idAttr = ((attrs.match(/\bid="([^"]+)"/i) || [])[1] || '').split('.').pop();
    if (idAttr && !props.FIRE_NUMBER) props.FIRE_NUMBER = idAttr;
    if (!point && props.LATITUDE == null && props.latitude == null) continue;
    const normalized = normalizeBcFeature(props, point || {});
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    fireDetections.push(normalized);
  }

  return { fireDetections, networkLinks };
}

export function parseBcFireGeoJson(payload) {
  const doc = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!doc || typeof doc !== 'object' || doc.type !== 'FeatureCollection' || !Array.isArray(doc.features)) {
    throw new BcFirePointsError('BC wildfire GeoJSON is not a FeatureCollection');
  }
  const fireDetections = [];
  const seen = new Set();
  const pageRowKeys = [];
  for (const feature of doc.features) {
    const props = feature?.properties && typeof feature.properties === 'object'
      ? { ...feature.properties }
      : {};
    pageRowKeys.push(String(
      feature?.id
      ?? props.OBJECTID
      ?? props.objectid
      ?? props.FIRE_NUMBER
      ?? props.fire_number
      ?? JSON.stringify(feature),
    ));
    if (!props.FIRE_NUMBER && typeof feature?.id === 'string') {
      const tail = feature.id.split('.').pop();
      if (tail) props.FIRE_NUMBER = tail;
    }
    const normalized = normalizeBcFeature(props, {});
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    fireDetections.push(normalized);
  }
  const declaredReturned = asFiniteNumber(doc.numberReturned);
  if (declaredReturned != null && declaredReturned !== doc.features.length) {
    throw new BcFirePointsError(
      `BC wildfire numberReturned mismatch: declared ${declaredReturned}, received ${doc.features.length}`,
    );
  }
  return {
    fireDetections,
    pageRowKeys,
    numberMatched: asFiniteNumber(doc.numberMatched ?? doc.totalFeatures),
    numberReturned: doc.features.length,
  };
}

async function readBoundedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new BcFirePointsError('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new BcFirePointsError('RESPONSE_TOO_LARGE');
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
        throw new BcFirePointsError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseAllowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new BcFirePointsError('UNTRUSTED_SOURCE_HOST');
  assertBcOpenmapsHost(parsed.hostname);
  return parsed;
}

export async function fetchApprovedBcUrl(url, {
  maxBytes = MAX_BC_RESPONSE_BYTES,
  fetchFn = globalThis.fetch,
  cache,
  cacheKey,
  accept = 'application/vnd.google-earth.kml+xml, application/xml, text/xml, application/json, */*',
} = {}) {
  const parsed = parseAllowedUrl(url);
  const key = cacheKey || bcFireCacheKey({ kind: 'kml' });
  if (cache?.has(key)) return cache.get(key);

  const response = await fetchFn(parsed.toString(), {
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(BC_FETCH_TIMEOUT_MS),
  });
  const text = await readBoundedText(response, maxBytes);
  if (!response.ok) {
    throw new BcFirePointsError(`HTTP_${response.status}`, { status: response.status });
  }
  const result = { text, contentType: response.headers?.get?.('content-type') || '', cacheKey: key };
  cache?.set(key, result);
  return result;
}

export function buildBcWfsUrl({ startIndex = 0, count = BC_WFS_PAGE_SIZE } = {}) {
  const url = new URL(BC_FIRE_WFS_BASE);
  url.searchParams.set('service', 'WFS');
  url.searchParams.set('version', '2.0.0');
  url.searchParams.set('request', 'GetFeature');
  url.searchParams.set('typeNames', BC_FIRE_TYPENAME);
  url.searchParams.set('srsName', 'EPSG:4326');
  url.searchParams.set('outputFormat', 'application/json');
  url.searchParams.set('sortBy', 'OBJECTID');
  url.searchParams.set('count', String(count));
  url.searchParams.set('startIndex', String(startIndex));
  return url.toString();
}

async function fetchBcFireKmlTree({ fetchFn, cache, maxHops = BC_MAX_NETWORKLINK_HOPS } = {}) {
  const seenHref = new Set();
  const fireDetections = [];
  const queue = [{ url: BC_FIRE_KML_URL, hop: 0 }];

  while (queue.length) {
    const { url, hop } = queue.shift();
    if (seenHref.has(url) || hop > maxHops) continue;
    seenHref.add(url);
    parseAllowedUrl(url);
    const page = await fetchApprovedBcUrl(url, {
      fetchFn,
      cache,
      cacheKey: hop === 0
        ? bcFireCacheKey({ kind: 'kml' })
        : `bc-wildfire-kml:${BC_FIRE_LAYER}:hop=${hop}`,
      accept: 'application/vnd.google-earth.kml+xml, application/xml, text/xml, */*',
    });
    const parsed = parseBcFireKml(page.text);
    for (const detection of parsed.fireDetections) fireDetections.push(detection);
    for (const href of parsed.networkLinks) {
      try {
        const next = new URL(href, url).toString();
        parseAllowedUrl(next);
        if (!seenHref.has(next) && hop < maxHops) queue.push({ url: next, hop: hop + 1 });
      } catch {
        // Drop off-host NetworkLink targets.
      }
    }
  }
  return fireDetections;
}

async function fetchBcFireWfs({ fetchFn, cache, pageSize = BC_WFS_PAGE_SIZE, maxPages = BC_WFS_MAX_PAGES } = {}) {
  const fireDetections = [];
  const seen = new Set();
  const seenPageRows = new Set();
  let paginationComplete = false;
  let lastProgress = 0;
  let lastMatched = null;
  for (let page = 0; page < maxPages; page += 1) {
    const startIndex = page * pageSize;
    const url = buildBcWfsUrl({ startIndex, count: pageSize });
    const response = await fetchApprovedBcUrl(url, {
      fetchFn,
      cache,
      cacheKey: bcFireCacheKey({ kind: 'wfs', startIndex }),
      accept: 'application/json, application/geo+json, */*',
    });
    const parsed = parseBcFireGeoJson(response.text);
    let newPageRows = 0;
    for (const rowKey of parsed.pageRowKeys) {
      if (seenPageRows.has(rowKey)) continue;
      seenPageRows.add(rowKey);
      newPageRows += 1;
    }
    if (parsed.numberReturned > 0 && newPageRows === 0) {
      throw new BcFirePointsError(`BC wildfire WFS pagination repeated a page at startIndex=${startIndex}`);
    }
    for (const detection of parsed.fireDetections) {
      if (seen.has(detection.id)) continue;
      seen.add(detection.id);
      fireDetections.push(detection);
    }
    const returned = parsed.numberReturned ?? parsed.fireDetections.length;
    const matched = parsed.numberMatched;
    const progress = startIndex + returned;
    lastProgress = progress;
    lastMatched = matched;
    if ((matched != null && progress >= matched) || (matched == null && returned < pageSize)) {
      paginationComplete = true;
      break;
    }
    if (returned === 0) {
      throw new BcFirePointsError(`BC wildfire WFS pagination made no progress at startIndex=${startIndex}`);
    }
  }
  if (!paginationComplete) {
    const expected = lastMatched == null ? 'unknown' : lastMatched;
    throw new BcFirePointsError(
      `BC wildfire WFS pagination incomplete after ${maxPages} page(s): ${lastProgress} of ${expected}`,
    );
  }
  return fireDetections;
}

export async function fetchBcFirePoints({
  fetchFn = globalThis.fetch,
  cache,
  pageSize = BC_WFS_PAGE_SIZE,
  maxPages = BC_WFS_MAX_PAGES,
} = {}) {
  let kmlDetections = [];
  let kmlError = null;
  try {
    kmlDetections = await fetchBcFireKmlTree({ fetchFn, cache });
  } catch (err) {
    kmlError = err;
  }
  if (kmlDetections.length > 0) {
    return { fireDetections: kmlDetections, _bcVia: 'kml', _bcCount: kmlDetections.length };
  }

  try {
    const wfsDetections = await fetchBcFireWfs({ fetchFn, cache, pageSize, maxPages });
    return { fireDetections: wfsDetections, _bcVia: 'wfs', _bcCount: wfsDetections.length };
  } catch (err) {
    if (kmlError) {
      throw new BcFirePointsError(
        `BC wildfire KML and WFS failed (kml: ${kmlError.message || kmlError}; wfs: ${err.message || err})`,
      );
    }
    throw err;
  }
}

/**
 * #6664 nid-only contract. BC may join CWFIS ONLY on
 * `cwfis:${year}_BC_${year}-${FIRE_NUMBER}`. latLonKey, latLonTimeKey, and
 * the raw fire-number are not join keys.
 */
export function bcNationalJoinKey(fireNumber, fireYear) {
  const number = String(fireNumber || '').trim().toUpperCase();
  if (!number) return '';
  const year = Number(fireYear);
  const y = Number.isFinite(year) && year > 0 ? Math.trunc(year) : new Date().getUTCFullYear();
  return `cwfis:${y}_BC_${y}-${number}`;
}

export function collectCwfisJoinKeys(detection) {
  const keys = new Set();
  if (!detection || typeof detection !== 'object') return keys;
  const national = String(detection.nationalFireId || '').trim();
  if (national) keys.add(`cwfis:${national}`);
  return keys;
}

export function collectBcJoinKeys(detection) {
  const keys = new Set();
  if (!detection || typeof detection !== 'object') return keys;
  const key = bcNationalJoinKey(detection.fireNumber, detection.fireYear);
  if (key) keys.add(key);
  return keys;
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

/**
 * CWFIS is baseline. A matching BC point enriches the CWFIS record on the
 * reconstructed nid `cwfis:${year}_BC_${year}-${FIRE_NUMBER}` only
 * (#6664). Lat-lon and raw fire-number keys are not join keys. BC-only
 * active fires are appended with `bc-wildfire:` native ids.
 */
export function enrichOrAppendBc(existing = [], bcDetections = []) {
  const out = existing.map((row) => ({ ...row }));
  const cwfisIndex = new Map();
  for (const row of out) {
    if (row.source !== 'cwfis') continue;
    for (const key of collectCwfisJoinKeys(row)) {
      if (!cwfisIndex.has(key)) cwfisIndex.set(key, row);
    }
  }

  let enriched = 0;
  let appended = 0;
  const seen = new Set(out.map((row) => row.id));

  for (const bc of bcDetections) {
    let match = null;
    for (const key of collectBcJoinKeys(bc)) {
      if (cwfisIndex.has(key)) {
        match = cwfisIndex.get(key);
        break;
      }
    }
    if (match) {
      match.bcFireNumber = bc.fireNumber || match.bcFireNumber;
      match.bcFireStatus = bc.stageOfControl || match.bcFireStatus;
      match.bcFireUrl = bc.fireUrl || match.bcFireUrl;
      if (bc.geographicDescription) match.geographicDescription = bc.geographicDescription;
      if (bc.incidentName) match.incidentName = bc.incidentName;
      if ((!match.fireSize || match.fireSize === 0) && bc.fireSize) match.fireSize = bc.fireSize;
      if (match.kind === 'prescribed') {
        match.emergency = false;
        match.fireWasPrescribed = 1;
      }
      enriched += 1;
      continue;
    }
    // Out / inactive / extinguished points may enrich a matching CWFIS row
    // but must not append a new dashboard detection.
    if (isInactiveStatus(bc.stageOfControl)) continue;
    if (!bc?.id || seen.has(bc.id)) continue;
    seen.add(bc.id);
    out.push({ ...bc });
    appended += 1;
  }

  return {
    fireDetections: out,
    _bcEnrichedCount: enriched,
    _bcAppendedCount: appended,
  };
}

function tagFirmsDetections(detections = []) {
  return detections.map((detection) => ({
    ...detection,
    source: detection.source || 'firms',
    kind: detection.kind || 'active',
    emergency: detection.emergency !== false && detection.kind !== 'prescribed',
  }));
}

/**
 * Independent FIRMS + CWFIS + BC merge. One upstream failing does not empty
 * the canonical wildfire key. Does not call the CWFIS WFS client.
 */
export async function mergeWildfireSourcesWithBc({ fetchFirms, fetchCwfis, fetchBcWildfire }) {
  const [firmsResult, cwfisResult, bcResult] = await Promise.allSettled([
    fetchFirms(),
    fetchCwfis(),
    fetchBcWildfire(),
  ]);
  // Settlement alone is NOT coverage. fetchAllRegions catches every per-region
  // error internally and always resolves, so an all-regions FIRMS outage
  // settles 'fulfilled' with zero rows. When the fetcher reports its per-call
  // counters, require at least one successful call: otherwise the canonical
  // WORLDWIDE key silently republishes as Canada-only and reads healthy on
  // every downstream clock (#7141 follow-up). Fetchers that report no counters
  // keep the settlement-only grading.
  const firmsValue = firmsResult.status === 'fulfilled' ? firmsResult.value : null;
  const firmsReportedCalls = typeof firmsValue?._firmsFulfilledCalls === 'number';
  const firmsFailedCalls = firmsReportedCalls ? (firmsValue._firmsFailedCalls ?? 0) : 0;
  const firmsOk = firmsResult.status === 'fulfilled'
    && (!firmsReportedCalls || firmsValue._firmsFulfilledCalls > 0);
  // The FIRMS regions partition the globe, so a failed region is not a smaller
  // sample of the same area — it is that area going dark while the surviving
  // regions replace the canonical worldwide dataset. Zero coverage is an
  // outage (above); PARTIAL coverage is reported rather than hard-failed,
  // because failing closed on one flaky region of many would page constantly
  // on a rate-limited free tier. The point is that it stops being SILENT.
  const firmsPartial = firmsOk && firmsReportedCalls && firmsFailedCalls > 0;
  const cwfisOk = cwfisResult.status === 'fulfilled';
  const bcOk = bcResult.status === 'fulfilled';
  if (!firmsOk && !cwfisOk && !bcOk) {
    const firmsErr = firmsResult.reason?.message || firmsResult.reason;
    const cwfisErr = cwfisResult.reason?.message || cwfisResult.reason;
    const bcErr = bcResult.reason?.message || bcResult.reason;
    throw new BcFirePointsError(
      `All wildfire upstreams failed (firms: ${firmsErr}; cwfis: ${cwfisErr}; bc-wildfire: ${bcErr})`,
    );
  }
  if (!firmsOk) {
    // Distinguish the two failure shapes: a rejected fetch has a reason, a
    // zero-coverage fetch settled fine but every region call failed.
    const firmsErr = firmsResult.status === 'rejected'
      ? (firmsResult.reason?.message || firmsResult.reason)
      : `0 of ${(firmsValue?._firmsFulfilledCalls ?? 0) + (firmsValue?._firmsFailedCalls ?? 0)} region calls succeeded`;
    console.warn(`[wildfire] FIRMS failed: ${firmsErr}`);
  }
  if (!cwfisOk) console.warn(`[wildfire] CWFIS failed: ${cwfisResult.reason?.message || cwfisResult.reason}`);
  if (!bcOk) console.warn(`[wildfire] BC wildfire failed: ${bcResult.reason?.message || bcResult.reason}`);

  const firmsDetections = firmsOk
    ? tagFirmsDetections(firmsResult.value?.fireDetections || [])
    : [];
  const cwfisDetections = cwfisOk ? (cwfisResult.value?.fireDetections || []) : [];
  const bcDetections = bcOk ? (bcResult.value?.fireDetections || []) : [];
  const baseline = mergeById(firmsDetections, cwfisDetections);
  const merged = enrichOrAppendBc(baseline, bcDetections);
  const cwfisState = cwfisOk ? (cwfisResult.value?._cwfisState || 'ok') : 'failed';
  const cwfisErrorCode = cwfisState === 'ok'
    ? null
    : (cwfisResult.value?._cwfisErrorCode === 'CWFIS_PRESCRIBED_FAILED'
      ? 'CWFIS_PRESCRIBED_FAILED'
      : 'CWFIS_SOURCE_FAILED');
  return {
    fireDetections: merged.fireDetections,
    _firmsCount: firmsDetections.length,
    _firmsState: firmsOk ? 'ok' : 'failed',
    _firmsErrorCode: firmsOk ? null : 'FIRMS_SOURCE_FAILED',
    // Worldwide coverage held, but some regions went dark this run.
    _firmsPartial: firmsPartial,
    _firmsFailedCalls: firmsReportedCalls ? firmsFailedCalls : null,
    _cwfisCount: cwfisDetections.length,
    _cwfisActiveCount: cwfisOk ? (cwfisResult.value?._cwfisActiveCount ?? null) : null,
    _cwfisPrescribedCount: cwfisOk ? (cwfisResult.value?._cwfisPrescribedCount ?? null) : null,
    _cwfisState: cwfisState,
    _cwfisErrorCode: cwfisErrorCode,
    _bcCount: bcDetections.length,
    _bcEnrichedCount: merged._bcEnrichedCount,
    _bcAppendedCount: merged._bcAppendedCount,
    _bcVia: bcOk ? (bcResult.value?._bcVia ?? null) : null,
    _bcState: bcOk ? 'ok' : 'failed',
    _bcErrorCode: bcOk ? null : 'BC_WILDFIRE_SOURCE_FAILED',
  };
}

export function canadianWildfireAfterPublish(data) {
  const cwfisFailed = data?._cwfisState !== 'ok';
  const bcFailed = data?._bcState !== 'ok';
  // FIRMS is the GLOBAL source for this key. Losing it drops the canonical
  // payload from worldwide coverage to Canada only, which is a bigger loss than
  // any Canadian source failing — so it is checked first and reported first.
  // canadaSourceFailureCount deliberately stays a count of CANADIAN sources.
  const firmsFailed = data?._firmsState === 'failed';
  const firmsPartial = data?._firmsPartial === true;
  const failureCount = Number(cwfisFailed) + Number(bcFailed);
  if (failureCount === 0 && !firmsFailed && !firmsPartial) {
    return { freshnessMetaPatch: { sourceState: 'ok' } };
  }
  // Worldwide coverage survived but some FIRMS regions went dark, so the
  // canonical key is quietly narrower than it claims. Ranks below a full FIRMS
  // outage and above healthy: report it rather than let the surviving regions
  // stand in for the globe unremarked.
  if (firmsPartial && !firmsFailed && failureCount === 0) {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'FIRMS_PARTIAL_COVERAGE',
        canadaSourceFailureCount: 0,
      },
    };
  }
  if (firmsFailed) {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'FIRMS_SOURCE_FAILED',
        canadaSourceFailureCount: failureCount,
      },
    };
  }
  let errorCode = 'CANADA_WILDFIRE_SOURCES_FAILED';
  if (failureCount === 1 && cwfisFailed) {
    errorCode = data?._cwfisErrorCode === 'CWFIS_PRESCRIBED_FAILED'
      ? 'CWFIS_PRESCRIBED_FAILED'
      : 'CWFIS_SOURCE_FAILED';
  } else if (failureCount === 1) {
    errorCode = 'BC_WILDFIRE_SOURCE_FAILED';
  }
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode,
      canadaSourceFailureCount: failureCount,
    },
  };
}
