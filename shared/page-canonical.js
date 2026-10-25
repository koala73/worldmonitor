/**
 * One canonical rule for a page and its Markdown twin.
 *
 * The HTML page is the authority: whatever its own <link rel="canonical">
 * says is what every alternate representation (the /x.md twin, its Link
 * header, its front-matter) must repeat. Guessing from the request path is
 * what let twins drift: static directory pages (/blog/..., /sources/...)
 * answer 200 at both /x and /x/, so the path a twin happened to fetch said
 * nothing about which of the two the page declares.
 *
 * Plain JS so the edge handler, scripts and node:test suites import it
 * directly.
 */

const LINK_TAG = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const LINK_ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const FIRST_PARTY_HOST = /(^|\.)worldmonitor\.app$/i;

/** The href of the first <link rel="canonical"> in an HTML document, or null. */
export function declaredHtmlCanonical(html) {
  if (typeof html !== 'string') return null;
  const head = html.slice(0, 200_000);
  for (const [tag] of head.matchAll(LINK_TAG)) {
    const attributes = new Map();
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of tag.matchAll(LINK_ATTRIBUTE)) {
      const key = name.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, doubleQuoted ?? singleQuoted ?? unquoted ?? '');
    }
    const rel = attributes.get('rel') ?? '';
    if (rel.toLowerCase().split(/[\t\n\f\r ]+/).includes('canonical')) {
      return attributes.get('href')?.trim() || null;
    }
  }
  return null;
}

/**
 * The canonical URL for the page served at `pageUrl`.
 *
 * `declaredHref` is the page's own declared canonical. It is honoured when it
 * resolves to a first-party http(s) URL; otherwise (no tag, off-site, junk)
 * the page's own query-less URL is used. The result is always query-less and
 * fragment-less, preserving the accepted declaration's origin.
 */
export function pageCanonicalUrl(pageUrl, declaredHref = null) {
  const page = new URL(pageUrl);
  if (declaredHref) {
    try {
      const declared = new URL(declaredHref, page);
      if ((declared.protocol === 'https:' || declared.protocol === 'http:') && FIRST_PARTY_HOST.test(declared.hostname)) {
        return `${declared.origin}${declared.pathname}`;
      }
    } catch {
      // fall through to the page's own URL
    }
  }
  return `${page.origin}${page.pathname}`;
}
