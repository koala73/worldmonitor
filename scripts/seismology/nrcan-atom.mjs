// Pure Earthquakes Canada (NRCan) Atom parser + USGS merge/dedup helpers.
// Tests import this module, not the seeder entrypoint.

import { CHROME_UA, httpRetryError, roundGeoCoordinate, withRetry } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';

export const NRCAN_ATOM_HOST = 'www.earthquakescanada.nrcan.gc.ca';
export const NRCAN_ATOM_URL = 'https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-en.atom';
export const NRCAN_OFFICIAL_PAGE = 'https://www.earthquakescanada.nrcan.gc.ca/index-en.php?tpl_region=canada';
// Live canada-en.atom was 343771 bytes on 2026-08-13; 342KB is below that, so raise.
export const MAX_NRCAN_ATOM_BYTES = 1024 * 1024;
export const EARTHQUAKES_MAX_CONTENT_AGE_MIN = 2 * 24 * 60; // 48h — min() of successful upstream newest
export const EARTHQUAKE_PROVIDERS_KEY = 'seismology:earthquakes:providers:v1';
const PROVIDER_MAX_AGE_MS = 30 * 60_000;
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
    this.nonRetryable = true;
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
    throw Object.assign(new Error('RESPONSE_TOO_LARGE'), { nonRetryable: true });
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw Object.assign(new Error('RESPONSE_TOO_LARGE'), { nonRetryable: true });
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
        throw Object.assign(new Error('RESPONSE_TOO_LARGE'), { nonRetryable: true });
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
    throw Object.assign(new Error('UNTRUSTED_SOURCE_HOST'), { nonRetryable: true });
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
  if (!response.ok) {
    await response.body?.cancel?.();
    throw httpRetryError(response, { remainingBudgetMs: 2_000 });
  }
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
    throw Object.assign(new Error('SEED_ERROR'), { nonRetryable: true });
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

function usableProvider(snapshot, source, nowMs) {
  return snapshot && Number.isSafeInteger(snapshot.fetchedAt)
    && snapshot.fetchedAt > 0 && snapshot.fetchedAt <= nowMs
    && nowMs - snapshot.fetchedAt < PROVIDER_MAX_AGE_MS
    && Number.isSafeInteger(snapshot.newestAt) && snapshot.newestAt > 0
    && snapshot.newestAt <= nowMs + CLOCK_SKEW_MS
    && nowMs - snapshot.newestAt <= EARTHQUAKES_MAX_CONTENT_AGE_MIN * 60_000
    && Array.isArray(snapshot.earthquakes)
    && snapshot.earthquakes.every(eq => eq?.source === source && typeof eq.id === 'string'
      && eq.id.length > 0 && Number.isFinite(eq.magnitude) && Number.isFinite(eq.occurredAt)
      && Number.isFinite(eq.location?.latitude) && Number.isFinite(eq.location?.longitude));
}

export async function fetchMergedEarthquakes({ fetchUsgs, fetchNrcan, previousSources, nowMs = Date.now() }) {
  const sources = ['usgs', 'nrcan'];
  const results = await Promise.allSettled([fetchUsgs, fetchNrcan].map(fetchSource => withRetry(async () => {
    try { return await fetchSource(); }
    catch (error) {
      if (error instanceof SyntaxError) error.nonRetryable = true;
      throw error;
    }
  }, 1, 500)));
  const snapshots = {};
  const available = {};
  const failedSources = [];
  const failureDetails = [];
  for (const [index, source] of sources.entries()) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      snapshots[source] = { ...result.value, fetchedAt: nowMs, consecutiveFailures: 0, firstFailureAt: null };
      available[source] = snapshots[source];
      continue;
    }
    const previous = previousSources?.[source];
    const usable = usableProvider(previous, source, nowMs);
    const priorCount = previous?.consecutiveFailures;
    const knownStreak = Number.isInteger(priorCount) && priorCount >= 0 && priorCount <= 100;
    const firstFailureAt = knownStreak && priorCount > 0
      && Number.isSafeInteger(previous.firstFailureAt) && previous.firstFailureAt >= previous.fetchedAt
      && previous.firstFailureAt <= nowMs ? previous.firstFailureAt : nowMs;
    // Unknown predecessors, unusable coverage, and permanent failures earn no grace.
    const nextCount = knownStreak ? Math.min(priorCount + 1, 100) : 2;
    const consecutiveFailures = usable && !result.reason?.nonRetryable ? nextCount : Math.max(2, nextCount);
    snapshots[source] = { ...(usable ? previous : {}), consecutiveFailures, firstFailureAt };
    if (usable) available[source] = snapshots[source];
    failedSources.push(source);
    const cause = result.reason?.cause?.code || result.reason?.cause?.message;
    failureDetails.push(`${source}: ${result.reason?.message || result.reason}${cause ? ` (${cause})` : ''}`);
  }
  const failureDetail = failureDetails.join('; ');
  if (failureDetail) console.warn(`[earthquakes] upstream failure: ${failureDetail}`);
  if (!available.usgs && !available.nrcan) {
    // Per-provider retries are already exhausted; runSeed must not multiply them.
    throw Object.assign(new Error(`All earthquake upstreams failed (${failureDetail})`), { nonRetryable: true });
  }
  return {
    earthquakes: mergeEarthquakeFeeds(available.usgs?.earthquakes, available.nrcan?.earthquakes, nowMs),
    _providerSnapshots: snapshots,
    _failedSources: failedSources,
    _failureDetail: failureDetail,
    _lastSourceSuccessAt: sources.every(source => usableProvider(available[source], source, nowMs))
      ? Math.min(...sources.map(source => available[source].fetchedAt)) : null,
    _sourceAttemptAt: nowMs,
    _usgsNewestAt: available.usgs?.newestAt ?? null,
    _usgsOldestAt: available.usgs?.oldestAt ?? null,
    _nrcanNewestAt: available.nrcan?.newestAt ?? null,
    _nrcanOldestAt: available.nrcan?.oldestAt ?? null,
  };
}

/**
 * Content-age is min() of live or retained provider timestamps so USGS
 * freshness cannot hide an NRCan freeze. Missing coverage is reported separately;
 * a retained provider keeps its original clock, never Date.now().
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
 * Preserve the source diagnosis even when retained coverage earns bounded pending.
 * Without complete coverage, content-age alone cannot detect a missing provider.
 * Must be wired to runSeed's afterPublish: publishTransform strips diagnostics,
 * and only freshnessMetaPatch reaches the health reader.
 */
export function earthquakesAfterPublish(data) {
  const failed = Array.isArray(data?._failedSources) ? data._failedSources : [];
  if (!failed.length) return undefined;
  console.warn(
    `[earthquakes] DEGRADED — upstream(s) failed: ${data?._failureDetail || failed.join(', ')}`,
  );
  return {
    completionState: 'DEGRADED',
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: 'EARTHQUAKE_UPSTREAM_INCOMPLETE',
      skipReason: `upstream-failed:${failed.join('+')}`,
      lastSourceSuccessAt: data._lastSourceSuccessAt ?? null,
      lastSourceAttemptAt: data._sourceAttemptAt,
      firstSourceFailureAt: Math.min(...failed.map(source => data._providerSnapshots?.[source]?.firstFailureAt ?? Infinity)),
      consecutiveSourceFailures: Math.max(...failed.map(source => data._providerSnapshots?.[source]?.consecutiveFailures ?? 2)),
      lastSourceFailureCode: 'EARTHQUAKE_UPSTREAM_INCOMPLETE',
    },
  };
}
