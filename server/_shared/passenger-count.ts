const DEFAULT_PASSENGER_COUNT = 1;
const MIN_PASSENGER_COUNT = 1;
const MAX_PASSENGER_COUNT = 9;

/**
 * Normalize passenger counts at request boundaries.
 *
 * Keeps malformed input from placing a non-finite value in an upstream URL or
 * cache key while preserving the existing finite-value clamp semantics.
 */
export function normalizePassengerCount(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_PASSENGER_COUNT);
  if (!Number.isFinite(parsed)) return DEFAULT_PASSENGER_COUNT;
  return Math.max(
    MIN_PASSENGER_COUNT,
    Math.min(parsed, MAX_PASSENGER_COUNT),
  );
}
