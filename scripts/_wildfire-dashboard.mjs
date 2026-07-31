export const WILDFIRE_DASHBOARD_DETECTION_LIMIT = 500;

// Cap for the CANONICAL wildfire:fires:v1 key, applied by seed-fire-detections as a
// publishTransform (#5866). FIRMS detection volume is seasonal and unbounded: on 2026-07-30 a
// clean run (27/27 sources OK) accumulated 20,442 detections, serialized to 5.2MB, and
// atomicPublish hard-threw above its 5MB cap — so the seeder exited 1 and published NOTHING,
// letting the deliberately-short 2h TTL expire the key.
//
// Sized from measured bytes, not guessed: a FIRMS-shaped detection serializes to ~270B, and
// the widest one MONITORED_REGIONS can emit (180E/82N coordinates, 'Saudi Arabia',
// FIRE_CONFIDENCE_UNSPECIFIED) to ~288B. 15,000 x 288B = 4.1MB, ~21% under the 5MB cap even
// in that worst case. tests/wildfire-payload-cap.test.mts pins the budget at 90% of
// MAX_PAYLOAD_BYTES, so raising this limit or widening FireDetection goes red in CI rather
// than crashing the seeder in production.
//
// This is far above WILDFIRE_DASHBOARD_DETECTION_LIMIT — the dashboard never renders more
// than 500. The canonical key is sized for the ANALYTICAL consumers that read it whole
// (seed-thermal-escalation clustering, seed-cross-source-signals, CII risk scores).
export const WILDFIRE_CANONICAL_DETECTION_LIMIT = 15_000;

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
