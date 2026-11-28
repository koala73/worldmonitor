/** The map time range shared by the 2D SVG map, the deck.gl map and the 3D globe. */
export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';

const HOUR_MS = 60 * 60 * 1000;

export const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '48h': 48 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  all: Infinity,
};

/** Oldest event time the range shows, or null for all. */
export function timeRangeCutoff(range: TimeRange, now = Date.now()): number | null {
  const span = TIME_RANGE_MS[range];
  return Number.isFinite(span) ? now - span : null;
}

/** Epoch ms for a date, ISO string or epoch value; null when missing or unparseable. */
export function parseTimestamp(value: Date | string | number | undefined | null): number | null {
  if (value == null) return null;
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}
