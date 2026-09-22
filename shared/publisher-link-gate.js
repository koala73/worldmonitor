/**
 * Publisher-link gate for RSS story links (#8398).
 *
 * An attacker-controlled RSS item reaches every subscribed user's
 * notifications with no account and no authentication: the platform ingests
 * the item's link verbatim (list-feed-digest `buildStoryTrackHsetFields` into
 * `story:track`), a Railway cron scans it every 30 minutes, and the relay
 * fans matching items out to every user's watchlist rule. Validating fields
 * at `/api/notify` does not cover this path (relay-emitted events never pass
 * through that endpoint), so the gate lives at ingest and at each
 * relay-emission site instead.
 *
 * Policy: a story link must resolve to the publisher the feed item claims.
 * In practice that means the link's registrable host must equal the claimed
 * publisher's own host (same apex, `www.`-tolerant) or a subdomain of it —
 * e.g. `amp.theguardian.com` for `theguardian.com`, `feeds.*`/CDN delivery
 * hosts excluded at the feed-URL level. Anything else — a link that leaves
 * its own publisher's domain — is the suspicious case and is rejected.
 *
 * Reached by five runtimes, so this module is dependency-free on purpose:
 * the Vercel Edge digest handler (via `server/.../_publisher-link-gate.ts`),
 * the Railway relay (`scripts/ais-relay.cjs`, CJS require), the
 * digest-notifications cron (`scripts/seed-digest-notifications.mjs` +
 * `scripts/lib/`, ESM import), the Vite browser bundle, and plain
 * `node --test`. No JSON imports (`with { type: 'json' }` breaks the Vercel
 * bundle; bare JSON imports throw ERR_IMPORT_ATTRIBUTE_MISSING under
 * Node 22+ — see shared/publisher-families.js:40-50). The approved
 * publisher-domain registry is derived at call time from the server feed
 * config + the curated family table, both passed in by the caller.
 */

/**
 * Normalize a hostname for comparison: lowercase, trailing dots trimmed,
 * leading `www.` stripped (the feed registry mixes apex and www. forms
 * historically — see api/_rss-allowed-domain-match.js).
 *
 * @param {unknown} hostname
 * @returns {string} '' when not a usable hostname
 */
export function normalizeLinkHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  const cleaned = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (cleaned.length === 0 || !cleaned.includes('.')) return '';
  return cleaned.replace(/^www\./, '');
}

/**
 * Extract the normalized registrable host of an article link.
 * Only `http:`/`https:` links are eligible — `javascript:`, `data:`, and
 * relative links are rejected at parse (`''`), matching the strip already
 * applied in `parseRssXml` (list-feed-digest.ts).
 *
 * @param {unknown} link
 * @returns {string} '' when the link is absent, relative, or non-HTTP(S)
 */
export function linkHostname(link) {
  if (typeof link !== 'string') return '';
  const value = link.trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    return normalizeLinkHostname(new URL(value).hostname);
  } catch {
    return '';
  }
}

/**
 * True when a story link belongs to its claimed publisher.
 *
 * The expected set is the publisher's own host plus its subdomains (an
 * `amp.`/`edition.`/CDN split across subdomains still names the same
 * newsroom): the link host must equal an expected host or end with
 * `.<expected>`. A bare registrable-domain suffix match is NOT enough —
 * `evilbbc.co.uk` must not pass for `bbc.co.uk`.
 *
 * @param {unknown} link the story's article URL
 * @param {Iterable<string> | null | undefined} expectedHosts registrable
 *   hosts of the claimed publisher (feed-URL host, curated family domains,
 *   or both — caller composes; empty/absent fails closed)
 * @returns {boolean}
 */
export function isPublisherLink(link, expectedHosts) {
  const host = linkHostname(link);
  if (!host) return false;
  if (expectedHosts == null || typeof expectedHosts[Symbol.iterator] !== 'function') return false;
  for (const raw of expectedHosts) {
    const expected = normalizeLinkHostname(raw);
    if (!expected) continue;
    if (host === expected || host.endsWith(`.${expected}`)) return true;
  }
  return false;
}

/**
 * Resolve the registrable host of a feed URL (the publisher's own domain
 * as configured in the server feed registry).
 *
 * @param {unknown} feedUrl
 * @returns {string} '' when unparseable
 */
export function feedPublisherHost(feedUrl) {
  if (typeof feedUrl !== 'string') return '';
  try {
    return normalizeLinkHostname(new URL(feedUrl.trim()).hostname);
  } catch {
    return '';
  }
}
