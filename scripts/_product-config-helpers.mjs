/**
 * Pure helpers for product config generation.
 * Extracted from generate-product-config.mjs for testability.
 */

export function sameStringArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/**
 * Identify bullets that were added to the generated features array relative to
 * the previous snapshot. Returns an array of new English strings that are in
 * `current` but not in `previous`. Compares set membership, so same-length
 * replacements (reworded bullets) are detected as well as length increases.
 */
export function findNewBullets(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return [];
  const previousSet = new Set(previous);
  return current.filter((bullet) => !previousSet.has(bullet));
}

/**
 * Identify bullets that were removed from the generated features array relative
 * to the previous snapshot. Returns an array of English strings that were in
 * `previous` but are no longer in `current`.
 */
export function findRemovedBullets(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return [];
  const currentSet = new Set(current);
  return previous.filter((bullet) => !currentSet.has(bullet));
}

/**
 * Merge a translated locale's feature array with the generated English catalog.
 *
 * Trimming strategy:
 * 1. Remove trailing bullets that exactly match removed English strings — these
 *    are untranslated placeholders left by prior generator appends.
 * 2. If the locale still has more features than English (e.g. a translated bullet
 *    of a removed feature remains), trim positionally from the end so the
 *    generator can resolve the count drift it reports instead of leaving CI
 *    permanently red. This may drop a legitimate translation when a mid-array
 *    bullet was removed; the warning log makes it visible for re-translation.
 *
 * Returns { features, changed, appendedCount, trimmedCount, positionalTrimmedCount }.
 */
export function mergeTranslatedFeatures(currentFeatures, previousGeneratedFeatures, generatedFeatures) {
  const newBullets = findNewBullets(previousGeneratedFeatures, generatedFeatures);
  const removedBullets = findRemovedBullets(previousGeneratedFeatures, generatedFeatures);

  let features = currentFeatures;
  let changed = false;
  let appendedCount = 0;
  let trimmedCount = 0;
  let positionalTrimmedCount = 0;

  // 1. Trim trailing removed-English placeholders (safe: only bullets appended by this generator)
  if (removedBullets.length > 0) {
    const removedSet = new Set(removedBullets);
    let end = features.length;
    while (end > 0 && removedSet.has(features[end - 1])) {
      end--;
    }
    if (end < features.length) {
      trimmedCount = features.length - end;
      features = features.slice(0, end);
      changed = true;
    }
  }

  // 2. Append new English bullets, capped to available slots
  if (newBullets.length > 0 && features.length < generatedFeatures.length) {
    const slots = generatedFeatures.length - features.length;
    const missing = newBullets.filter((bullet) => !features.includes(bullet)).slice(0, Math.max(0, slots));
    if (missing.length > 0) {
      features = [...features, ...missing];
      appendedCount = missing.length;
      changed = true;
    }
  }

  // 3. Positional fallback trim: if the locale still exceeds English, trim from the end
  if (features.length > generatedFeatures.length) {
    positionalTrimmedCount = features.length - generatedFeatures.length;
    features = features.slice(0, generatedFeatures.length);
    changed = true;
  }

  return { features, changed, appendedCount, trimmedCount, positionalTrimmedCount };
}
