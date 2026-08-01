import {
  appendContentAttributionToUrl,
  normalizeContentToken,
  type ContentDestination,
} from '../../../shared/content-attribution';

export const BLOG_CONVERSION_EVENT = 'blog-product-cta-click';
export const BLOG_CONVERSION_SOURCE = 'worldmonitor-blog';
export const BLOG_CONVERSION_MEDIUM = 'owned-content';

export type BlogProductDestination = Exclude<ContentDestination, 'unknown'>;

export const BLOG_PRODUCT_URLS: Record<BlogProductDestination, string> = {
  dashboard: 'https://www.worldmonitor.app/dashboard',
  pro: 'https://www.worldmonitor.app/pro',
  api: 'https://www.worldmonitor.app/docs/api-reference',
  mcp: 'https://www.worldmonitor.app/docs/mcp-quickstart',
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
  return normalizeContentToken(value, fallback);
}

/**
 * Put the same bounded dimensions on the handoff URL as on the Umami click
 * event. Inbound UTM parameters are added by the static page at click time so
 * the build remains deterministic and never overwrites an existing campaign.
 */
export function buildBlogProductLinkUrl(
  destination: BlogProductDestination,
  placement: string,
  campaign: string | undefined,
  href?: string,
): string {
  return appendContentAttributionToUrl(href ?? BLOG_PRODUCT_URLS[destination], {
    source: BLOG_CONVERSION_SOURCE,
    medium: BLOG_CONVERSION_MEDIUM,
    campaign: normalizeBlogAttributionToken(campaign, 'blog-site'),
    destination,
    placement: normalizeBlogAttributionToken(placement, 'product-link'),
  });
}
