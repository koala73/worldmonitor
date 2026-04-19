/**
 * Bag-of-words Jaccard dedup — extracted verbatim from the earlier
 * inline implementation in scripts/seed-digest-notifications.mjs so
 * the embedding orchestrator can fall back to the exact historical
 * behaviour on any failure (provider outage, wall-clock overrun,
 * REMOTE_EMBED_ENABLED=0, MODE=jaccard).
 *
 * DO NOT tune the threshold here. If embedding accuracy is still
 * short of the flip criterion at the end of the shadow window, fix
 * calibration or the cosine threshold — not this fallback. This
 * function's contract is "whatever production did before the
 * embedding path landed".
 */

// ── Stop-word set ────────────────────────────────────────────────────
// Pruned list of highly-common tokens that dominate Jaccard numerators
// without carrying topical signal. Extracted unchanged from the
// pre-embedding seed-digest-notifications.mjs.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'are', 'was', 'were',
  'has', 'have', 'had', 'be', 'been', 'by', 'from', 'with', 'as', 'it', 'its',
  'says', 'say', 'said', 'according', 'reports', 'report', 'officials', 'official',
  'us', 'new', 'will', 'can', 'could', 'would', 'may', 'also', 'who', 'that', 'this',
  'after', 'about', 'over', 'more', 'up', 'out', 'into', 'than', 'some', 'other',
]);

/**
 * Strip wire-service attribution suffixes like " - Reuters" /
 * " | AP News" / " - reuters.com" so headlines from the same event
 * are comparable across outlets.
 */
export function stripSourceSuffix(title) {
  return title
    .replace(/\s*[-–—]\s*[\w\s.]+\.(?:com|org|net|co\.uk)\s*$/i, '')
    .replace(/\s*[-–—]\s*(?:Reuters|AP News|BBC|CNN|Al Jazeera|France 24|DW News|PBS NewsHour|CBS News|NBC|ABC|Associated Press|The Guardian|NOS Nieuws|Tagesschau|CNBC|The National)\s*$/i, '');
}

/**
 * Tokenise a headline into a lower-cased Set of content words, with
 * stop-words and 1–2 char tokens dropped. The Set shape is what the
 * Jaccard function expects.
 */
export function extractTitleWords(title) {
  return new Set(
    stripSourceSuffix(title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * Classic Jaccard coefficient on two Sets. |A∩B| / |A∪B|. Returns 0
 * when either Set is empty (no arithmetic surprise on Set(0)).
 */
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Representative-selection + mentionCount-sum + mergedHashes contract
 * that composeBriefFromDigestStories / sources-population rely on.
 *
 * Shared helper so the orchestrator's embed path and the Jaccard
 * fallback apply identical semantics — drift here silently breaks
 * downstream. Accepts an array of story refs (already a single
 * cluster) and returns one story object.
 *
 * @param {Array<{hash:string, currentScore:number, mentionCount:number}>} items
 */
export function materializeCluster(items) {
  const sorted = [...items].sort(
    (a, b) => b.currentScore - a.currentScore || b.mentionCount - a.mentionCount,
  );
  const best = { ...sorted[0] };
  if (sorted.length > 1) {
    best.mentionCount = sorted.reduce((sum, s) => sum + s.mentionCount, 0);
  }
  best.mergedHashes = sorted.map((s) => s.hash);
  return best;
}

/**
 * Greedy single-link clustering by Jaccard > 0.55. Preserves the
 * representative-selection + mentionCount-sum + mergedHashes contract
 * that composeBriefFromDigestStories / sources-population rely on.
 *
 * Threshold is a hard-coded literal (not env-tunable) on purpose —
 * this is the permanent fallback. If the number needs to change,
 * the right answer is to flip the caller to MODE=embed with a
 * properly-calibrated cosine threshold, not to fiddle with Jaccard.
 *
 * @param {Array<{title:string, currentScore:number, mentionCount:number, hash:string}>} stories
 */
export function deduplicateStoriesJaccard(stories) {
  const clusters = [];
  for (const story of stories) {
    const words = extractTitleWords(story.title);
    let merged = false;
    for (const cluster of clusters) {
      if (jaccardSimilarity(words, cluster.words) > 0.55) {
        cluster.items.push(story);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ words, items: [story] });
  }
  return clusters.map(({ items }) => materializeCluster(items));
}
