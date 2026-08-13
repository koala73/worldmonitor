// Alert selection + normalisation for scripts/seed-weather-alerts.mjs
// and the live ais-relay weather writer.
// Kept in its own module so the selection rules are unit-testable without
// importing the seeder (which runs runSeed() at import time).

export const MAX_ALERTS = 50;
// Per-source floor so Canadian alerts cannot be dropped behind US small-craft
// advisories (and vice versa) when the merged cap is applied.
export const PER_SOURCE_FLOOR = 15;
export const WEATHER_ALERTS_SOURCE_VERSION = 'nws+eccc-active';

export const NWS_HOST = 'api.weather.gov';
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
export const ECCC_HOST = 'api.weather.gc.ca';
// Server-side status_en=active (#6607). limit is set high so the national
// collection returns in one page; GeoMet defaults to 10 without it.
export const ECCC_ALERTS_URL = 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&status_en=active&limit=10000';
// National GeoJSON exceeds HKO's 256KiB; 4 MiB is the upper end of the
// deliberate 2–4 MiB ceiling for this collection.
export const ECCC_MAX_BYTES = 4 * 1024 * 1024;

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

export function calculateCentroid(coords) {
  if (coords.length === 0) return undefined;
  const sum = coords.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
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

function nwsVtec(properties) {
  const vtec = properties?.parameters?.VTEC;
  return Array.isArray(vtec) ? vtec[0] : undefined;
}

function normalizeNwsAlert(feature) {
  const p = feature.properties || {};
  const coords = extractCoordinates(feature.geometry);
  const vtec = nwsVtec(p);
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
  return String(feature?.properties?.status_en || '').trim().toLowerCase() === 'active';
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
 * ECCC GeoJSON → existing alert record. Drops status_en !== 'active'
 * (defense in depth on top of the server-side query) and unmapped severity.
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
  const nws = sortBySeverityThenStable(Array.isArray(parts.nws) ? parts.nws : []);
  const eccc = sortBySeverityThenStable(Array.isArray(parts.eccc) ? parts.eccc : []);
  const kept = [...nws.slice(0, perSourceFloor), ...eccc.slice(0, perSourceFloor)];
  const leftover = sortBySeverityThenStable([
    ...nws.slice(perSourceFloor),
    ...eccc.slice(perSourceFloor),
  ]);
  const remaining = Math.max(0, totalLimit - kept.length);
  kept.push(...leftover.slice(0, remaining));
  return sortBySeverityThenStable(kept).slice(0, totalLimit);
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
