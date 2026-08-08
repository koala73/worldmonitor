/**
 * #4920 (c): pure recall computation for the external-coverage benchmark.
 *
 * Given headlines from an external reference corpus (GDELT top articles)
 * and the titles the digest actually ingested, compute what fraction of
 * the external stories our pipeline carries — the first number that can
 * honestly answer "did we miss a story?".
 *
 * Matching delegates to shared/story-identity (#4919): the same
 * edit-tolerant similarity the pipeline itself uses for corroboration,
 * so "we have this story" means the same thing here as it does there.
 *
 * Pure module: no I/O.
 */

import {
  storyVector,
  cosineSimilarity,
  STORY_SIMILARITY_THRESHOLD,
} from './shared/story-identity.js';

/**
 * @param {Array<{ title: string; url?: string }>} externalItems
 * @param {string[]} digestTitles
 * @param {{ threshold?: number; maxMissedReported?: number }} [opts]
 */
export function computeRecall(externalItems, digestTitles, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : STORY_SIMILARITY_THRESHOLD;
  const maxMissedReported = opts.maxMissedReported ?? 15;

  const digestVectors = digestTitles
    .map((title) => ({ title, vec: storyVector(title) }))
    .filter((entry) => entry.vec !== null);

  let matched = 0;
  const missed = [];
  let unvectorizable = 0;

  for (const item of externalItems) {
    const vec = storyVector(item.title || '');
    if (!vec) {
      // Contentless external titles can't be matched either way; exclude
      // from the denominator rather than counting them as misses.
      unvectorizable++;
      continue;
    }
    let best = 0;
    let bestTitle = '';
    for (const candidate of digestVectors) {
      const sim = cosineSimilarity(vec, candidate.vec);
      if (sim > best) {
        best = sim;
        bestTitle = candidate.title;
      }
    }
    if (best >= threshold) {
      matched++;
    } else {
      missed.push({ title: item.title, url: item.url, bestScore: Number(best.toFixed(3)), closest: bestTitle });
    }
  }

  const total = matched + missed.length;
  missed.sort((a, b) => a.bestScore - b.bestScore);

  return {
    recallPct: total > 0 ? Number(((matched / total) * 100).toFixed(1)) : null,
    matched,
    total,
    unvectorizable,
    missed: missed.slice(0, maxMissedReported),
    threshold,
  };
}
