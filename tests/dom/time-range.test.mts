/** The one time-range table every map and the news filters read (#11157). */
import { describe, expect, it } from 'vitest';
import { TIME_RANGE_MS, parseTimestamp, timeRangeCutoff } from '@/utils/time-range';

describe('time range', () => {
  it('spans each range and leaves ALL unbounded', () => {
    expect(TIME_RANGE_MS).toEqual({ '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '48h': 172_800_000, '7d': 604_800_000, all: Infinity });
    expect(timeRangeCutoff('6h', 100_000_000)).toBe(100_000_000 - 21_600_000);
    expect(timeRangeCutoff('all', 100_000_000)).toBeNull();
  });

  it('parses dates, ISO strings and epochs, and rejects missing or invalid values', () => {
    expect(parseTimestamp(new Date(5))).toBe(5);
    expect(parseTimestamp('1970-01-01T00:00:01Z')).toBe(1000);
    expect(parseTimestamp(42)).toBe(42);
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('not a date')).toBeNull();
  });
});
