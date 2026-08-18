// Alert selection + normalisation for scripts/seed-weather-alerts.mjs and the
// live ais-relay weather writer, plus weatherAlertNotifyLocation() which
// scripts/ais-relay.cjs dynamically imports to attach location to weather_alert
// notification payloads (see the COPY entry in Dockerfile.relay — the relay
// cannot boot without this file).
// Kept in its own module so the selection rules are unit-testable without
// importing the seeder (which runs runSeed() at import time).
//
// One pipeline: NWS + ECCC + WMO SWIC all merge into weather:alerts:v1.
// Additional national adapters are sources, not a second weather product.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISO3_TO_ISO2 = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'shared/iso3-to-iso2.json'), 'utf8'),
);

export const MAX_ALERTS = 50;
const WEATHER_ALERT_SOURCES = Object.freeze(['nws', 'eccc', 'swic']);
// Per-source floor so Canadian alerts cannot be dropped behind US small-craft
// advisories (and vice versa) when the merged cap is applied. A third source
// (SWIC) gets the same floor; leftover slots fill by severity.
export const PER_SOURCE_FLOOR = 15;
export const WEATHER_ALERTS_SOURCE_VERSION = 'nws+eccc+swic-v1';

export const NWS_HOST = 'api.weather.gov';
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
export const ECCC_HOST = 'api.weather.gc.ca';
// Live ECCC vocabulary is issued/continued/ended — not 'active'.
// status_en=active returns an empty collection. CQL IN also returned 0,
// so issued and continued are fetched as two separate GETs. limit is set
// high so each national collection returns in one page; GeoMet defaults
// to 10 without it.
export const ECCC_LIVE_STATUSES = Object.freeze(['issued', 'continued']);
const ECCC_ALERTS_COLLECTION = 'https://api.weather.gc.ca/collections/weather-alerts/items';
export const ECCC_ALERTS_URLS = Object.freeze(
  ECCC_LIVE_STATUSES.map((status) => `${ECCC_ALERTS_COLLECTION}?f=json&status_en=${status}&limit=10000`),
);
// Issued URL kept as the single-URL handle for existing host-policy tests.
export const ECCC_ALERTS_URL = ECCC_ALERTS_URLS[0];
// National GeoJSON exceeds HKO's 256KiB; 4 MiB is the upper end of the
// deliberate 2–4 MiB ceiling for this collection.
export const ECCC_MAX_BYTES = 4 * 1024 * 1024;

export const SWIC_HOST = 'severeweather.wmo.int';
export const SWIC_ALERTS_URL = 'https://severeweather.wmo.int/json/wmo_all.json';
export const SWIC_MEMBERS_URL = 'https://severeweather.wmo.int/json/wmo_member.json';
// wmo_all.json is ~1 MB (probed 924 KiB / 2091 items on 2026-08-18). HKO's
// 256 KiB cap would reject the feed; 2 MiB is the deliberate ceiling for this
// host, not an inherited default.
export const SWIC_MAX_BYTES = 2 * 1024 * 1024;
// Polygon-tier national adapters already cover these ISO2 codes. SWIC still
// lists them, but merging those rows would duplicate NWS/ECCC and spend the
// shared 50-cap on geocoded US small-craft instead of the rest of the world.
export const SWIC_SKIP_COUNTRY_CODES = Object.freeze(['US', 'CA']);
export const SWIC_SOURCE_DECISION = Object.freeze({
  source: 'WMO SWIC CAP',
  host: SWIC_HOST,
  status: 'accepted',
  reason: 'RAILWAY_PREFLIGHT_OK',
  optional: true,
  requestCount: 2,
  maxBytes: SWIC_MAX_BYTES,
});
// CAP s/u/c on wmo_all.json are 0–4 integers. Sampled against CAP 1.2 XML:
// s=2→Moderate, s=3→Severe, s=4→Extreme; u=2→Future, u=3→Expected, u=4→Immediate;
// c=2→Possible, c=3→Likely, c=4→Observed. 0 is Unknown (ineligible for s).
const SWIC_SEVERITY = Object.freeze({ 0: 'Unknown', 1: 'Minor', 2: 'Moderate', 3: 'Severe', 4: 'Extreme' });
const SWIC_URGENCY = Object.freeze({ 0: 'Unknown', 1: 'Past', 2: 'Future', 3: 'Expected', 4: 'Immediate' });
const SWIC_CERTAINTY = Object.freeze({ 0: 'Unknown', 1: 'Unlikely', 2: 'Possible', 3: 'Likely', 4: 'Observed' });

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export function requireAlertFeatures(data) {
  if (!Array.isArray(data?.features)) {
    throw new TypeError('weather API response is missing a features array');
  }
  return data.features;
}

export function extractCoordinates(geometry) {
  if (!geometry) return [];
  try {
    if (geometry.type === 'Polygon') {
      return geometry.coordinates[0]?.map(c => [c[0], c[1]]) || [];
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates[0]?.[0]?.map(c => [c[0], c[1]]) || [];
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Every outer ring of the alert's geometry, in GeoJSON [lon, lat] order.
 * `extractCoordinates` deliberately keeps returning only the PRIMARY ring — the
 * map overlay consumes that field and must not change shape — so this is the
 * separate accessor for callers that need the alert's full warned area.
 */
export function extractRings(geometry) {
  if (!geometry) return [];
  try {
    if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0]?.map(c => [c[0], c[1]]);
      return ring ? [ring] : [];
    }
    if (geometry.type === 'MultiPolygon') {
      return (geometry.coordinates || [])
        .map(poly => poly?.[0]?.map(c => [c[0], c[1]]))
        .filter(Array.isArray);
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * RFC 7946 section 3.1.6: a linear ring is closed, with four or more positions,
 * and the first and last positions MUST be identical. A 3-position or unclosed
 * ring is rejected by strict parsers (PostGIS ST_GeomFromGeoJSON raises
 * "Polygon is not closed"), and this payload is forwarded verbatim to
 * third-party webhook endpoints where such a failure is invisible to us.
 */
function isClosedLinearRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Array.isArray(first) && Array.isArray(last)
    && first[0] === last[0] && first[1] === last[1];
}

export function calculateCentroid(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return undefined;
  // A closed ring repeats its first position as its last. Averaging the raw
  // ring counts that vertex twice, which drags the result toward the start
  // vertex AND makes it depend on where the ring happens to start (the same
  // square rotated gives a different answer). On a 1-degree NWS-shaped square
  // that is ~14km of error — immaterial for a map marker, but this value is
  // the proximity-alerting anchor. Drop the duplicate before averaging.
  const closed = coords.length > 1
    && Array.isArray(coords[0]) && Array.isArray(coords[coords.length - 1])
    && coords[0][0] === coords[coords.length - 1][0]
    && coords[0][1] === coords[coords.length - 1][1];
  const ring = closed ? coords.slice(0, -1) : coords;
  const sum = ring.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

/**
 * Map a normalized alert onto the weather_alert notification payload.
 *
 * `lat`/`lon` come from the alert's GeoJSON-order centroid [lon, lat] and are a
 * REPRESENTATIVE point (the primary ring's centre). `geometry` is the
 * authoritative warned area: a Polygon for single-part alerts, a MultiPolygon
 * when NWS warned several disjoint areas. A proximity consumer should prefer
 * `geometry` when present and treat lat/lon as a coarse anchor — for a
 * multi-part alert the centroid belongs to one part only.
 *
 * Omits everything when the centroid is missing or non-numeric, so consumers
 * never see 0,0 from a no-geometry alert; omits `geometry` alone when no ring
 * is a valid closed linear ring.
 */
export function weatherAlertNotifyLocation(alert) {
  const centroid = alert?.centroid;
  if (!Array.isArray(centroid) || centroid.length < 2) return {};
  const [lon, lat] = centroid;
  // typeof BEFORE isFinite: Number(null), Number(''), Number([]) and
  // Number(false) all coerce to a finite 0, which is exactly the 0,0 in the
  // Gulf of Guinea this guard exists to suppress.
  if (typeof lon !== 'number' || typeof lat !== 'number') return {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return {};
  const location = { lat, lon };
  const rings = Array.isArray(alert?.rings) && alert.rings.length > 0
    ? alert.rings
    : (Array.isArray(alert?.coordinates) ? [alert.coordinates] : []);
  const valid = rings.filter(isClosedLinearRing);
  if (valid.length === 1) {
    location.geometry = { type: 'Polygon', coordinates: [valid[0]] };
  } else if (valid.length > 1) {
    location.geometry = { type: 'MultiPolygon', coordinates: valid.map(r => [r]) };
  }
  return location;
}

export function weatherAlertNotifySource(alert) {
  if (alert?.source === 'eccc') return 'ECCC';
  if (alert?.source === 'swic') return 'WMO SWIC';
  if (alert?.source === 'nws') return 'NWS';
  return alert?.source ? String(alert.source).toUpperCase() : 'NWS';
}

export function weatherAlertNotifyCountryCode(alert) {
  const code = String(alert?.countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

// NWS severity vocabulary, most dangerous first. Anything outside this list —
// including a literal 'Unknown' and an absent severity property — is ineligible.
const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? Number.POSITIVE_INFINITY;
}

function isEligibleFeature(feature) {
  return Number.isFinite(severityRank(feature?.properties?.severity));
}

function isEligibleAlert(alert) {
  return Number.isFinite(severityRank(alert?.severity));
}

function nwsVtec(p) {
  const vtec = Array.isArray(p?.parameters?.VTEC) ? p.parameters.VTEC[0] : undefined;
  return vtec;
}

function normalizeNwsAlert(feature) {
  const p = feature.properties || {};
  const coords = extractCoordinates(feature.geometry);
  const vtec = nwsVtec(p);
  const multi = extractRings(feature.geometry);
  return {
    id: feature.id || '',
    event: p.event || '',
    severity: p.severity || 'Unknown',
    headline: p.headline || '',
    description: (p.description || '').slice(0, 500),
    areaDesc: p.areaDesc || '',
    onset: p.onset || '',
    expires: p.expires || '',
    coordinates: coords,
    // Only carried for genuinely multi-part alerts. For the single-polygon
    // majority `rings` would just duplicate `coordinates` in the cached Redis
    // envelope (50 alerts per write), so it is omitted and
    // weatherAlertNotifyLocation falls back to `coordinates`.
    ...(multi.length > 1 ? { rings: multi } : {}),
    centroid: calculateCentroid(coords),
    countryCode: 'US',
    source: 'nws',
    ...(vtec ? { vtec } : {}),
  };
}

/**
 * Map ECCC risk_colour (and alert_type as fallback) onto the NWS severity
 * vocabulary. Unmapped values become Unknown and fail isEligible.
 */
export function mapEcccRiskToSeverity(riskColour, alertType) {
  const colour = String(riskColour || '').trim().toLowerCase();
  if (colour === 'red') return 'Extreme';
  if (colour === 'orange') return 'Severe';
  if (colour === 'yellow') return 'Moderate';
  if (colour === 'green' || colour === 'white' || colour === 'grey' || colour === 'gray') return 'Minor';

  const type = String(alertType || '').trim().toLowerCase();
  if (type === 'warning') return 'Severe';
  if (type === 'watch') return 'Moderate';
  if (type === 'advisory' || type === 'statement') return 'Minor';
  return 'Unknown';
}

export function isActiveEcccFeature(feature) {
  const status = String(feature?.properties?.status_en || '').trim().toLowerCase();
  return ECCC_LIVE_STATUSES.includes(status);
}

export function normalizeEcccAlert(feature) {
  if (!isActiveEcccFeature(feature)) return null;
  const p = feature.properties || {};
  const coords = extractCoordinates(feature.geometry);
  const severity = mapEcccRiskToSeverity(p.risk_colour_en || p.risk_colour, p.alert_type);
  const event = p.alert_name_en || p.alert_short_name_en || '';
  const area = p.feature_name_en || '';
  return {
    id: feature.id || p.feature_id || '',
    event,
    severity,
    headline: event && area ? `${event} — ${area}` : (event || area),
    description: (p.alert_text_en || '').slice(0, 500),
    areaDesc: [area, p.province].filter(Boolean).join(', '),
    onset: p.validity_datetime || p.publication_datetime || '',
    expires: p.expiration_datetime || p.event_end_datetime || '',
    coordinates: coords,
    centroid: calculateCentroid(coords),
    countryCode: 'CA',
    source: 'eccc',
  };
}

/** How many NWS alerts clear the severity filter, before the cap is applied. */
export function eligibleAlertCount(features) {
  return (Array.isArray(features) ? features : []).filter(isEligibleFeature).length;
}

export function formatTruncationWarning(eligible, kept) {
  if (eligible <= kept) return null;
  return `weather-alerts: kept ${kept}/${eligible} by severity rank (${eligible - kept} dropped)`;
}

export function validateSelectedAlerts(data) {
  return Array.isArray(data?.alerts);
}

export function weatherAlertsAfterPublish(data) {
  if (data?.sourceState !== 'degraded') {
    return { freshnessMetaPatch: { sourceState: 'ok' } };
  }
  const failedSources = WEATHER_ALERT_SOURCES.filter(
    (source) => Array.isArray(data?.failedSources) && data.failedSources.includes(source),
  );
  return {
    freshnessMetaPatch: {
      sourceState: 'degraded',
      errorCode: data?.errorCode || 'WEATHER_ALERT_SOURCE_INCOMPLETE',
      ...(failedSources.length > 0 ? { failedSources } : {}),
      ...(data?.skipReason ? { skipReason: String(data.skipReason) } : {}),
    },
  };
}

function sortBySeverityThenStable(alerts) {
  return [...alerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/**
 * Rank eligible NWS features and normalise them. No cap — callers that still
 * need a global slice (legacy tests / NWS-only) use selectAlerts().
 */
export function rankEligibleAlerts(features) {
  return (Array.isArray(features) ? features : [])
    .filter(isEligibleFeature)
    .sort((a, b) => severityRank(a.properties.severity) - severityRank(b.properties.severity))
    .map(normalizeNwsAlert);
}

/**
 * The feed arrives in issuance order, so slicing it raw drops whatever was
 * issued late — including tornado warnings sitting behind small-craft
 * advisories. Rank by severity first; Array#sort is stable, so equal-severity
 * alerts keep their issuance order.
 */
export function selectAlerts(features, limit = MAX_ALERTS) {
  return rankEligibleAlerts(features).slice(0, limit);
}

/**
 * ECCC GeoJSON → existing alert record. Drops status_en outside
 * issued/continued (defense in depth on top of the two server-side
 * queries) and unmapped severity. 'active' is not a live ECCC status.
 */
export function selectEcccAlerts(features) {
  return (Array.isArray(features) ? features : [])
    .map(normalizeEcccAlert)
    .filter(alert => alert && isEligibleAlert(alert));
}

/**
 * Partitioned merge: each live source keeps a floor, remaining slots fill by
 * severity rank. A missing/failed source is treated as [] so the other still
 * publishes.
 */
export function mergeAlertSources(parts = {}, { totalLimit = MAX_ALERTS, perSourceFloor = PER_SOURCE_FLOOR } = {}) {
  const sources = [
    sortBySeverityThenStable(Array.isArray(parts.nws) ? parts.nws : []),
    sortBySeverityThenStable(Array.isArray(parts.eccc) ? parts.eccc : []),
    sortBySeverityThenStable(Array.isArray(parts.swic) ? parts.swic : []),
  ];
  const kept = sources.flatMap((alerts) => alerts.slice(0, perSourceFloor));
  const leftover = sortBySeverityThenStable(sources.flatMap((alerts) => alerts.slice(perSourceFloor)));
  const remaining = Math.max(0, totalLimit - kept.length);
  kept.push(...leftover.slice(0, remaining));
  return sortBySeverityThenStable(kept).slice(0, totalLimit);
}

export function carryFailedWeatherAlertSources(previousAlerts, failedSources = []) {
  const alerts = Array.isArray(previousAlerts) ? previousAlerts : [];
  const failed = new Set(
    Array.isArray(failedSources)
      ? failedSources.filter((source) => WEATHER_ALERT_SOURCES.includes(source))
      : [],
  );
  return Object.fromEntries(
    WEATHER_ALERT_SOURCES.map((source) => [
      source,
      failed.has(source) ? alerts.filter((alert) => alert?.source === source) : [],
    ]),
  );
}

export function mapSwicSeverity(code) {
  return SWIC_SEVERITY[Number(code)] ?? 'Unknown';
}

export function mapSwicUrgency(code) {
  return SWIC_URGENCY[Number(code)] ?? 'Unknown';
}

export function mapSwicCertainty(code) {
  return SWIC_CERTAINTY[Number(code)] ?? 'Unknown';
}

export function normalizeSwicTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const offsetFree = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/,
  );
  const candidate = offsetFree
    ? `${offsetFree[1]}T${offsetFree[2]}${offsetFree[3] || ''}Z`
    : raw;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

export function countryCodeFromSwicUrl(url) {
  const path = String(url || '').trim();
  const match = path.match(/^([a-z]{2})-/i);
  return match ? match[1].toUpperCase() : null;
}

export function iso3ToIso2(iso3) {
  const code = String(iso3 || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  const mapped = ISO3_TO_ISO2[code];
  return typeof mapped === 'string' && /^[A-Z]{2}$/.test(mapped) ? mapped : null;
}

export function indexSwicMembers(data) {
  const byMid = new Map();
  const regions = Array.isArray(data) ? data : [];
  for (const region of regions) {
    for (const member of Array.isArray(region?.members) ? region.members : []) {
      if (member?.mid == null) continue;
      byMid.set(String(member.mid), member);
    }
  }
  return byMid;
}

export function requireSwicItems(data) {
  if (!Array.isArray(data?.items)) {
    throw new TypeError('SWIC response is missing an items array');
  }
  return data.items;
}

function swicCentroid(item, member) {
  const coords = extractCoordinates(item?.geometry);
  if (coords.length) {
    return { coordinates: coords, centroid: calculateCentroid(coords), geometryPrecision: 'polygon' };
  }
  const itemLat = Number(item?.lat ?? item?.latitude);
  const itemLon = Number(item?.lon ?? item?.lng ?? item?.longitude);
  if (Number.isFinite(itemLat) && Number.isFinite(itemLon)
    && itemLat >= -90 && itemLat <= 90 && itemLon >= -180 && itemLon <= 180) {
    return { coordinates: [], centroid: [itemLon, itemLat], geometryPrecision: 'point' };
  }
  const memberLat = Number(member?.lat);
  const memberLon = Number(member?.lng ?? member?.lon);
  if (Number.isFinite(memberLat) && Number.isFinite(memberLon)
    && memberLat >= -90 && memberLat <= 90 && memberLon >= -180 && memberLon <= 180) {
    return { coordinates: [], centroid: [memberLon, memberLat], geometryPrecision: 'country' };
  }
  return null;
}

export function normalizeSwicAlert(item, member) {
  if (!item || typeof item !== 'object') return null;
  const countryCode = countryCodeFromSwicUrl(item.url) || iso3ToIso2(member?.code);
  if (!countryCode || SWIC_SKIP_COUNTRY_CODES.includes(countryCode)) return null;
  const severity = mapSwicSeverity(item.s);
  const placed = swicCentroid(item, member);
  if (!placed) return null;
  const event = String(item.event || '').trim();
  const headline = String(item.headline || event).trim();
  const areaDesc = String(item.areaDesc || '').trim();
  return {
    id: String(item.id || ''),
    event,
    severity,
    headline,
    description: headline.slice(0, 500),
    areaDesc,
    onset: normalizeSwicTimestamp(item.effective || item.sent),
    expires: normalizeSwicTimestamp(item.expires),
    coordinates: placed.coordinates,
    centroid: placed.centroid,
    countryCode,
    source: 'swic',
    geometryPrecision: placed.geometryPrecision,
    urgency: mapSwicUrgency(item.u),
    certainty: mapSwicCertainty(item.c),
    ...(member?.dept ? { authority: String(member.dept) } : {}),
    ...(member?.mid ? { memberId: String(member.mid) } : {}),
  };
}

export function selectSwicAlerts(items, membersByMid = new Map()) {
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizeSwicAlert(item, membersByMid.get(String(item?.mid))))
    .filter((alert) => alert && isEligibleAlert(alert));
}

export async function fetchSwicAlertCatalog({
  fetchFn = globalThis.fetch,
  userAgent,
  maxBytes = SWIC_MAX_BYTES,
} = {}) {
  const [alertsJson, membersJson] = await Promise.all([
    fetchApprovedWeatherJson(SWIC_ALERTS_URL, {
      allowedHosts: [SWIC_HOST],
      maxBytes,
      fetchFn,
      userAgent,
      accept: 'application/json',
    }),
    fetchApprovedWeatherJson(SWIC_MEMBERS_URL, {
      allowedHosts: [SWIC_HOST],
      maxBytes,
      fetchFn,
      userAgent,
      accept: 'application/json',
    }),
  ]);
  return {
    items: requireSwicItems(alertsJson),
    membersByMid: indexSwicMembers(membersJson),
  };
}

async function readResponseLimited(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* still reject */ }
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return JSON.parse(text);
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
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
}

/**
 * Fetch issued + continued as two GETs and concatenate features.
 * One URL failing still returns the other; throws only if both fail.
 */
export async function fetchEcccAlertFeatures({
  fetchFn = globalThis.fetch,
  userAgent,
  maxBytes = ECCC_MAX_BYTES,
} = {}) {
  const results = await Promise.allSettled(
    ECCC_ALERTS_URLS.map((url) => fetchApprovedWeatherJson(url, {
      allowedHosts: [ECCC_HOST],
      maxBytes,
      fetchFn,
      userAgent,
    }).then(requireAlertFeatures)),
  );

  const features = [];
  const failures = [];
  const failedStatuses = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      features.push(...result.value);
    } else {
      failures.push(result.reason);
      failedStatuses.push(ECCC_LIVE_STATUSES[index]);
    }
  });
  if (failures.length === results.length) {
    const detail = failures.map((err) => err?.message || String(err)).join('; ');
    throw new Error(`ECCC issued and continued fetches both failed: ${detail}`);
  }
  // Returns an OBJECT, not a bare array, so a partial fetch cannot be consumed
  // as if it were the whole set. `issued` and `continued` are two separate GETs
  // and each carries alerts the other does not: `continued` is where an ONGOING
  // warning lives after its first issue. Returning just the surviving features
  // when one status 500s publishes a silently truncated national alert set —
  // and on the relay, whose purge semantics always overwrite, it DELETES every
  // continued alert from the live key while health still reads OK.
  return {
    features,
    failedStatuses,
    partial: failedStatuses.length > 0,
    failureDetail: failures.map((err) => err?.message || String(err)).join('; '),
  };
}

/**
 * Host-policy fetch: allowlist, reject redirects, timeout, byte ceiling.
 * No fetch.bind. Callers pass fetchFn for tests.
 */
export async function fetchApprovedWeatherJson(url, {
  allowedHosts,
  maxBytes = ECCC_MAX_BYTES,
  fetchFn = globalThis.fetch,
  userAgent = CHROME_UA,
  timeoutMs = 15_000,
  accept = 'application/geo+json',
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const response = await fetchFn(parsed.toString(), {
    headers: { Accept: accept, 'User-Agent': userAgent },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readResponseLimited(response, maxBytes);
}
