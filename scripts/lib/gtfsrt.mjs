// Reusable GTFS-Realtime Service Alerts adapter.
//
// Agency-parameterised: pass any public GTFS-RT alerts feed URL (TTC today,
// GO Transit after #6617, others later). Protobuf parse lives here so tests
// can exercise it without importing a seeder.

import { CHROME_UA } from '../_seed-utils.mjs';

export const GTFS_RT_MAX_BYTES = 1_048_576;
export const GTFS_RT_TIMEOUT_MS = 15_000;

export const GTFS_RT_CAUSE = Object.freeze({
  1: 'UNKNOWN_CAUSE',
  2: 'OTHER_CAUSE',
  3: 'TECHNICAL_PROBLEM',
  4: 'STRIKE',
  5: 'DEMONSTRATION',
  6: 'ACCIDENT',
  7: 'HOLIDAY',
  8: 'WEATHER',
  9: 'MAINTENANCE',
  10: 'CONSTRUCTION',
  11: 'POLICE_ACTIVITY',
  12: 'MEDICAL_EMERGENCY',
});

export const GTFS_RT_EFFECT = Object.freeze({
  1: 'NO_SERVICE',
  2: 'REDUCED_SERVICE',
  3: 'SIGNIFICANT_DELAYS',
  4: 'DETOUR',
  5: 'ADDITIONAL_SERVICE',
  6: 'MODIFIED_SERVICE',
  7: 'OTHER_EFFECT',
  8: 'UNKNOWN_EFFECT',
  9: 'STOP_MOVED',
  10: 'NO_EFFECT',
  11: 'ACCESSIBILITY_ISSUE',
});

export const GTFS_RT_INCREMENTALITY = Object.freeze({
  0: 'FULL_DATASET',
  1: 'DIFFERENTIAL',
});

export function gtfsRtCacheKey(feedUrl) {
  return `gtfsrt:${feedUrl}`;
}

export class GtfsRtError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GtfsRtError';
    this.code = code;
  }
}

function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos];
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number.MAX_SAFE_INTEGER, offset: pos };
      }
      return { value: Number(result), offset: pos };
    }
    shift += 7n;
    if (shift > 63n) throw new GtfsRtError('MALFORMED_PROTOBUF', 'varint too long');
  }
  throw new GtfsRtError('MALFORMED_PROTOBUF', 'truncated varint');
}

function readLengthDelimited(bytes, offset) {
  const length = readVarint(bytes, offset);
  const start = length.offset;
  const end = start + length.value;
  if (end > bytes.length) throw new GtfsRtError('MALFORMED_PROTOBUF', 'truncated length-delimited field');
  return { value: bytes.subarray(start, end), offset: end };
}

function* iterateFields(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 7;
    offset = tag.offset;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      yield { fieldNumber, wireType, varint: value.value };
      offset = value.offset;
    } else if (wireType === 2) {
      const value = readLengthDelimited(bytes, offset);
      yield { fieldNumber, wireType, bytes: value.value };
      offset = value.offset;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new GtfsRtError('MALFORMED_PROTOBUF', 'truncated 64-bit field');
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new GtfsRtError('MALFORMED_PROTOBUF', 'truncated 32-bit field');
      offset += 4;
    } else {
      throw new GtfsRtError('MALFORMED_PROTOBUF', `unsupported wire type ${wireType}`);
    }
  }
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function pickTranslation(messageBytes) {
  if (!messageBytes) return null;
  const translations = [];
  for (const field of iterateFields(messageBytes)) {
    if (field.fieldNumber !== 1 || !field.bytes) continue;
    let text = '';
    let language = '';
    for (const inner of iterateFields(field.bytes)) {
      if (inner.fieldNumber === 1 && inner.bytes) text = decodeUtf8(inner.bytes);
      if (inner.fieldNumber === 2 && inner.bytes) language = decodeUtf8(inner.bytes);
    }
    translations.push({ text, language });
  }
  const english = translations.find((entry) => entry.language === 'en' && entry.text);
  return english?.text || translations.find((entry) => entry.text)?.text || null;
}

function parseTimeRange(bytes) {
  const range = {};
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.varint != null) range.start = field.varint;
    if (field.fieldNumber === 2 && field.varint != null) range.end = field.varint;
  }
  return range;
}

function parseEntitySelector(bytes) {
  const selector = {};
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) selector.agencyId = decodeUtf8(field.bytes);
    if (field.fieldNumber === 2 && field.bytes) selector.routeId = decodeUtf8(field.bytes);
    if (field.fieldNumber === 3 && field.varint != null) selector.routeType = field.varint;
    if (field.fieldNumber === 5 && field.bytes) selector.stopId = decodeUtf8(field.bytes);
    if (field.fieldNumber === 6 && field.varint != null) selector.directionId = field.varint;
  }
  return selector;
}

function parseLocalizedImage(bytes) {
  const image = {};
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) image.url = decodeUtf8(field.bytes);
    if (field.fieldNumber === 2 && field.bytes) image.mediaType = decodeUtf8(field.bytes);
    if (field.fieldNumber === 3 && field.bytes) image.language = decodeUtf8(field.bytes);
  }
  return image;
}

function parseTranslatedImage(bytes) {
  const images = [];
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) images.push(parseLocalizedImage(field.bytes));
  }
  return images;
}

function parseAlert(bytes) {
  const alert = {
    activePeriod: [],
    informedEntities: [],
    cause: null,
    effect: null,
    url: null,
    headerText: null,
    descriptionText: null,
    images: [],
  };
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) alert.activePeriod.push(parseTimeRange(field.bytes));
    if (field.fieldNumber === 5 && field.bytes) alert.informedEntities.push(parseEntitySelector(field.bytes));
    if (field.fieldNumber === 6 && field.varint != null) {
      alert.cause = GTFS_RT_CAUSE[field.varint] || `CAUSE_${field.varint}`;
    }
    if (field.fieldNumber === 7 && field.varint != null) {
      alert.effect = GTFS_RT_EFFECT[field.varint] || `EFFECT_${field.varint}`;
    }
    if (field.fieldNumber === 8 && field.bytes) alert.url = pickTranslation(field.bytes);
    if (field.fieldNumber === 10 && field.bytes) alert.headerText = pickTranslation(field.bytes);
    if (field.fieldNumber === 11 && field.bytes) alert.descriptionText = pickTranslation(field.bytes);
    if (field.fieldNumber === 16 && field.bytes) alert.images = parseTranslatedImage(field.bytes);
  }
  return alert;
}

function parseHeader(bytes) {
  const header = {
    gtfsRealtimeVersion: null,
    incrementality: 'FULL_DATASET',
    timestamp: null,
  };
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) header.gtfsRealtimeVersion = decodeUtf8(field.bytes);
    if (field.fieldNumber === 2 && field.varint != null) {
      header.incrementality = GTFS_RT_INCREMENTALITY[field.varint] || `INCREMENTALITY_${field.varint}`;
    }
    if (field.fieldNumber === 3 && field.varint != null) header.timestamp = field.varint;
  }
  return header;
}

function parseEntity(bytes) {
  const entity = { id: null, isDeleted: false, alert: null };
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) entity.id = decodeUtf8(field.bytes);
    if (field.fieldNumber === 2 && field.varint != null) entity.isDeleted = field.varint !== 0;
    if (field.fieldNumber === 5 && field.bytes) entity.alert = parseAlert(field.bytes);
  }
  return entity;
}

export function parseGtfsRtServiceAlerts(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new GtfsRtError('MALFORMED_PROTOBUF', 'empty feed');
  const header = {
    gtfsRealtimeVersion: null,
    incrementality: 'FULL_DATASET',
    timestamp: null,
  };
  const alerts = [];
  for (const field of iterateFields(bytes)) {
    if (field.fieldNumber === 1 && field.bytes) Object.assign(header, parseHeader(field.bytes));
    if (field.fieldNumber === 2 && field.bytes) {
      const entity = parseEntity(field.bytes);
      if (entity.isDeleted || !entity.alert) continue;
      alerts.push({
        id: entity.id,
        ...entity.alert,
      });
    }
  }
  // FeedMessage.header + FeedHeader.gtfs_realtime_version are required.
  // A headerless / unknown-field / garbage body must not look like a valid
  // empty alerts feed (zero entities + missing version is not empty-success).
  if (typeof header.gtfsRealtimeVersion !== 'string' || header.gtfsRealtimeVersion.trim() === '') {
    throw new GtfsRtError('MALFORMED_PROTOBUF', 'missing FeedHeader.gtfs_realtime_version');
  }
  return { header, alerts };
}

function assertAllowedFeedUrl(feedUrl, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch (error) {
    throw new GtfsRtError('INVALID_FEED_URL', error.message);
  }
  if (parsed.protocol !== 'https:') {
    throw new GtfsRtError('HOST_NOT_ALLOWED', `refusing non-https feed URL ${parsed.protocol}`);
  }
  const hosts = Array.isArray(allowedHosts) && allowedHosts.length > 0
    ? allowedHosts
    : [parsed.hostname];
  if (!hosts.includes(parsed.hostname)) {
    throw new GtfsRtError('HOST_NOT_ALLOWED', `host ${parsed.hostname} is not allowlisted`);
  }
  return parsed;
}

async function readBoundedBytes(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* still reject */ }
    throw new GtfsRtError('RESPONSE_TOO_LARGE', `content-length ${contentLength} exceeds ${maxBytes}`);
  }
  if (!response.body?.getReader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new GtfsRtError('RESPONSE_TOO_LARGE');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GtfsRtError('RESPONSE_TOO_LARGE', `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function gtfsrtAdapter(feedUrl, options = {}) {
  const allowedHosts = options.allowedHosts;
  const parsed = assertAllowedFeedUrl(feedUrl, allowedHosts);
  const cache = options.cache;
  const cacheKey = gtfsRtCacheKey(feedUrl);
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GTFS_RT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GTFS_RT_MAX_BYTES;
  let response;
  try {
    response = await fetchImpl(feedUrl, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/x-protobuf, application/octet-stream, */*',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new GtfsRtError('TIMEOUT', error.message);
    throw new GtfsRtError('FETCH_FAILED', error?.message || String(error));
  }
  if (response.redirected) throw new GtfsRtError('REDIRECT_BLOCKED', 'redirects are forbidden');
  if (response.url) {
    const resolved = new URL(response.url);
    if (resolved.protocol !== 'https:' || resolved.hostname !== parsed.hostname) {
      throw new GtfsRtError('REDIRECT_BLOCKED', `response URL left ${parsed.hostname}`);
    }
  }
  if (!response.ok) {
    throw new GtfsRtError('HTTP_ERROR', `HTTP ${response.status}`);
  }
  const bytes = await readBoundedBytes(response, maxBytes);
  const parsedFeed = parseGtfsRtServiceAlerts(bytes);
  const snapshot = {
    feedUrl,
    header: parsedFeed.header,
    alerts: parsedFeed.alerts,
  };
  cache?.set(cacheKey, snapshot);
  return snapshot;
}

/**
 * Content clock for a GTFS-RT snapshot, from the feed header's own timestamp
 * (a GTFS-RT spec field, so this serves any GTFS-RT producer).
 *
 * A frozen feed still serves 200s with well-formed protobuf, so every
 * fetch-time signal keeps reporting healthy: the request succeeds, the snapshot
 * validates, and fetchedAt is always now. Freshness has to come from what the
 * producer says about ITSELF, or a dead feed is indistinguishable from a quiet
 * network with no service alerts. That matters most under zeroIsValid, where an
 * empty alerts array is a legitimate quiet period and record count can never
 * tell the two apart.
 */
export function gtfsRtHeaderContentMeta(snapshot, nowMs = Date.now()) {
  const stamped = Date.parse(snapshot?.header?.timestamp ?? '');
  // Never substitute now() for a missing stamp — that substitution is precisely
  // what makes a frozen feed look fresh. No stamp means no content clock.
  if (!Number.isFinite(stamped) || stamped <= 0) return null;
  // A feed stamped in the future cannot bound staleness. Ignore beyond an hour
  // of clock skew rather than letting a producer mask a freeze.
  if (stamped > nowMs + 60 * 60 * 1000) return null;
  return { newestItemAt: stamped, oldestItemAt: stamped };
}
