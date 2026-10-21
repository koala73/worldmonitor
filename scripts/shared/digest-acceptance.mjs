/** Total items across every category bucket. */
export function countDigestItems(data) {
  // Redis is external input. A malformed bucket must count as empty instead
  // of aborting the acceptance check for the complete digest.
  return Object.values(data.categories ?? {}).reduce((sum, bucket) => (
    sum + (Array.isArray(bucket?.items) ? bucket.items.length : 0)
  ), 0);
}

/** Structural acceptance: at least one category and at least one item. */
export function isAcceptableDigest(data) {
  if (!data || typeof data !== 'object') return false;
  const categories = data.categories;
  if (!categories || typeof categories !== 'object') return false;
  return Object.keys(categories).length >= 1 && countDigestItems(data) >= 1;
}
