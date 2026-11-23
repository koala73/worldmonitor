// One story-identity rule for the four-row welcome strip, shared by the
// crawlable corpus freeze (scripts/freeze-crawlable-live-pulse.mjs
// selectFrozenHeadlines) and the live strip (pro-test/src/services/teasers.ts).
//
// The URL dedupe in article-identity.js only merges one article reached through
// several feeds. Two outlets' own articles on one event carry different URLs,
// so on 2026-11-23 Meduza's and NV EN's headlines on the Poland missile crash
// took two of the four rows (#11190). Sameness here is the digest's own
// matcher (shared/story-identity.js), the one that already groups those
// headlines for corroboration, at its tuned threshold.
//
// Greedy over ranked input: a row is kept unless it matches a row already
// kept, so the best-ranked copy of each story survives, and the walk stops
// once `limit` rows are kept.

import { cosineSimilarity, storyVector, STORY_SIMILARITY_THRESHOLD } from './story-identity.js';

export function takeDistinctStories(rows, getTitle, limit = Infinity) {
  const kept = [];
  const keptVectors = [];
  let duplicates = 0;
  for (const row of rows) {
    if (kept.length >= limit) break;
    const vector = storyVector(String(getTitle(row) ?? ''));
    if (keptVectors.some((other) => cosineSimilarity(vector, other) >= STORY_SIMILARITY_THRESHOLD)) {
      duplicates += 1;
      continue;
    }
    kept.push(row);
    keptVectors.push(vector);
  }
  return { rows: kept, duplicates };
}
