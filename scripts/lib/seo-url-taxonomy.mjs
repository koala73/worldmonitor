/**
 * Classify a World Monitor URL into the reviewed page family, a response kind,
 * and a host class.
 *
 * Three dimensions, deliberately kept apart:
 *
 * - **family** is the editorial surface (`countries`, `compare`, `blog`). It is
 *   the dimension the scorecard already reports, so the ids come from
 *   `PAGE_FAMILIES` and nothing here may invent one.
 * - **kind** is what the response *is*. The 2026-09-24 coverage export made the
 *   case for it: 61% of the "Crawled, currently not indexed" population was
 *   `/docs/_next/*` render assets that already serve `noindex`. Counting those
 *   alongside HTML pages produces a headline number that moves when Mintlify
 *   redeploys and renames its hash-versioned chunks, not when anything we own
 *   changes. Reporting HTML indexability separately is the whole point.
 * - **hostClass** separates `www` from the apex and the variant dashboards.
 *   All of them live in the same Domain property, and 521 of 1,000 rows in the
 *   redirect export were not `www`, so a per-family denominator that ignores
 *   the host is wrong rather than merely coarse.
 *
 * `kind` here is the *declared* kind, derived from the URL alone so it is
 * deterministic and testable without a network. The collector records the
 * observed `content-type` and `x-robots-tag` next to it and flags disagreement
 * rather than silently preferring one.
 *
 * Every rule is a mutually exclusive predicate and `classifyUrl` reports how
 * many matched, so "exactly one family and exactly one kind" is a checkable
 * property rather than an artifact of rule ordering.
 */

import { PAGE_FAMILIES } from '../seo-ai-visibility-scorecard.mjs';

const PROPERTY_APEX = 'worldmonitor.app';

/**
 * Subdomains that serve a first-party surface inside the same Domain property.
 * `api` is included: it is in the property and it appears in coverage exports.
 */
const VARIANT_HOSTS = Object.freeze([
  'tech',
  'finance',
  'commodity',
  'happy',
  'energy',
  'api',
]);

export const HOST_CLASSES = Object.freeze(['www', 'apex', 'variant']);

export const URL_KINDS = Object.freeze([
  'html',
  'data',
  'markdown-twin',
  'subresource',
  'feed',
]);

const SUBRESOURCE_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
]);
const DATA_EXTENSIONS = Object.freeze(['.json', '.yaml', '.yml', '.csv']);
const FEED_EXTENSIONS = Object.freeze(['.xml', '.rss', '.atom']);

function fail(message) {
  throw new Error(`[seo-url-taxonomy] ${message}`);
}

const lastSegment = (pathname) => pathname.split('/').filter(Boolean).at(-1) ?? '';
const hasExtension = (pathname, extensions) => {
  const segment = lastSegment(pathname).toLowerCase();
  return extensions.some((extension) => segment.endsWith(extension));
};
const isMarkdownTwin = (pathname) => {
  const segment = lastSegment(pathname).toLowerCase();
  return segment.endsWith('.md')
    || segment.endsWith('.mdx')
    || /^llms[\w.-]*\.txt$/.test(segment);
};

/**
 * Ordered for readability only. The predicates are mutually exclusive, and
 * `classifyUrl` asserts that exactly one matched, so a future edit that makes
 * two of them overlap fails loudly instead of quietly preferring the first.
 */
const KIND_RULES = Object.freeze([
  { kind: 'markdown-twin', matches: (pathname) => isMarkdownTwin(pathname) },
  {
    kind: 'data',
    matches: (pathname) => !isMarkdownTwin(pathname)
      && (hasExtension(pathname, DATA_EXTENSIONS) || lastSegment(pathname) === 'robots.txt'),
  },
  {
    kind: 'feed',
    matches: (pathname) => !isMarkdownTwin(pathname) && hasExtension(pathname, FEED_EXTENSIONS),
  },
  {
    kind: 'subresource',
    matches: (pathname) => !isMarkdownTwin(pathname)
      && hasExtension(pathname, SUBRESOURCE_EXTENSIONS),
  },
  {
    kind: 'html',
    matches: (pathname) => !isMarkdownTwin(pathname)
      && !hasExtension(pathname, DATA_EXTENSIONS)
      && !hasExtension(pathname, FEED_EXTENSIONS)
      && !hasExtension(pathname, SUBRESOURCE_EXTENSIONS)
      && lastSegment(pathname) !== 'robots.txt',
  },
]);

/**
 * First path segment to page family.
 *
 * Keying on the first segment makes the rules mutually exclusive by
 * construction: a path has exactly one first segment, so at most one entry can
 * match. `docs` is handled separately because it splits on the locale.
 *
 * `/country-instability-index/` is the hub for the country score surface and
 * `/accuracy/` is a published methodology record, so they join the families
 * that already own those surfaces rather than each becoming a family of one.
 */
const SEGMENT_FAMILIES = Object.freeze({
  blog: 'blog',
  countries: 'country_pages',
  'country-instability-index': 'country_pages',
  chokepoints: 'chokepoints',
  crises: 'crises',
  tools: 'tools',
  sources: 'sources',
  compare: 'compare',
  research: 'research',
  accuracy: 'research',
  'use-cases': 'use_cases',
  story: 'story_shares',
  dashboard: 'dashboard',
  settings: 'dashboard',
  pro: 'pricing',
  pricing: 'pricing',
  mcp: 'developer_mcp',
  api: 'developer_mcp',
  developers: 'developer_mcp',
  sdks: 'developer_mcp',
  openapi: 'developer_mcp',
  embed: 'developer_mcp',
  reference: 'developer_mcp',
  changelog: 'developer_mcp',
  // Crawl-control and build output. They are never in a sitemap, but they do
  // appear in coverage exports, and an unmapped URL stops the run by design.
  sitemap: 'site_infrastructure',
  'sitemap-main': 'site_infrastructure',
  'sitemap-index': 'site_infrastructure',
  schemamap: 'site_infrastructure',
  robots: 'site_infrastructure',
  assets: 'site_infrastructure',
  favico: 'site_infrastructure',
  favicon: 'site_infrastructure',
  _next: 'site_infrastructure',
});

const normalizedPath = (pathname) => pathname.replace(/\/+$/, '');
const segments = (pathname) => normalizedPath(pathname).split('/').filter(Boolean);

/**
 * Family for the first path segment, with a trailing file extension stripped so
 * `/openapi.json` lands with `/openapi` rather than needing its own entry for
 * every serialization of the same surface.
 */
const segmentFamily = (pathname) => {
  const first = segments(pathname)[0];
  if (first === undefined) return undefined;
  return SEGMENT_FAMILIES[first] ?? SEGMENT_FAMILIES[first.replace(/\.[a-z0-9]{1,6}$/i, '')];
};

const isDocsPath = (pathname) => segments(pathname)[0] === 'docs';
const isDocsLocalePath = (pathname) => {
  const parts = segments(pathname);
  return parts[0] === 'docs' && parts[1] === 'zh';
};

const FAMILY_RULES = Object.freeze([
  // Machine-readable twins are their own family whichever surface they mirror:
  // `/pricing.md` and `/docs/pricing.md` are the same publishing decision, and
  // #8608 exists because only one of them serves `noindex`.
  {
    family: 'markdown_twins',
    matches: (pathname) => isMarkdownTwin(pathname),
  },
  {
    family: 'homepage',
    matches: (pathname) => !isMarkdownTwin(pathname) && segments(pathname).length === 0,
  },
  {
    family: 'docs_zh',
    matches: (pathname) => !isMarkdownTwin(pathname) && isDocsLocalePath(pathname),
  },
  {
    family: 'documentation',
    matches: (pathname) => !isMarkdownTwin(pathname)
      && isDocsPath(pathname)
      && !isDocsLocalePath(pathname),
  },
  {
    family: null,
    segmentTable: true,
    matches: (pathname) => !isMarkdownTwin(pathname)
      && !isDocsPath(pathname)
      && segmentFamily(pathname) !== undefined,
  },
]);

export function classifyHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (host === `www.${PROPERTY_APEX}`) return { host, hostClass: 'www' };
  if (host === PROPERTY_APEX) return { host, hostClass: 'apex' };
  const variant = VARIANT_HOSTS.find((name) => host === `${name}.${PROPERTY_APEX}`);
  if (variant) return { host, hostClass: 'variant' };
  return fail(`host is outside the ${PROPERTY_APEX} property: ${host || '(empty)'}`);
}

/**
 * Classify one absolute URL.
 *
 * Throws on an unmapped path. A catch-all bucket is what made the 2026-09-24
 * coverage read unusable, so an unmapped URL must stop the run and be given a
 * home rather than land in "other".
 */
export function classifyUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return fail(`not an absolute URL: ${String(rawUrl).slice(0, 200)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail(`unsupported protocol ${parsed.protocol} in ${parsed.href}`);
  }
  const { host, hostClass } = classifyHost(parsed.hostname);
  const pathname = parsed.pathname;

  const kindMatches = KIND_RULES.filter((rule) => rule.matches(pathname)).map((rule) => rule.kind);
  if (kindMatches.length !== 1) {
    return fail(
      `${parsed.href} matched ${kindMatches.length} kinds (${kindMatches.join(', ') || 'none'})`,
    );
  }

  const matched = FAMILY_RULES.filter((rule) => rule.matches(pathname));
  const familyMatches = matched.map((rule) => (
    rule.segmentTable ? segmentFamily(pathname) : rule.family
  ));
  if (familyMatches.length === 0) {
    return fail(`${parsed.href} does not map to a page family`);
  }
  if (familyMatches.length > 1) {
    return fail(`${parsed.href} maps ambiguously to ${familyMatches.join(', ')}`);
  }
  const family = familyMatches[0];
  if (!PAGE_FAMILIES.includes(family)) {
    return fail(`${parsed.href} mapped to ${family}, which is not a reviewed page family`);
  }

  const route = `${host}${normalizedPath(pathname) || '/'}`;
  return {
    url: parsed.href,
    route,
    host,
    hostClass,
    family,
    kind: kindMatches[0],
    familyMatches,
    kindMatches,
  };
}

/** Extract every `<loc>` from a sitemap or sitemap index document. */
export function sitemapUrls(xml) {
  const locations = String(xml).match(/<loc>\s*([^<]+?)\s*<\/loc>/g) ?? [];
  return locations.map((match) => match.replace(/<\/?loc>/g, '').trim());
}

/**
 * Map an observed `content-type` header onto a URL kind so the collector can
 * report disagreement between what the URL looks like and what the origin
 * actually served.
 */
export function kindForContentType(contentType) {
  if (typeof contentType !== 'string' || contentType.trim() === '') return null;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/markdown' || mime === 'text/plain') return 'markdown-twin';
  if (mime.endsWith('+json') || mime === 'application/json' || mime === 'text/csv'
    || mime === 'application/yaml' || mime === 'text/yaml') return 'data';
  // Before the +xml rule: an SVG is image/svg+xml and is a render asset.
  if (mime.startsWith('image/') || mime.startsWith('font/')
    || mime === 'text/css' || mime === 'text/javascript'
    || mime === 'application/javascript') return 'subresource';
  if (mime.endsWith('+xml') || mime === 'application/xml' || mime === 'text/xml') return 'feed';
  return null;
}

/** True when an `x-robots-tag` value keeps the URL out of the index. */
export function robotsTagBlocksIndexing(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /\b(noindex|none)\b/i.test(value);
}
