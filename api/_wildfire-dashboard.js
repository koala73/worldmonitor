export const WILDFIRE_DASHBOARD_DETECTION_LIMIT = 500;

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confidenceRank(confidence) {
  switch (confidence) {
    case 'FIRE_CONFIDENCE_HIGH': return 3;
    case 'FIRE_CONFIDENCE_NOMINAL': return 2;
    case 'FIRE_CONFIDENCE_LOW': return 1;
    default: return 0;
  }
}

function compareFireDetectionsForDashboard(a, b) {
  return Number(Boolean(b?.possibleExplosion)) - Number(Boolean(a?.possibleExplosion))
    || confidenceRank(b?.confidence) - confidenceRank(a?.confidence)
    || numeric(b?.brightness) - numeric(a?.brightness)
    || numeric(b?.frp) - numeric(a?.frp)
    || numeric(b?.detectedAt) - numeric(a?.detectedAt);
}

export function limitFireDetectionsForDashboard(detections, limit = WILDFIRE_DASHBOARD_DETECTION_LIMIT) {
  if (detections.length <= limit) return detections;
  return [...detections].sort(compareFireDetectionsForDashboard).slice(0, limit);
}

export function compactWildfireDashboardPayload(value, limit = WILDFIRE_DASHBOARD_DETECTION_LIMIT) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.fireDetections)) return value;
  if (value.fireDetections.length <= limit) return value;
  return {
    ...value,
    fireDetections: limitFireDetectionsForDashboard(value.fireDetections, limit),
    pagination: { nextCursor: '', totalCount: value.fireDetections.length },
  };
}
