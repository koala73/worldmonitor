// Alert selection + normalisation for scripts/seed-weather-alerts.mjs.
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

function isEligible(feature) {
  return Number.isFinite(severityRank(feature?.properties?.severity));
}

function normalizeAlert(feature) {
  const p = feature.properties;
  const coords = extractCoordinates(feature.geometry);
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
