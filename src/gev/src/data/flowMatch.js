/**
 * @file Flow→road matching: assign TomTom congestion levels to Overpass roads.
 *
 * The traffic layer renders dots along OSM road polylines (Overpass), while
 * TomTom flow tiles carry their own (differently segmented) polylines with
 * `traffic_level`. This module snaps flow onto roads geometrically:
 *
 *  1. Every flow polyline is exploded into consecutive coord-pair SEGMENTS
 *     (pairs longer than one cell are subdivided so midpoint hashing can't
 *     miss their extremities) and hashed by midpoint into ~100 m grid cells,
 *     projected to local meters (degree cell size cos(lat)-adjusted).
 *  2. Each road is sampled at up to 7 evenly-spaced points along its length;
 *     each sample looks for the nearest flow segment within 35 m whose
 *     bearing agrees within 30° (folded mod 180° so two-way roads match
 *     opposite-direction flow lines).
 *  3. A road matches when at least half its samples (minimum 2) matched; its
 *     level is the MEDIAN of the matched samples' trafficLevels, and closure
 *     is true if ANY matched segment is closed.
 *
 * Pure and Cesium-free: inputs are plain [[lon,lat],…] polylines, so the
 * whole pipeline is unit-testable with synthetic geometry.
 *
 * @module data/flowMatch
 */

/** @const {number} Meters per degree of latitude (spherical approximation). */
const M_PER_DEG_LAT = 111320;
/** @const {number} Spatial-hash cell size in meters (~100 m per spec). */
const CELL_SIZE_M = 100;
/** @const {number} Max snap distance from a road sample to a flow segment. */
const MATCH_RADIUS_M = 35;
/** @const {number} Max bearing disagreement (degrees, folded mod 180). */
const BEARING_TOLERANCE_DEG = 30;
/** @const {number} Evenly-spaced samples per road. */
const ROAD_SAMPLES = 7;
/** @const {number} Minimum matched samples for a road to count as matched. */
const MIN_MATCHED_SAMPLES = 2;

/**
 * Median of a numeric array (even count averages the two middles).
 * @param {number[]} values
 * @returns {number|null} Median, or null for an empty array.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Bearing (degrees, 0 = north, clockwise) of a projected dx/dy vector. */
function bearingDeg(dx, dy) {
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * Bearing disagreement folded mod 180° — a flow line drawn in the opposite
 * direction of travel still describes the same two-way road.
 * @param {number} a - Bearing (degrees). @param {number} b - Bearing (degrees).
 * @returns {number} min(|Δ|, 180 − |Δ|) in [0, 90].
 */
function bearingDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return Math.min(d, 180 - d);
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by), meters². */
function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/**
 * Match flow segments onto roads.
 *
 * @param {Array<{coords:number[][], type:string}>} roads
 *   Parsed Overpass road objects ([[lon,lat],…] polylines).
 * @param {Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean}>} flowSegments
 *   Decoded flow polylines from `flowTiles.js`.
 * @returns {{
 *   matches: Array<{level:number, closure:boolean}|null>,
 *   matchedCount: number,
 *   candidateCount: number,
 * }}
 *   `matches` is PARALLEL to `roads` (index i describes roads[i]; null = no
 *   flow data for that road, render it exactly as today). `candidateCount` is
 *   the number of roads with at least one flow segment inside the 35 m search
 *   radius regardless of bearing — the denominator for coverage stats.
 */
export function matchFlowToRoads(roads, flowSegments) {
  const roadCount = Array.isArray(roads) ? roads.length : 0;
  const matches = new Array(roadCount).fill(null);
  const empty = { matches, matchedCount: 0, candidateCount: 0 };
  if (roadCount === 0 || !Array.isArray(flowSegments) || flowSegments.length === 0) {
    return empty;
  }

  // Local equirectangular projection anchored at the first flow coordinate —
  // over a ≤0.05° fetch box the distortion is negligible.
  const anchor = flowSegments.find((f) => Array.isArray(f?.coords) && f.coords.length >= 2);
  if (!anchor) return empty;
  const [refLon, refLat] = anchor.coords[0];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  const projX = (lon) => (lon - refLon) * mPerDegLon;
  const projY = (lat) => (lat - refLat) * M_PER_DEG_LAT;

  // ── 1. Spatial hash of flow segments (midpoint-keyed 100 m cells) ──
  /** @type {Map<string, Array<{ax:number,ay:number,bx:number,by:number,bearing:number,level:number,closure:boolean}>>} */
  const grid = new Map();
  const cellOf = (x, y) => `${Math.floor(x / CELL_SIZE_M)},${Math.floor(y / CELL_SIZE_M)}`;

  for (const flow of flowSegments) {
    const coords = flow?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const level = flow.trafficLevel;
    const closure = flow.closure === true;
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = projX(coords[i][0]);
      const ay = projY(coords[i][1]);
      const bx = projX(coords[i + 1][0]);
      const by = projY(coords[i + 1][1]);
      const segLen = Math.hypot(bx - ax, by - ay);
      if (!(segLen > 0)) continue;
      const bearing = bearingDeg(bx - ax, by - ay);
      // Subdivide long pairs so every piece is ≤ one cell — midpoint hashing
      // then guarantees a 3×3 cell probe sees everything within 35 m.
      const pieces = Math.max(1, Math.ceil(segLen / CELL_SIZE_M));
      for (let p = 0; p < pieces; p++) {
        const t0 = p / pieces;
        const t1 = (p + 1) / pieces;
        const seg = {
          ax: ax + (bx - ax) * t0,
          ay: ay + (by - ay) * t0,
          bx: ax + (bx - ax) * t1,
          by: ay + (by - ay) * t1,
          bearing,
          level,
          closure,
        };
        const key = cellOf((seg.ax + seg.bx) / 2, (seg.ay + seg.by) / 2);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(seg);
      }
    }
  }
  if (grid.size === 0) return empty;

  const radius2 = MATCH_RADIUS_M * MATCH_RADIUS_M;
  let matchedCount = 0;
  let candidateCount = 0;

  // ── 2+3. Sample each road and vote ──
  for (let r = 0; r < roadCount; r++) {
    const coords = roads[r]?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    // Project the road once; accumulate arc length for even sampling.
    const xs = new Array(coords.length);
    const ys = new Array(coords.length);
    const cum = new Array(coords.length);
    cum[0] = 0;
    for (let i = 0; i < coords.length; i++) {
      xs[i] = projX(coords[i][0]);
      ys[i] = projY(coords[i][1]);
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    const totalLen = cum[coords.length - 1];
    if (!(totalLen > 0)) continue;

    let hadCandidate = false;
    const matchedLevels = [];
    let matchedClosure = false;

    let cursor = 1; // cum[] is monotonic; samples advance monotonically too
    for (let s = 0; s < ROAD_SAMPLES; s++) {
      // Midpoint-biased fractions keep samples off road endpoints, where
      // cross-street flow lines meet at intersections.
      const target = (totalLen * (s + 0.5)) / ROAD_SAMPLES;
      while (cursor < coords.length - 1 && cum[cursor] < target) cursor++;
      const segT = (target - cum[cursor - 1]) / (cum[cursor] - cum[cursor - 1] || 1);
      const px = xs[cursor - 1] + (xs[cursor] - xs[cursor - 1]) * segT;
      const py = ys[cursor - 1] + (ys[cursor] - ys[cursor - 1]) * segT;
      const sampleBearing = bearingDeg(xs[cursor] - xs[cursor - 1], ys[cursor] - ys[cursor - 1]);

      // 3×3 cell probe around the sample.
      const cx = Math.floor(px / CELL_SIZE_M);
      const cy = Math.floor(py / CELL_SIZE_M);
      let best = null;
      let bestDist2 = radius2;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const bucket = grid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (const seg of bucket) {
            const d2 = pointSegDist2(px, py, seg.ax, seg.ay, seg.bx, seg.by);
            if (d2 > radius2) continue;
            hadCandidate = true; // within radius, bearing not yet checked
            if (bearingDiffDeg(seg.bearing, sampleBearing) >= BEARING_TOLERANCE_DEG) continue;
            if (d2 <= bestDist2) {
              bestDist2 = d2;
              best = seg;
            }
          }
        }
      }
      if (best) {
        matchedLevels.push(best.level);
        if (best.closure) matchedClosure = true;
      }
    }

    if (hadCandidate) candidateCount++;
    if (matchedLevels.length >= Math.max(MIN_MATCHED_SAMPLES, ROAD_SAMPLES / 2)) {
      matches[r] = { level: median(matchedLevels), closure: matchedClosure };
      matchedCount++;
    }
  }

  return { matches, matchedCount, candidateCount };
}
