/**
 * Browser-like headers for upstream RSS fetches on the rss() / rssProxyUrl path.
 *
 * Why this lives here, not in feeds.ts: catalog entries must stay publisher
 * URLs. The User-Agent belongs on the proxy so every feed inherits it.
 * Do not bind a patched fetch globally — set the UA on the proxy fetch.
 *
 * CHROME_UA is the seeder convention (`scripts/_seed-utils.mjs`). Keep this
 * string identical so seed validation, the Edge proxy, and the Vite dev
 * plugin agree. Publishers such as CBC 403 Node/undici default UAs (and
 * some datacenter IPs) unless the request looks like a browser.
 *
 * Some hosts also need a same-origin Referer. Add that as a per-host
 * override in `rssFetchHeadersForHost`, not as a global header.
 *
 * Alerting: `scripts/_feed-health.mjs` `sustainedFailures` (same consecutive
 * DEAD/EMPTY streak as silent-zeros). Two CBC failures escalate
 * `seed-meta:news:feed-health` to status=error; a single blip does not.
 * Do not invent a separate MCP freshness key.
 */

export const RSS_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export const RSS_ACCEPT = 'application/rss+xml, application/xml, text/xml, */*';

export const RSS_DIRECT_FETCH_HEADERS = Object.freeze({
  'User-Agent': RSS_BROWSER_UA,
  Accept: RSS_ACCEPT,
  'Accept-Language': 'en-US,en;q=0.9',
});

/**
 * Headers for a direct upstream fetch of `hostname`.
 *
 * CURRENTLY HOST-INDEPENDENT: every host gets RSS_DIRECT_FETCH_HEADERS. The
 * parameter is the seam, not a feature — nothing branches on it yet, so do not
 * read a call site as evidence that a publisher has bespoke headers.
 *
 * Per-host overrides (a same-origin Referer is the usual one) belong here when
 * a publisher is OBSERVED to need them. Add the observation with the override:
 * this file's whole reason to exist is that a UA was changed for CBC without a
 * reproduced 403 to justify it.
 */
export function rssFetchHeadersForHost(_hostname) {
  return RSS_DIRECT_FETCH_HEADERS;
}
