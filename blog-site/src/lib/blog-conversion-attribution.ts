export const BLOG_CONVERSION_EVENT = 'blog-product-cta-click';
export const BLOG_CONVERSION_SOURCE = 'worldmonitor-blog';
export const BLOG_CONVERSION_MEDIUM = 'owned-content';

export type BlogProductDestination = 'dashboard' | 'pro';

export const BLOG_PRODUCT_URLS: Record<BlogProductDestination, string> = {
  dashboard: 'https://www.worldmonitor.app/',
  pro: 'https://www.worldmonitor.app/pro',
};

/**
 * Keep attribution values bounded and report-friendly. Article slugs and
 * placements are trusted build-time values today, but normalizing here keeps a
 * future CMS integration from creating unbounded analytics cardinality.
 */
export function normalizeBlogAttributionToken(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

  return normalized || fallback;
}
