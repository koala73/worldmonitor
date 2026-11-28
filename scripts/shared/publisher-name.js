/**
 * A publisher name without its case, surrounding space or leading "The".
 * Google News writes "The Times of India" for the outlet the tables call
 * "Times of India", and "Jordan Times" for "The Jordan Times". Lookups try the
 * exact and the case-folded name first, so two outlets whose names differ only
 * by the article ("The Hacker News", "Hacker News") keep their own entries.
 *
 * Publisher families (publisher-families.js) and declared tiers
 * (server/_shared/source-tiers.ts) both resolve names with this fold. It is a
 * leaf of its own so the tier lookup does not pull the family table into
 * every browser chunk that reads a tier.
 *
 * @param {string} name
 * @returns {string}
 */
export function foldPublisherName(name) {
  return name.trim().toLowerCase().replace(/^the\s+/, '');
}
