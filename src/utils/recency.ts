/**
 * Recency filtering utilities.
 * Provides time-range filtering for news items, clustered events, and map data.
 * Integrates with URL parameters and the embed bridge for Streamlit control.
 */

export type RecencyRange = '1h' | '6h' | '24h' | '3d' | '7d' | 'all';

const RANGE_MS: Record<Exclude<RecencyRange, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const RANGE_LABELS: Record<RecencyRange, string> = {
  '1h': 'Last Hour',
  '6h': 'Last 6 Hours',
  '24h': 'Last 24 Hours',
  '3d': 'Last 3 Days',
  '7d': 'Last 7 Days',
  all: 'All Time',
};

const VALID_RANGES = new Set<string>(Object.keys(RANGE_LABELS));

/** Type-guard: is the string a valid RecencyRange? */
export function isRecencyRange(value: string): value is RecencyRange {
  return VALID_RANGES.has(value);
}

/** Human-readable label for a recency range. */
export function getRecencyLabel(range: RecencyRange): string {
  return RANGE_LABELS[range];
}

/** Millisecond cutoff for a range (returns 0 for 'all'). */
export function getRecencyMs(range: RecencyRange): number {
  if (range === 'all') return 0;
  return RANGE_MS[range];
}

/**
 * Generic recency filter — returns items whose date field is within the range.
 * Items without a valid date are always included (fail-open).
 */
export function filterByRecency<T>(
  items: T[],
  range: RecencyRange,
  getDate: (item: T) => Date | undefined,
): T[] {
  if (range === 'all') return items;
  const cutoff = Date.now() - RANGE_MS[range];
  return items.filter((item) => {
    const d = getDate(item);
    return !d || d.getTime() >= cutoff;
  });
}

/** Parse a `?recency=` URL parameter, falling back to 'all'. */
export function parseRecencyParam(search: string): RecencyRange {
  const params = new URLSearchParams(search);
  const value = params.get('recency');
  if (value && isRecencyRange(value)) return value;
  return 'all';
}

/** All valid range options (for UI selectors). */
export const RECENCY_OPTIONS: RecencyRange[] = ['1h', '6h', '24h', '3d', '7d', 'all'];
