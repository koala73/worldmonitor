/**
 * Docs locale SEO helpers for Mintlify-backed /docs pages.
 *
 * Mintlify hosts the HTML (rewritten via vercel.json). When the Chinese
 * locale folder is `zh/` but document language / hreflang are missing or
 * wrong, we rewrite full-document HTML responses in middleware before they
 * reach crawlers.
 *
 * Cluster contract (issue #7378):
 * - English docs: <html lang="en"> + reciprocal en / zh-Hans / x-default
 * - Chinese docs: <html lang="zh-Hans"> + reciprocal en / zh-Hans / x-default
 * - x-default points at the English URL
 */

import { ORGANIZATION_ID, WEBSITE_ID } from './schema-graph-ids';
import { DOCS_PAGE_DATES } from './docs-page-dates.generated';

export const DOCS_PUBLIC_ORIGIN = 'https://www.worldmonitor.app';
export const DOCS_ZH_HREFLANG = 'zh-Hans';
export const DOCS_EN_HREFLANG = 'en';
export const DOCS_UPSTREAM_ORIGIN = 'https://worldmonitor.mintlify.dev';

/**
 * Vercel Routing Middleware's default maxDuration is 25s. Bound the Mintlify
 * fetch (headers + transformed-body read) below that so a hung origin returns
 * 502 instead of waiting for a platform cancel.
 */
export const DOCS_UPSTREAM_TIMEOUT_MS = 8_000;
export const ROUTING_MIDDLEWARE_RESPONSE_DEADLINE_MS = 25_000;

const DOCS_PREFIX = '/docs/';
const DOCS_ZH_PREFIX = '/docs/zh/';

export type DocsLocalePair = {
  enPath: string;
  zhPath: string;
  active: 'en' | 'zh';
};

/** Paths that are Mintlify platform assets or non-document endpoints. */
export function isDocsHtmlDocumentPath(pathname: string): boolean {
  if (pathname === '/docs' || pathname === '/docs/') return false;
  if (!pathname.startsWith(DOCS_PREFIX)) return false;
  if (pathname === '/docs/mcp' || pathname.startsWith('/docs/mcp/')) return false;
  if (pathname.startsWith('/docs/_')) return false;
  // Static / generated files (css, js, images, markdown twins, xml, …)
  if (/\.[a-z0-9]+$/i.test(pathname) && !pathname.endsWith('.html')) return false;
  return true;
}

/**
 * Full document navigations only — skip Next.js RSC / flight fetches so the
 * Mintlify client router keeps working.
 */
export function isDocsFullDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('rsc') === '1') return false;
  if (request.headers.get('next-router-state-tree')) return false;
  if (request.headers.get('next-router-prefetch')) return false;
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/x-component')) return false;
  if (accept.includes('text/html')) return true;
  // Crawlers often send */* or an empty Accept.
  return accept === '' || accept === '*/*' || accept.startsWith('*/*');
}

export function resolveDocsLocalePair(pathname: string): DocsLocalePair | null {
  if (!isDocsHtmlDocumentPath(pathname)) return null;

  if (pathname.startsWith(DOCS_ZH_PREFIX)) {
    const rest = pathname.slice(DOCS_ZH_PREFIX.length);
    if (!rest) return null;
    return {
      enPath: `${DOCS_PREFIX}${rest}`,
      zhPath: pathname,
      active: 'zh',
    };
  }

  const rest = pathname.slice(DOCS_PREFIX.length);
  if (!rest || rest.startsWith('zh/')) return null;
  return {
    enPath: pathname,
    zhPath: `${DOCS_ZH_PREFIX}${rest}`,
    active: 'en',
  };
}

export function docsAbsoluteUrl(path: string): string {
  return `${DOCS_PUBLIC_ORIGIN}${path}`;
}

export function buildDocsHreflangLinkTags(pathname: string): string[] {
  const pair = resolveDocsLocalePair(pathname);
  if (!pair) return [];
  const enHref = docsAbsoluteUrl(pair.enPath);
  const zhHref = docsAbsoluteUrl(pair.zhPath);
  return [
    `<link rel="alternate" hreflang="x-default" href="${enHref}" />`,
    `<link rel="alternate" hreflang="${DOCS_EN_HREFLANG}" href="${enHref}" />`,
    `<link rel="alternate" hreflang="${DOCS_ZH_HREFLANG}" href="${zhHref}" />`,
  ];
}

function replaceHtmlLang(html: string, lang: string): string {
  if (/<html\b[^>]*\blang="/i.test(html)) {
    return html.replace(/(<html\b[^>]*\blang=")[^"]*(")/i, `$1${lang}$2`);
  }
  return html.replace(/<html\b/i, `<html lang="${lang}"`);
}

function replaceOgLocale(html: string, locale: string): string {
  // Mintlify currently emits name="og:locale"; Open Graph also allows property=.
  if (/og:locale/i.test(html)) {
    return html
      .replace(
        /(<meta\b[^>]*(?:name|property)="og:locale"[^>]*content=")[^"]*(")/i,
        `$1${locale}$2`,
      )
      .replace(
        /(<meta\b[^>]*content=")[^"]*("[^>]*(?:name|property)="og:locale")/i,
        `$1${locale}$2`,
      );
  }
  return html;
}

function stripExistingDocsHreflang(html: string): string {
  return html.replace(
    /\s*<link\b[^>]*\brel=["']alternate["'][^>]*\bhreflang=["'][^"']+["'][^>]*>/gi,
    '',
  );
}

function injectAfterCanonical(html: string, linkTags: string[]): string {
  if (linkTags.length === 0) return html;
  const block = linkTags.join('');
  if (/<link\b[^>]*\brel=["']canonical["'][^>]*>/i.test(html)) {
    return html.replace(
      /(<link\b[^>]*\brel=["']canonical["'][^>]*>)/i,
      `$1${block}`,
    );
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${block}</head>`);
  }
  return `${html}${block}`;
}

const CANONICAL_WEBSITE_ID = WEBSITE_ID;
// Mintlify may emit the docs WebSite id with or without a trailing slash; both
// must retarget onto the canonical node or the page keeps a second WebSite.
const DOCS_WEBSITE_IDS = new Set([
  `${DOCS_PUBLIC_ORIGIN}/docs#website`,
  `${DOCS_PUBLIC_ORIGIN}/docs/#website`,
]);
const JSON_LD_SCRIPT_RE =
  /<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;

/** `@type` may be a string or an array of strings in valid JSON-LD. */
function hasJsonLdType(node: Record<string, unknown>, type: string): boolean {
  const declared = node['@type'];
  if (Array.isArray(declared)) return declared.includes(type);
  return declared === type;
}

/**
 * Vendor attribution reaches us as `creator` today, but Mintlify is free to move
 * it to `publisher`/`provider`. Read all three rather than pinning the one shape
 * the current fixture happens to use.
 */
function isMintlifyAgent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const agent = value as Record<string, unknown>;
  const name = typeof agent.name === 'string' ? agent.name.toLowerCase() : '';
  const url = typeof agent.url === 'string' ? agent.url.toLowerCase() : '';
  return name.includes('mintlify') || url.includes('mintlify.com');
}

function isWebSiteNode(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  return hasJsonLdType(node as Record<string, unknown>, 'WebSite');
}

/**
 * A docs page must not declare any WebSite other than the canonical one. Keying
 * the drop on "not canonical" rather than on Mintlify-specific attribution text
 * means a vendor rename, a move to `publisher`, or an unattributed duplicate all
 * still get removed instead of silently surviving (#7459d).
 */
function isCompetingWebSite(node: unknown): boolean {
  if (!isWebSiteNode(node)) return false;
  if (node['@id'] === CANONICAL_WEBSITE_ID) return false;
  return true;
}

function isVendorAttributedWebSite(node: unknown): boolean {
  if (!isWebSiteNode(node)) return false;
  return isMintlifyAgent(node.creator)
    || isMintlifyAgent(node.publisher)
    || isMintlifyAgent(node.provider);
}

function shouldDropWebSite(node: unknown): boolean {
  return isCompetingWebSite(node) || isVendorAttributedWebSite(node);
}

function rewriteDocsWebsiteIds(value: unknown): unknown {
  if (typeof value === 'string') {
    return DOCS_WEBSITE_IDS.has(value) ? CANONICAL_WEBSITE_ID : value;
  }
  if (Array.isArray(value)) return value.map(rewriteDocsWebsiteIds);
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      next[key] = rewriteDocsWebsiteIds(nested);
    }
    return next;
  }
  return value;
}

function collapseCanonicalWebSite(node: Record<string, unknown>): Record<string, unknown> {
  if (hasJsonLdType(node, 'WebSite') && node['@id'] === CANONICAL_WEBSITE_ID) {
    return { '@type': 'WebSite', '@id': CANONICAL_WEBSITE_ID };
  }
  return node;
}

/**
 * Walk every node at every depth — a WebSite can sit at the top level, inside a
 * top-level array, under `@graph`, or nested beneath any property such as
 * `mainEntity`. Returns null when the value itself must be removed.
 */
function pruneWebSites(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    // pruneWebSites returns null for a droppable entry, so mapping then
    // discarding nulls removes and recurses in one pass.
    return value
      .map((entry) => pruneWebSites(entry))
      .filter((entry) => entry !== null);
  }
  if (!value || typeof value !== 'object') return value;
  if (shouldDropWebSite(value)) return null;

  const node = collapseCanonicalWebSite(value as Record<string, unknown>);
  // A collapsed canonical reference is terminal — do not recurse into the
  // two keys it was reduced to.
  if (node !== value) return node;

  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(node)) {
    const pruned = pruneWebSites(nested);
    if (pruned === null) continue;
    next[key] = pruned;
  }
  return next;
}

function rewriteDocsJsonLdValue(value: unknown, pathname?: string): unknown | null {
  const pruned = pruneWebSites(rewriteDocsWebsiteIds(value));
  if (pruned === null) return null;
  return withDocsArticleNode(withDocsArticleAuthor(withDocsSpeakable(pruned)), pathname);
}

function collectJsonLdNodes(value: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLdNodes(entry, into);
  } else if (value && typeof value === 'object') {
    into.push(value as Record<string, unknown>);
    for (const nested of Object.values(value)) collectJsonLdNodes(nested, into);
  }
  return into;
}

function docsSlugForPathname(pathname: string | undefined): string | null {
  if (!pathname) return null;
  const pair = resolveDocsLocalePair(pathname);
  if (!pair) return null;
  const active = pair.active === 'zh' ? pair.zhPath : pair.enPath;
  const slug = active.replace(/^\/docs\//, '').replace(/\/$/, '');
  return slug.length > 0 ? slug : null;
}

/**
 * Inject a full Article node when upstream ships a bare WebPage. Every field
 * is derived, never invented: headline/description/url from the page node,
 * dateModified from the build-time manifest for this slug, publisher/author
 * from the canonical Organization. Missing page name or missing manifest date
 * means no injection — a dateless or nameless Article is worse than none.
 */
function withDocsArticleNode(value: unknown, pathname?: string): unknown {
  const nodes = collectJsonLdNodes(value);
  if (nodes.some((node) => hasJsonLdType(node, 'Article') || hasJsonLdType(node, 'TechArticle'))) {
    return value;
  }
  const page = nodes.find((node) => hasJsonLdType(node, 'WebPage'));
  if (!page || typeof page.name !== 'string' || page.name.trim().length === 0) return value;
  const slug = docsSlugForPathname(pathname);
  const dateModified = slug ? DOCS_PAGE_DATES[slug] : undefined;
  if (!dateModified) return value;
  const pageUrl = typeof page.url === 'string' && page.url.length > 0
    ? page.url
    : `${DOCS_PUBLIC_ORIGIN}${pathname ?? '/docs/'}`;
  const article: Record<string, unknown> = {
    '@type': ['Article', 'TechArticle'],
    '@id': `${pageUrl}#article`,
    headline: page.name,
    dateModified,
    publisher: { '@id': ORGANIZATION_ID },
    author: { '@id': ORGANIZATION_ID },
  };
  if (typeof page.description === 'string' && page.description.trim().length > 0) {
    article.description = page.description;
  }
  if (Array.isArray(value)) return [...value, article];
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['@graph'])) {
    const host = value as Record<string, unknown>;
    return { ...host, '@graph': [...(host['@graph'] as unknown[]), article] };
  }
  if (value && typeof value === 'object') {
    const host = value as Record<string, unknown>;
    return {
      '@context': host['@context'] ?? 'https://schema.org',
      '@graph': [host, article],
    };
  }
  return value;
}

const DEFAULT_DOCS_SPEAKABLE = Object.freeze({
  '@type': 'SpeakableSpecification',
  cssSelector: ['h1'],
});

function withDocsSpeakable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDocsSpeakable);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(node)) {
    next[key] = withDocsSpeakable(nested);
  }
  if (hasJsonLdType(next, 'WebPage') && next.speakable == null) {
    next.speakable = DEFAULT_DOCS_SPEAKABLE;
  }
  return next;
}

/**
 * Live upstream emits the docs page node as a bare WebPage with no Article
 * (verified against production), so the docs — the site's deepest expertise
 * asset — were rich-result ineligible. Inject the Article from the page node
 * plus the build-time date manifest when both exist; never invent either half.
 *
 * When upstream DOES emit an Article/TechArticle node, withDocsArticleAuthor
 * below still attributes it to the canonical Organization (the docs are
 * product documentation with no per-page byline, matching how the research
 * reports attribute themselves in scripts/build-research-reports.mjs).
 *
 * `datePublished` is deliberately NOT synthesised. No per-page publication date
 * exists anywhere: docs/*.mdx frontmatter carries only title and description,
 * docs.json has no dates, and a git first-commit date is a build-time lookup
 * unreachable from routing middleware. Copying `dateModified` into it would
 * assert a publication date we do not know, which is worse than omitting a
 * recommended (not required) property.
 */
function withDocsArticleAuthor(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDocsArticleAuthor);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(node)) {
    next[key] = withDocsArticleAuthor(nested);
  }
  const isArticle = hasJsonLdType(next, 'Article') || hasJsonLdType(next, 'TechArticle');
  if (isArticle && next.author == null) {
    next.author = { '@id': ORGANIZATION_ID };
  }
  return next;
}

/**
 * Drop competing / vendor-attributed WebSite nodes and retarget `/docs#website`
 * onto the canonical `/#website` so docs pages join the product graph
 * instead of claiming a competing site (#7459d).
 *
 * `pathname` is used only to attribute a parse failure in logs; the rewrite is
 * pathname-independent.
 */
export function rewriteDocsEntityGraph(html: string, pathname?: string): string {
  return html.replace(JSON_LD_SCRIPT_RE, (script, body: string) => {
    try {
      const next = rewriteDocsJsonLdValue(JSON.parse(body), pathname);
      if (next === null) return '';
      // Escape `<` so a `</script>` inside any string value cannot close the
      // element early. JSON.parse turns Mintlify's escaped `<\/script>` back
      // into a literal, and JSON.stringify would re-emit it raw. Mirrors
      // escapeJsonScript in scripts/build-crawlable-corpus.mjs.
      const serialized = JSON.stringify(next).replace(/</g, '\\u003c');
      return `<script type="application/ld+json">${serialized}</script>`;
    } catch (err) {
      // Fail open so a shape we cannot parse still reaches the reader, but say
      // so: without this the vendor WebSite silently ships behind a 200 and the
      // response headers look identical to a successful rewrite.
      console.error('[docs-locale-seo] JSON-LD rewrite failed; shipping upstream block', {
        pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return script;
    }
  });
}

/**
 * Rewrite a Mintlify HTML document so Chinese pages declare zh-Hans and both
 * locale sides carry a reciprocal hreflang cluster. Also folds the docs
 * JSON-LD graph onto the canonical WebSite (#7459d).
 */
export function rewriteDocsLocaleHtml(html: string, pathname: string): string {
  const pair = resolveDocsLocalePair(pathname);
  if (!pair) return html;

  let next = stripExistingDocsHreflang(html);
  if (pair.active === 'zh') {
    next = replaceHtmlLang(next, DOCS_ZH_HREFLANG);
    next = replaceOgLocale(next, 'zh_CN');
  } else {
    next = replaceHtmlLang(next, DOCS_EN_HREFLANG);
    next = replaceOgLocale(next, 'en_US');
  }
  next = injectAfterCanonical(next, buildDocsHreflangLinkTags(pathname));
  return rewriteDocsEntityGraph(next, pathname);
}

export function shouldTransformDocsUpstreamHtml(
  pathname: string,
  contentType: string | null,
): boolean {
  if (!resolveDocsLocalePair(pathname)) return false;
  if (!contentType) return false;
  return contentType.toLowerCase().includes('text/html');
}
