/**
 * Indexable-page robots directives.
 *
 * Blog layouts already ship max-image-preview / max-snippet / max-video-preview;
 * homepage, dashboard shells, and the crawlable corpus historically sent only
 * `index, follow`, so AI/search engines applied default citation caps.
 * Keep this string as the single source of truth for those surfaces.
 *
 * max-video-preview:-1 lifts the video-snippet cap. The blog layout has carried
 * it since its own robots meta was written; every other surface omitted it
 * (#7530), so a page that embeds video — the live-channels and dashboard
 * shells already do — got the engine default instead of the same uncapped
 * treatment images and text snippets have.
 */
export const INDEXABLE_ROBOTS_CONTENT =
  'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

/** Paginated changelog pages beyond the index — omit from sitemap crawl budget. */
export const CHANGELOG_PAGINATION_ROBOTS_CONTENT = 'noindex, follow';
