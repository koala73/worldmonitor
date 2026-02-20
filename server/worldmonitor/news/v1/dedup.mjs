/**
 * Headline deduplication using word-level similarity.
 * Plain JS module so it can be imported from both TS source and .mjs tests.
 */

/** @param {string[]} headlines */
export function deduplicateHeadlines(headlines) {
  const seen = [];
  const unique = [];

  for (const headline of headlines) {
    const normalized = headline.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const words = new Set(normalized.split(' ').filter((w) => w.length >= 4));

    let isDuplicate = false;
    for (const seenWords of seen) {
      const intersection = [...words].filter((w) => seenWords.has(w));
      const similarity = intersection.length / Math.min(words.size, seenWords.size);
      if (similarity > 0.6) { isDuplicate = true; break; }
    }

    if (!isDuplicate) {
      seen.push(words);
      unique.push(headline);
    }
  }

  return unique;
}
