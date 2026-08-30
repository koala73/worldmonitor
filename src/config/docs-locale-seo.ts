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

/**
 * Rewrite a Mintlify HTML document so Chinese pages declare zh-Hans and both
 * locale sides carry a reciprocal hreflang cluster.
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
  return injectAfterCanonical(next, buildDocsHreflangLinkTags(pathname));
}

export function shouldTransformDocsUpstreamHtml(
  pathname: string,
  contentType: string | null,
): boolean {
  if (!resolveDocsLocalePair(pathname)) return false;
  if (!contentType) return false;
  return contentType.toLowerCase().includes('text/html');
}
