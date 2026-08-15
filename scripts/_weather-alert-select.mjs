// Alert selection + normalisation for scripts/seed-weather-alerts.mjs, plus
// weatherAlertNotifyLocation() which scripts/ais-relay.cjs dynamically imports
// to attach location to weather_alert notification payloads (see the COPY entry
// in Dockerfile.relay — the relay cannot boot without this file).
// Kept in its own module so the selection rules are unit-testable without
// importing the seeder (which runs runSeed() at import time).

export const MAX_ALERTS = 50;

export function requireAlertFeatures(data) {
  if (!Array.isArray(data?.features)) {
    throw new TypeError('NWS API response is missing a features array');
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

// NWS severity vocabulary, most dangerous first. Anything outside this list —
// including a literal 'Unknown' and an absent severity property — is ineligible.
const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? Number.POSITIVE_INFINITY;
}

function isEligible(feature) {
  return Number.isFinite(severityRank(feature?.properties?.severity));
}

function normalizeAlert(feature) {
  const p = feature.properties;
  const coords = extractCoordinates(feature.geometry);
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
  };
}

/** How many alerts clear the severity filter, before the cap is applied. */
export function eligibleAlertCount(features) {
  return (Array.isArray(features) ? features : []).filter(isEligible).length;
}

export function formatTruncationWarning(eligible, kept) {
  if (eligible <= kept) return null;
  return `weather-alerts: kept ${kept}/${eligible} by severity rank (${eligible - kept} dropped)`;
}

export function validateSelectedAlerts(data) {
  return Array.isArray(data?.alerts);
}

/**
 * The feed arrives in issuance order, so slicing it raw drops whatever was
 * issued late — including tornado warnings sitting behind small-craft
 * advisories. Rank by severity first; Array#sort is stable, so equal-severity
 * alerts keep their issuance order.
 */
export function selectAlerts(features, limit = MAX_ALERTS) {
  return (Array.isArray(features) ? features : [])
    .filter(isEligible)
    .sort((a, b) => severityRank(a.properties.severity) - severityRank(b.properties.severity))
    .slice(0, limit)
    .map(normalizeAlert);
}
