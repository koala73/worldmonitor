// Pure Earthquakes Canada (NRCan) Atom parser + USGS merge/dedup helpers.
// Tests import this module, not the seeder entrypoint.

import { CHROME_UA, roundGeoCoordinate } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';

export const NRCAN_ATOM_HOST = 'www.earthquakescanada.nrcan.gc.ca';
export const NRCAN_ATOM_URL = 'https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-en.atom';
export const NRCAN_OFFICIAL_PAGE = 'https://www.earthquakescanada.nrcan.gc.ca/index-en.php?tpl_region=canada';
// Live canada-en.atom was 343771 bytes on 2026-08-13; 342KB is below that, so raise.
export const MAX_NRCAN_ATOM_BYTES = 1024 * 1024;
export const EARTHQUAKES_MAX_CONTENT_AGE_MIN = 2 * 24 * 60; // 48h — min() of successful upstream newest
// Align NRCan's 30-day national bulletin with the USGS M4.5+ week layer.
export const USGS_MIN_MAGNITUDE = 4.5;
export const EARTHQUAKES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const NRCAN_ID_PREFIX = 'nrcan:';
export const EARTHQUAKE_DEDUP_TIME_MS = 60_000;
export const EARTHQUAKE_DEDUP_MAGNITUDE = 0.1;
export const EARTHQUAKE_DEDUP_DISTANCE_KM = 10;

const TITLE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC:\s*M(\d+(?:\.\d+)?)\s+(.*)$/i;
const EVENT_ID_RE = /[?&]eventid=([^&]+)/i;
const CLOCK_SKEW_MS = 60 * 60 * 1000;

export class NrcanAtomParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NrcanAtomParseError';
    this.code = 'SEED_ERROR';
  }
}

export function nrcanAtomCacheKey(url = NRCAN_ATOM_URL) {
  return `nrcan-atom:${url}`;
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

function parseOccurredAt(title) {
  const match = TITLE_RE.exec(title);
  if (!match) return null;
  const ts = Date.parse(`${match[1].replace(' ', 'T')}Z`);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function parseTitleMagPlace(title) {
  const match = TITLE_RE.exec(title);
  if (!match) return { magnitude: null, place: title };
  return { magnitude: Number(match[2]), place: match[3].trim() };
}

function parsePoint(block) {
  const match = block.match(/<(?:georss:)?point>([^<]+)<\/(?:georss:)?point>/i);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Full upstream precision is kept HERE on purpose. Coordinates are rounded for
  // the published payload in earthquakesPublishTransform, after dedup has run —
  // isCrossAgencyMatch compares haversine distance against a 10km threshold, and
  // rounding before that comparison moves pairs across it.
  return { latitude, longitude };
}

function parseDepthKm(block) {
  const match = block.match(/<(?:georss:)?elev>([^<]+)<\/(?:georss:)?elev>/i);
  if (!match) return 0;
  const elevM = Number(match[1]);
  if (!Number.isFinite(elevM)) return 0;
  return Math.round((Math.abs(elevM) / 1000) * 100) / 100;
}

function nrcanEventId(idText) {
  const raw = String(idText || '').trim();
  const fromQuery = raw.match(EVENT_ID_RE);
  const eventId = fromQuery ? fromQuery[1] : raw;
  return eventId ? `${NRCAN_ID_PREFIX}${eventId}` : '';
}

function parseCategory(block) {
  const match = block.match(/<category\b[^>]*\bterm=["']([^"']+)["']/i);
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

export function isIndustryRelated(eq) {
  const haystack = `${eq?.category || ''} ${eq?.place || ''}`;
  return /industry-related/i.test(haystack);
}

export function isPublishableEarthquake(eq, nowMs = Date.now()) {
  if (!Number.isFinite(eq?.magnitude) || eq.magnitude < USGS_MIN_MAGNITUDE) return false;
  if (!Number.isFinite(eq?.occurredAt) || eq.occurredAt <= 0) return false;
  if (nowMs - eq.occurredAt > EARTHQUAKES_WINDOW_MS) return false;
  if (isIndustryRelated(eq)) return false;
  return true;
}

function parseFeedUpdatedAt(xml) {
  const headerEnd = xml.search(/<entry\b/i);
  const header = headerEnd === -1 ? xml : xml.slice(0, headerEnd);
  const match = header.match(/<updated>([^<]+)<\/updated>/i);
  if (!match) return null;
  const ts = Date.parse(match[1].trim());
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Parse an Earthquakes Canada Atom document.
 * Well-formed feed with zero entries → { earthquakes: [], feedUpdatedAt }.
 * Anything that is not a feed → NrcanAtomParseError (SEED_ERROR).
 * Missing entry dates are omitted (never Date.now()).
 */
export function parseNrcanAtom(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new NrcanAtomParseError('NRCan Atom is empty');
  }
  if (/<html[\s>]/i.test(xml) || !/<feed\b/i.test(xml)) {
    throw new NrcanAtomParseError('NRCan Atom is not a well-formed feed');
  }

  const feedUpdatedAt = parseFeedUpdatedAt(xml);
  const earthquakes = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const title = tagValue(block, 'title');
    const idText = tagValue(block, 'id');
    const location = parsePoint(block);
    if (!location) continue;
    const { magnitude, place } = parseTitleMagPlace(title);
    if (!Number.isFinite(magnitude)) continue;
    const occurredAt = parseOccurredAt(title);
    // Do not Date.now() a missing stamp — drop the entry from dated identity
    // but still publish it with occurredAt 0 so mag/depth/coords survive.
    const id = nrcanEventId(idText);
    if (!id) continue;
    earthquakes.push({
      id,
      place,
      magnitude,
      depthKm: parseDepthKm(block),
      location,
      occurredAt: occurredAt ?? 0,
      sourceUrl: idText || NRCAN_OFFICIAL_PAGE,
      source: 'nrcan',
      category: parseCategory(block),
    });
  }

  let newestAt = feedUpdatedAt;
  let oldestAt = null;
  for (const eq of earthquakes) {
    if (!Number.isFinite(eq.occurredAt) || eq.occurredAt <= 0) continue;
    if (oldestAt == null || eq.occurredAt < oldestAt) oldestAt = eq.occurredAt;
    if (newestAt == null || eq.occurredAt > newestAt) {
      // Feed <updated> is the freeze signal; event times only fill when the
      // feed stamp is missing — never invent a clock reading.
      if (feedUpdatedAt == null) newestAt = eq.occurredAt;
    }
  }
  if (oldestAt == null) oldestAt = newestAt;

  return { earthquakes, feedUpdatedAt, newestAt, oldestAt };
}

async function readBoundedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
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
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export async function fetchApprovedAtom(url, {
  allowedHosts = [NRCAN_ATOM_HOST],
  maxBytes = MAX_NRCAN_ATOM_BYTES,
  fetchFn = globalThis.fetch,
  cache,
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const cacheKey = nrcanAtomCacheKey(parsed.toString());
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const response = await fetchFn(parsed.toString(), {
    headers: {
      Accept: 'application/atom+xml, application/xml, text/xml, */*',
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  const xml = await readBoundedText(response, maxBytes);
  cache?.set(cacheKey, xml);
  return xml;
}

export async function fetchNrcanAtom({
  fetchFn = globalThis.fetch,
  cache,
  url = NRCAN_ATOM_URL,
} = {}) {
  const xml = await fetchApprovedAtom(url, {
    allowedHosts: [NRCAN_ATOM_HOST],
    maxBytes: MAX_NRCAN_ATOM_BYTES,
    fetchFn,
    cache,
  });
  const parsed = parseNrcanAtom(xml);
  return {
    earthquakes: parsed.earthquakes,
    newestAt: parsed.newestAt,
    oldestAt: parsed.oldestAt,
    feedUpdatedAt: parsed.feedUpdatedAt,
  };
}

export function parseUsgsGeojson(geojson) {
  if (!geojson || typeof geojson !== 'object' || !Array.isArray(geojson.features)) {
    throw new Error('SEED_ERROR');
  }
  const earthquakes = [];
  let newestAt = null;
  let oldestAt = null;
  for (const feature of geojson.features) {
    if (!feature?.properties || !feature?.geometry?.coordinates) continue;
    const occurredAt = feature.properties?.time;
    const eq = {
      id: String(feature.id || ''),
      place: String(feature.properties?.place || ''),
      magnitude: feature.properties?.mag ?? 0,
      depthKm: feature.geometry?.coordinates?.[2] ?? 0,
      // Full precision — rounded in earthquakesPublishTransform, after dedup.
      location: {
        latitude: feature.geometry?.coordinates?.[1] ?? 0,
        longitude: feature.geometry?.coordinates?.[0] ?? 0,
      },
      occurredAt: Number.isFinite(occurredAt) && occurredAt > 0 ? occurredAt : 0,
      sourceUrl: String(feature.properties?.url || ''),
      source: 'usgs',
    };
    earthquakes.push(eq);
    if (Number.isFinite(eq.occurredAt) && eq.occurredAt > 0) {
      if (newestAt == null || eq.occurredAt > newestAt) newestAt = eq.occurredAt;
      if (oldestAt == null || eq.occurredAt < oldestAt) oldestAt = eq.occurredAt;
    }
  }
  const generated = geojson.metadata?.generated;
  if (Number.isFinite(generated) && generated > 0) newestAt = generated;
  return { earthquakes, newestAt, oldestAt };
}

function identityFromId(eq) {
  const id = String(eq?.id || '').trim();
  return id ? `id:${id}` : null;
}

function identityFromBucket(eq) {
  const occurredAt = eq?.occurredAt;
  const mag = eq?.magnitude;
  const lat = eq?.location?.latitude;
  const lon = eq?.location?.longitude;
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return null;
  if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const timeBucket = Math.round(occurredAt / 60_000);
  const magBucket = Math.round(mag * 10);
  const latBucket = Math.round(lat * 20);
  const lonBucket = Math.round(lon * 20);
  return `bucket:${timeBucket}:${magBucket}:${latBucket}:${lonBucket}`;
}

/** Diagnostic identity only. Merge matching uses explicit cross-agency tolerances below. */
export function earthquakeIdentity(eq) {
  return identityFromId(eq) || identityFromBucket(eq);
}

function earthquakeStableKey(eq) {
  return [
    String(eq?.id || ''),
    String(eq?.occurredAt || ''),
    String(eq?.magnitude || ''),
    String(eq?.location?.latitude || ''),
    String(eq?.location?.longitude || ''),
  ].join(':');
}

function sortEarthquakes(events) {
  return [...events].sort((a, b) => (
    (Number(b?.occurredAt) || 0) - (Number(a?.occurredAt) || 0)
    || earthquakeStableKey(a).localeCompare(earthquakeStableKey(b))
  ));
}

function uniquePublishableById(events, nowMs, claimedIds) {
  const out = [];
  for (const eq of sortEarthquakes(events)) {
    if (!isPublishableEarthquake(eq, nowMs)) continue;
    const idKey = identityFromId(eq);
    if (idKey && claimedIds.has(idKey)) continue;
    if (idKey) claimedIds.add(idKey);
    out.push(eq);
  }
  return out;
}

function haversineDistanceKm(a, b) {
  const latA = a?.location?.latitude;
  const lonA = a?.location?.longitude;
  const latB = b?.location?.latitude;
  const lonB = b?.location?.longitude;
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const toRadians = Math.PI / 180;
  const deltaLat = (latB - latA) * toRadians;
  const deltaLon = (lonB - lonA) * toRadians;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat
    + Math.cos(latA * toRadians) * Math.cos(latB * toRadians) * sinLon * sinLon;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isCrossAgencyMatch(usgs, nrcan) {
  const timeDelta = Math.abs(usgs.occurredAt - nrcan.occurredAt);
  const magnitudeDelta = Math.abs(usgs.magnitude - nrcan.magnitude);
  return timeDelta <= EARTHQUAKE_DEDUP_TIME_MS
    && magnitudeDelta <= EARTHQUAKE_DEDUP_MAGNITUDE + 1e-9
    && haversineDistanceKm(usgs, nrcan) <= EARTHQUAKE_DEDUP_DISTANCE_KM;
}

export function mergeEarthquakeFeeds(usgsEvents = [], nrcanEvents = [], nowMs = Date.now()) {
  const claimedIds = new Set();
  const usgs = uniquePublishableById(usgsEvents, nowMs, claimedIds);
  const nrcan = uniquePublishableById(nrcanEvents, nowMs, claimedIds);
  const usgsCandidates = usgs.map(() => []);
  const nrcanCandidates = nrcan.map(() => []);

  for (let usgsIndex = 0; usgsIndex < usgs.length; usgsIndex += 1) {
    for (let nrcanIndex = 0; nrcanIndex < nrcan.length; nrcanIndex += 1) {
      if (!isCrossAgencyMatch(usgs[usgsIndex], nrcan[nrcanIndex])) continue;
      usgsCandidates[usgsIndex].push(nrcanIndex);
      nrcanCandidates[nrcanIndex].push(usgsIndex);
    }
  }

  const duplicateNrcan = new Set();
  for (let usgsIndex = 0; usgsIndex < usgsCandidates.length; usgsIndex += 1) {
    const candidates = usgsCandidates[usgsIndex];
    if (candidates.length !== 1) continue;
    const nrcanIndex = candidates[0];
    if (nrcanCandidates[nrcanIndex].length === 1) duplicateNrcan.add(nrcanIndex);
  }

  return [
    ...usgs,
    ...nrcan.filter((_eq, index) => !duplicateNrcan.has(index)),
  ];
}

export async function fetchMergedEarthquakes({ fetchUsgs, fetchNrcan, nowMs = Date.now() }) {
  const [usgsResult, nrcanResult] = await Promise.allSettled([
    fetchUsgs(),
    fetchNrcan(),
  ]);
  const usgsOk = usgsResult.status === 'fulfilled';
  const nrcanOk = nrcanResult.status === 'fulfilled';
  if (!usgsOk && !nrcanOk) {
    const usgsErr = usgsResult.reason?.message || usgsResult.reason;
    const nrcanErr = nrcanResult.reason?.message || nrcanResult.reason;
    throw new Error(`All earthquake upstreams failed (usgs: ${usgsErr}; nrcan: ${nrcanErr})`);
  }
  if (!usgsOk) console.warn(`[earthquakes] USGS failed: ${usgsResult.reason?.message || usgsResult.reason}`);
  if (!nrcanOk) console.warn(`[earthquakes] NRCan failed: ${nrcanResult.reason?.message || nrcanResult.reason}`);

  const usgsEvents = usgsOk ? (usgsResult.value.earthquakes || []) : [];
  const nrcanEvents = nrcanOk ? (nrcanResult.value.earthquakes || []) : [];
  // A failed upstream must be REPORTED, not merely omitted. earthquakesContentMeta
  // takes min() over the upstreams that answered, which catches a FROZEN NRCan —
  // its stale newestAt drags the minimum down — but not a FAILED one, whose null
  // is filtered out and leaves USGS's fresh timestamp as the answer. An NRCan
  // outage therefore published a fresh, healthy, USGS-only result with every
  // Canadian event silently absent. Callers use _failedSources to degrade.
  const failedSources = [];
  if (!usgsOk) failedSources.push('usgs');
  if (!nrcanOk) failedSources.push('nrcan');
  return {
    earthquakes: mergeEarthquakeFeeds(usgsEvents, nrcanEvents, nowMs),
    _failedSources: failedSources,
    _failureDetail: failedSources.length
      ? [
        usgsOk ? null : `usgs: ${usgsResult.reason?.message || usgsResult.reason}`,
        nrcanOk ? null : `nrcan: ${nrcanResult.reason?.message || nrcanResult.reason}`,
      ].filter(Boolean).join('; ')
      : '',
    _usgsNewestAt: usgsOk ? (usgsResult.value.newestAt ?? null) : null,
    _usgsOldestAt: usgsOk ? (usgsResult.value.oldestAt ?? null) : null,
    _nrcanNewestAt: nrcanOk ? (nrcanResult.value.newestAt ?? null) : null,
    _nrcanOldestAt: nrcanOk ? (nrcanResult.value.oldestAt ?? null) : null,
  };
}

/**
 * Content-age is min() of successful upstream newest timestamps so USGS
 * freshness cannot hide an NRCan freeze. Failed upstreams are omitted —
 * never substituted with Date.now().
 */
export function earthquakesContentMeta(data, nowMs = Date.now()) {
  const newestParts = [];
  const oldestParts = [];
  for (const newest of [data?._usgsNewestAt, data?._nrcanNewestAt]) {
    if (Number.isFinite(newest) && newest > 0 && newest <= nowMs + CLOCK_SKEW_MS) {
      newestParts.push(newest);
    }
  }
  for (const oldest of [data?._usgsOldestAt, data?._nrcanOldestAt]) {
    if (Number.isFinite(oldest) && oldest > 0) oldestParts.push(oldest);
  }
  if (newestParts.length === 0) return null;
  const newestItemAt = Math.min(...newestParts);
  const oldestItemAt = oldestParts.length ? Math.min(...oldestParts) : newestItemAt;
  return { newestItemAt, oldestItemAt };
}

/**
 * The serialization boundary — the ONLY place earthquake coordinates are rounded.
 *
 * 5 decimals is ~1.1m, invisible on the map, and roughly halves the coordinate
 * bytes in the published payload. It happens here rather than in parsePoint /
 * parseUsgsGeojson because mergeEarthquakeFeeds runs first and its
 * isCrossAgencyMatch gates on `haversineDistanceKm(usgs, nrcan) <= 10`: rounding
 * both sides before that comparison perturbs the distance by up to ~2m, which is
 * enough to move a pair across the threshold in either direction (publishing a
 * duplicate, or merging two genuinely distinct events).
 */
export function earthquakesPublishTransform(data) {
  const earthquakes = Array.isArray(data?.earthquakes) ? data.earthquakes : [];
  return {
    earthquakes: earthquakes.map((eq) => (
      eq?.location
        ? {
          ...eq,
          location: {
            ...eq.location,
            latitude: roundGeoCoordinate(eq.location.latitude),
            longitude: roundGeoCoordinate(eq.location.longitude),
          },
        }
        : eq
    )),
  };
}

/**
 * Publishing a single-upstream result is right — one feed beats none — but it
 * must not read OK.
 *
 * earthquakesContentMeta above takes min() over the upstreams that ANSWERED.
 * That catches a FROZEN NRCan, whose stale newestAt drags the minimum down, but
 * not a FAILED one: its null is filtered out and USGS's fresh timestamp becomes
 * the answer. An NRCan outage therefore passed the staleness gate AND the
 * content-age gate while every Canadian event was missing — indistinguishable
 * from a quiet week in Canada.
 *
 * Lives here rather than in the seeder for two reasons: it is pure, and
 * importing seed-earthquakes.mjs executes runSeed() at module scope, so a test
 * could not reach it there.
 *
 * Must be wired as runSeed's `afterPublish`. That is the only path into
 * seed-meta — runSeed writes the metadata itself and merges only
 * `freshnessMetaPatch`. Returning these fields from the fetch function is inert:
 * publishTransform strips them and nothing reads them.
 */
export function earthquakesAfterPublish(data) {
  const failed = Array.isArray(data?._failedSources) ? data._failedSources : [];
  if (!failed.length) return undefined;
  console.warn(
    `[earthquakes] DEGRADED — upstream(s) failed: ${data?._failureDetail || failed.join(', ')}`,
  );
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: 'EARTHQUAKE_UPSTREAM_INCOMPLETE',
      skipReason: `upstream-failed:${failed.join('+')}`,
    },
  };
}
