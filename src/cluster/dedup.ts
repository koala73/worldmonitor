import type { NormalizedStory } from '@/types/news-reader';
import { jaccardSimilarity } from './similarity';

const JACCARD_THRESHOLD = 0.8;

export function deduplicateStories(
  newStories: NormalizedStory[],
  existingIds: Set<string>,
): NormalizedStory[] {
  const unique: NormalizedStory[] = [];
  const seenUrls = new Set<string>();
  const seenCleanTitles = new Set<string>();

  for (const story of newStories) {
    // Skip if already in DB
    if (existingIds.has(story.id)) continue;

    // Exact URL dedup
    if (seenUrls.has(story.url)) continue;

    // Exact title dedup
    if (seenCleanTitles.has(story.cleanTitle)) continue;

    // Near-duplicate: check against already-accepted stories in this batch
    let isDupe = false;
    for (const accepted of unique) {
      if (jaccardSimilarity(story.cleanTitle, accepted.cleanTitle) >= JACCARD_THRESHOLD) {
        isDupe = true;
        break;
      }
    }
    if (isDupe) continue;

    seenUrls.add(story.url);
    seenCleanTitles.add(story.cleanTitle);
    unique.push(story);
  }

  return unique;
}
