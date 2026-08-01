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
