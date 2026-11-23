/** Types for story-dedupe.js (plain JS so .mjs scripts and tests import it directly). */

export function takeDistinctStories<T>(
  rows: T[],
  getTitle: (row: T) => unknown,
  limit?: number,
): { rows: T[]; duplicates: number };
