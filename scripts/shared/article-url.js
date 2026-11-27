// Frozen articles need publisher URLs, not opaque, expiring aggregator redirects.
export const AGGREGATOR_LINK_HOSTS = new Set(['news.google.com']);

/** True for an HTTPS article URL outside the known aggregator redirect hosts. */
export function isVerifiableArticleUrl(url) {
  const value = String(url || '').trim();
  const parsed = URL.parse(value);
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  return hostname.length > 0 && !AGGREGATOR_LINK_HOSTS.has(hostname);
}
