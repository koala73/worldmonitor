// Must stay aligned with CATEGORIES in scripts/_prediction-classify.mjs.
// Edge functions cannot import seeder modules; the parity test in
// tests/prediction-market-classification.test.mjs guards against drift.
export const PREDICTION_MARKET_MIN_POOL_COUNTS = Object.freeze({
  geopolitical: 1,
  tech: 1,
  finance: 1,
});

/**
 * Parse producer-published poolCounts for the configured minimums.
 * Fail closed: any missing key, non-integer, or negative value → null
 * (treated as a shortfall by hasPoolCoverageShortfall).
 */
export function parsePoolCounts(value, minimums) {
  if (!minimums || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counts = {};
  for (const pool of Object.keys(minimums)) {
    const count = value[pool];
    if (!Number.isSafeInteger(count) || count < 0) return null;
    counts[pool] = count;
  }
  return counts;
}

/**
 * True when counts are missing (fail closed) or any configured pool is below
 * its floor. Callers that want "unknown vs empty" should inspect parse results
 * separately — this helper only answers "is coverage proven?".
 */
export function hasPoolCoverageShortfall(counts, minimums) {
  if (!minimums) return false;
  if (!counts) return true;
  return Object.entries(minimums).some(([pool, minimum]) => {
    const count = counts[pool];
    return !Number.isSafeInteger(count) || count < minimum;
  });
}

/**
 * Distance from each pool's published count to its floor.
 *
 * `hasPoolCoverageShortfall` can only answer "has the floor already been
 * breached?", and for probes whose health minimums equal the producer's own
 * publication floors that question is structurally unanswerable: the producer
 * refuses to publish the cohort that would breach them, so health observes a
 * passing cohort or a stale one, never a shortfall. The useful signal — "how
 * close is this to blocking?" — is only readable while the cohort still passes.
 *
 * `low` marks a pool under `marginThreshold` from its floor — a pool exactly at
 * the threshold still has the full margin and is not low. A breached
 * floor (negative margin) is reported low too rather than being filtered out,
 * so this can never read healthier than the shortfall check on the same counts.
 *
 * Fail closed to null on anything unusable — a partial margin map would invite
 * a caller to treat absent pools as comfortable.
 */
export function poolCoverageMargins(counts, minimums, marginThreshold) {
  if (!minimums || !counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  if (!Number.isSafeInteger(marginThreshold) || marginThreshold < 0) return null;
  const margins = {};
  for (const [pool, floor] of Object.entries(minimums)) {
    const count = counts[pool];
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(floor)) return null;
    const margin = count - floor;
    margins[pool] = { count, floor, margin, low: margin < marginThreshold };
  }
  return margins;
}
