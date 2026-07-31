export const PREDICTION_MARKET_MIN_POOL_COUNTS = Object.freeze({
  geopolitical: 1,
  tech: 1,
  finance: 1,
});

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

export function hasPoolCoverageShortfall(counts, minimums) {
  if (!minimums) return false;
  if (!counts) return true;
  return Object.entries(minimums).some(([pool, minimum]) => counts[pool] < minimum);
}
