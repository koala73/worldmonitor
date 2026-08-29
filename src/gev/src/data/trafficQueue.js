/**
 * @file Queue-spawn helpers for jammed roads — platoon position math only.
 * Cesium-free so bumper-to-bumper spacing is unit-testable; the traffic
 * layer maps the returned distances onto Cartesian3 waypoints at spawn time.
 *
 * Only ever used for live-flow jam-bucket roads (jamViz 'density'/'both');
 * the keyless simulation never calls into this module.
 *
 * @module data/trafficQueue
 */

/** @const {number} Smallest platoon (cars per queue cluster). */
const PLATOON_MIN = 4;
/** @const {number} Random extra cars per platoon (0–4 → sizes 4–8). */
const PLATOON_SPREAD = 5;
/** @const {number} Meters — minimum bumper-to-bumper gap inside a platoon. */
const GAP_MIN_M = 6;
/** @const {number} Meters — random extra gap (6–12 m total). */
const GAP_SPREAD_M = 6;

/**
 * Generate `count` along-road distances clustered into bumper-to-bumper
 * platoons: each platoon anchors at a random distance and trails 4–8 cars
 * behind it at 6–12 m gaps, wrapping around the road start. Platoons are
 * returned as separate arrays so the caller can give each queue one shared
 * travel direction.
 *
 * @param {number} totalLen - Road length in meters.
 * @param {number} count    - Dots to place across all platoons.
 * @param {() => number} [rng=Math.random] - Uniform [0,1) source (injectable for tests).
 * @returns {number[][]} Platoons of distances in [0, totalLen); total length
 *   across platoons is `count` (empty on degenerate input).
 */
export function queuePlatoons(totalLen, count, rng = Math.random) {
  const platoons = [];
  if (!Number.isFinite(totalLen) || totalLen <= 0 || !(count > 0)) return platoons;

  let placed = 0;
  while (placed < count) {
    const platoonSize = Math.min(
      count - placed,
      PLATOON_MIN + Math.floor(rng() * PLATOON_SPREAD)
    );
    const anchor = rng() * totalLen;
    const platoon = [];
    let trail = 0;
    for (let j = 0; j < platoonSize; j++) {
      if (j > 0) trail += GAP_MIN_M + rng() * GAP_SPREAD_M;
      const s = anchor - trail;
      platoon.push(((s % totalLen) + totalLen) % totalLen);
    }
    platoons.push(platoon);
    placed += platoonSize;
  }
  return platoons;
}

/**
 * Flat variant of {@link queuePlatoons} — platoon structure discarded.
 *
 * @param {number} totalLen - Road length in meters.
 * @param {number} count    - Dots to place.
 * @param {() => number} [rng=Math.random] - Uniform [0,1) source (injectable for tests).
 * @returns {number[]} Distances in [0, totalLen), length `count` (or empty on
 *   degenerate input).
 */
export function queueDistances(totalLen, count, rng = Math.random) {
  return queuePlatoons(totalLen, count, rng).flat();
}

/**
 * Map an along-road distance to its containing segment and parametric t.
 * Distances beyond the road clamp to the far end; zero-length segments are
 * skipped. A distance landing exactly on a segment boundary resolves to the
 * earlier segment at t=1 (the animator treats t≥1 as a crossing).
 *
 * @param {number[]} segmentDist - Per-segment lengths in meters.
 * @param {number} s             - Along-road distance in meters.
 * @returns {{segIdx:number, t:number}} Segment index + parametric position.
 */
export function locateAlongRoad(segmentDist, s) {
  let remaining = Math.max(0, s);
  const lastIdx = segmentDist.length - 1;
  for (let k = 0; k <= lastIdx; k++) {
    const d = segmentDist[k] || 0;
    if ((d > 0 && remaining <= d) || k === lastIdx) {
      return { segIdx: k, t: d > 0 ? Math.min(1, remaining / d) : 0 };
    }
    remaining -= d;
  }
  return { segIdx: 0, t: 0 };
}
