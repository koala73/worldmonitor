// Frozen articles need publisher URLs, not opaque, expiring aggregator redirects.
export const AGGREGATOR_LINK_HOSTS = new Set(['news.google.com']);

// Parsed with try/catch rather than `URL.parse`, which needs Safari 17.4 and
// Chrome 126. This module is bundled into the browser (pro-test/src/services/
// teasers.ts) as well as Node seeders and Edge handlers, and Vite's default
// target is Safari 16, so a static `URL.parse` call would build cleanly and
// then throw TypeError in a supported browser. Keep this file inside that
// baseline.
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True for an HTTPS article URL outside the known aggregator redirect hosts. */
export function isVerifiableArticleUrl(url) {
  const value = String(url || '').trim();
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  return hostname.length > 0 && !AGGREGATOR_LINK_HOSTS.has(hostname);
}
