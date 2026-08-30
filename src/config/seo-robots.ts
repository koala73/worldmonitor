/**
 * Indexable-page robots directives.
 *
 * Blog layouts already ship max-image-preview / max-snippet; homepage,
 * dashboard shells, and the crawlable corpus historically sent only
 * `index, follow`, so AI/search engines applied default citation caps.
 * Keep this string as the single source of truth for those surfaces.
 */
export const INDEXABLE_ROBOTS_CONTENT =
  'index, follow, max-image-preview:large, max-snippet:-1';

/** Paginated changelog pages beyond the index — omit from sitemap crawl budget. */
export const CHANGELOG_PAGINATION_ROBOTS_CONTENT = 'noindex, follow';
