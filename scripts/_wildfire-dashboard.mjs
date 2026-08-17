export const WILDFIRE_DASHBOARD_DETECTION_LIMIT = 500;

// Cap for the CANONICAL wildfire:fires:v1 key, applied by seed-fire-detections as a
// publishTransform (#5866). FIRMS detection volume is seasonal and unbounded: on 2026-07-30 a
// clean run (27/27 sources OK) accumulated 20,442 detections, serialized to 5.2MB, and
// atomicPublish hard-threw above its 5MB cap — so the seeder exited 1 and published NOTHING,
// letting the deliberately-short 2h TTL expire the key.
//
// Sized from measured bytes, not guessed: a FIRMS-shaped detection serializes to ~270B, and
// the widest one MONITORED_REGIONS can emit (180E/82N coordinates, 'Saudi Arabia',
// FIRE_CONFIDENCE_UNSPECIFIED) to ~288B. Tagging every row with source/kind/emergency and
// appending wider CWFIS agency rows eats that headroom: 15,000 tagged widest FIRMS is
// 4.786MB, and the 2026-07-30 peak mix (~14,416 tagged FIRMS + 584 CWFIS) was measured at
// ~5.11MB — over the atomicPublish hard cap. Count-ranking is therefore only the first cut;
// compactWildfireDashboardPayload also trims the ranked tail until the caller-measured
// envelope is under maxBytes. tests/wildfire-payload-cap.test.mts pins a tagged+CWFIS
// fixture that would have been 5.11MB, so widening FireDetection or dropping the byte trim
// goes red in CI rather than crashing the seeder in production.
//
// This is far above WILDFIRE_DASHBOARD_DETECTION_LIMIT — the dashboard never renders more
// than 500. The canonical key is sized for the ANALYTICAL consumers that read it whole
// (seed-thermal-escalation clustering, seed-cross-source-signals, CII risk scores).
export const WILDFIRE_CANONICAL_DETECTION_LIMIT = 15_000;

// CWFIS rows are forced HIGH with brightness 0 / frp 0, so on a busy FIRMS day they lose
// the dashboard comparator and vanish from the bootstrap 500. Reserve this many
// source=cwfis slots so Canada agency fires still reach the map.
export const WILDFIRE_BOOTSTRAP_CWFIS_RESERVED = 50;
export const WILDFIRE_CWFIS_SOURCE = 'cwfis';

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

function compareCwfisForReservation(a, b) {
  return numeric(b?.fireSize) - numeric(a?.fireSize)
    || numeric(b?.detectedAt) - numeric(a?.detectedAt)
    || compareFireDetectionsForDashboard(a, b);
}

function isCwfisDetection(detection) {
  return detection?.source === WILDFIRE_CWFIS_SOURCE;
}

// Keep in lockstep with isEmergencyPagingCandidate in wildfire/cwfis-wfs.mjs.
// Prescribed / emergency:false burns must not occupy the dashboard 500 or the
// 50 reserved source=cwfis bootstrap slots (live: 22 prescribed EX, overlap 0).
function isDashboardEmergencyFire(detection) {
  if (!detection || typeof detection !== 'object') return false;
  if (detection.kind === 'prescribed') return false;
  if (detection.emergency === false) return false;
  if (detection.fireWasPrescribed === 1 || detection.fireWasPrescribed === true) return false;
  return true;
}

export function limitFireDetectionsForDashboard(detections, limit = WILDFIRE_DASHBOARD_DETECTION_LIMIT) {
  if (!Array.isArray(detections)) return detections;
  // Dashboard/bootstrap 500 never shows prescribed burns. Canonical 15k and
  // comparator unit tests (limit !== 500) keep the full mix.
  const pool = limit === WILDFIRE_DASHBOARD_DETECTION_LIMIT
    ? detections.filter(isDashboardEmergencyFire)
    : detections;
  if (pool.length <= limit) return pool;
  // Reservation is for the dashboard/bootstrap 500 only. Canonical 15k already keeps
  // HIGH CWFIS, and unit tests pass limit=1 to pin comparator order.
  if (limit !== WILDFIRE_DASHBOARD_DETECTION_LIMIT) {
    return [...pool].sort(compareFireDetectionsForDashboard).slice(0, limit);
  }
  const cwfis = [];
  const others = [];
  for (const detection of pool) {
    if (isCwfisDetection(detection)) cwfis.push(detection);
    else others.push(detection);
  }
  const reservedCount = Math.min(WILDFIRE_BOOTSTRAP_CWFIS_RESERVED, limit, cwfis.length);
  const keptCwfis = [...cwfis].sort(compareCwfisForReservation).slice(0, reservedCount);
  const keptOthers = [...others].sort(compareFireDetectionsForDashboard).slice(0, limit - reservedCount);
  return [...keptCwfis, ...keptOthers].sort(compareFireDetectionsForDashboard);
}

/**
 * Drop the ranked tail until measureBytes({ fireDetections, pagination }) <= maxBytes.
 * measureBytes is supplied by the seeder so this helper stays Edge-safe and does not
 * import the seed envelope.
 */
export function trimFireDetectionsToByteBudget(detections, {
  maxBytes,
  measureBytes,
  totalCount = detections.length,
} = {}) {
  if (!Array.isArray(detections) || typeof measureBytes !== 'function' || !Number.isFinite(maxBytes)) {
    return detections;
  }
  const wrap = (slice) => ({
    fireDetections: slice,
    pagination: { nextCursor: '', totalCount },
  });
  if (measureBytes(wrap(detections)) <= maxBytes) return detections;
  let lo = 0;
  let hi = detections.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measureBytes(wrap(detections.slice(0, mid))) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return detections.slice(0, best);
}

export function compactWildfireDashboardPayload(value, limit = WILDFIRE_DASHBOARD_DETECTION_LIMIT, options = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.fireDetections)) return value;
  const needsCountCap = value.fireDetections.length > limit;
  // Dashboard/bootstrap 500 must always run limitFire so prescribed EX burns
  // are dropped even on a quiet day (count ≤ 500). Canonical 15k keeps the mix.
  const needsDashboardFilter = limit === WILDFIRE_DASHBOARD_DETECTION_LIMIT;
  const needsByteCap = Number.isFinite(options.maxBytes) && typeof options.measureBytes === 'function';
  if (!needsCountCap && !needsDashboardFilter && !needsByteCap) return value;

  let fireDetections = (needsCountCap || needsDashboardFilter)
    ? limitFireDetectionsForDashboard(value.fireDetections, limit)
    : value.fireDetections;
  if (needsByteCap) {
    fireDetections = trimFireDetectionsToByteBudget(fireDetections, {
      maxBytes: options.maxBytes,
      measureBytes: (candidate) => options.measureBytes({ ...value, ...candidate }),
      totalCount: value.fireDetections.length,
    });
  }
  if (fireDetections === value.fireDetections) return value;
  return {
    ...value,
    fireDetections,
    pagination: { nextCursor: '', totalCount: value.fireDetections.length },
  };
}
