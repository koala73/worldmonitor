const DEFAULT_PASSENGER_COUNT = 1;
const MIN_PASSENGER_COUNT = 1;
const MAX_PASSENGER_COUNT = 9;

export function normalizePassengerCount(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_PASSENGER_COUNT);
  if (!Number.isFinite(parsed)) return DEFAULT_PASSENGER_COUNT;
  return Math.max(
    MIN_PASSENGER_COUNT,
    Math.min(Math.trunc(parsed), MAX_PASSENGER_COUNT),
  );
}
