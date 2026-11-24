// One story-identity rule for the four-row welcome strip, shared by the
// crawlable corpus freeze (scripts/freeze-crawlable-live-pulse.mjs
// selectFrozenHeadlines) and the live strip (pro-test/src/services/teasers.ts).
//
// The URL dedupe in article-identity.js only merges one article reached through
// several feeds. Two outlets' own articles on one event carry different URLs,
// so on 2026-11-23 Meduza's and NV EN's headlines on the Poland missile crash
// took two of the four rows (#11190).
//
// Two tests, either one is enough:
//
// 1. The digest's own matcher (shared/story-identity.js) at its tuned
//    threshold, the one that already groups headlines for corroboration.
// 2. Shared terms. That matcher scores word overlap, so two outlets that word
//    one event differently fall under its threshold: on 2026-11-24 "North
//    Korea to consider shutting down Swiss diplomatic office" and "North Korea
//    threatens to force closure of Swiss diplomatic office" scored 0.44 and
//    took two rows. Such pairs still share several names and nouns. A pair is
//    one story when it shares at least MIN_SHARED_TERMS terms and they make up
//    at least MIN_SHARED_TERM_RATIO of the shorter headline's terms.
//
// The second test is looser than the digest's threshold, and only the strip
// uses it. Merging two related stories here costs one row, which the next
// ranked story fills; a missed merge shows the same event twice in four rows.
// On the 2026-11-24 full digest's top 40 it merged only same-event pairs
// (North Korea, the US Iran sanctions, the Iowa explosives ruling, the ICJ
// Myanmar ruling) and kept "Iran seizes oil tanker in Strait of Hormuz" apart
// from "Iran threatens to close Strait of Hormuz" (three shared terms). Its
// known weakness is a publisher's boilerplate prefix ("APO Group - Africa
// Newsroom / Press release | ..."), which counts as shared terms.
//
// Greedy over ranked input: a row is kept unless it matches a row already
// kept, so the best-ranked copy of each story survives, and the walk stops
// once `limit` rows are kept.

import { candidateTokens, cosineSimilarity, storyVector, STORY_SIMILARITY_THRESHOLD } from './story-identity.js';

export const MIN_SHARED_TERMS = 4;
export const MIN_SHARED_TERM_RATIO = 0.5;

// candidateTokens drops connector words and short tokens, and adds a
// de-pluralized copy ("sanctions" and "sanction"). Keep one form per word, and
// drop the character pairs it emits for non-Latin scripts, which would count
// as many shared terms for one shared word.
function storyTerms(title) {
  const terms = new Set();
  for (const token of candidateTokens(title)) {
    if (token.length < 3) continue;
    terms.add(token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token);
  }
  return terms;
}

function sharesTerms(a, b) {
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared >= MIN_SHARED_TERMS && shared / smaller >= MIN_SHARED_TERM_RATIO;
}

export function takeDistinctStories(rows, getTitle, limit = Infinity) {
  const kept = [];
  const keptStories = [];
  let duplicates = 0;
  for (const row of rows) {
    if (kept.length >= limit) break;
    const title = String(getTitle(row) ?? '');
    const story = { vector: storyVector(title), terms: storyTerms(title) };
    if (keptStories.some((other) => (
      cosineSimilarity(story.vector, other.vector) >= STORY_SIMILARITY_THRESHOLD
      || sharesTerms(story.terms, other.terms)
    ))) {
      duplicates += 1;
      continue;
    }
    kept.push(row);
    keptStories.push(story);
  }
  return { rows: kept, duplicates };
}
