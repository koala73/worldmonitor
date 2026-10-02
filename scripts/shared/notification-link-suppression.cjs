// Operator-controlled notification link suppression for incident response (#8401).
//
// This is the shared matcher both sides of the suppression path use:
//   - the Railway notification relay (`scripts/notification-relay.cjs` reads
//     the Redis set before delivery), and
//   - the service worker (`public/link-suppression-check.js`, consulted on
//     notification click for already-delivered push payloads).
//
// Operators add entries without a deploy (SADD on the Redis key), so an
// exact-match blocklist alone is not enough: an attacker who can publish one
// hostile URL can publish trivial variants of it. The set therefore carries
// two entry shapes, matched in this order per candidate URL:
//
//   1. exact URL — verbatim string equality against the normalized candidate.
//   2. `host:<hostname>` — blocks every URL on that host.
//
// Normalization is deliberately narrow (lowercased scheme+host, default-port
// stripping, trailing-dot trimming, `/%`-decoding of the path) so an entry
// written from a delivered payload matches the same URL when the relay or SW
// re-derives it later. Anything that does not parse as http(s) never matches:
// suppression is a revoke path for delivered article links, not a validator
// for arbitrary schemes (those are rejected at the delivery sinks instead).
//
// Both consumers are fail-open on read errors with a loud log line — a
// suppression control that cannot be read must not be assumed empty, but it
// must not blank notifications during a Redis/Convex outage either. The
// read path logs; the write path (SADD) lives in runbooks, not in code.

'use strict';

// Resolve exactly as the delivery classifier does (classifyNotificationLink in
// ./notify-fields.cjs): only a scheme-bearing or `/`-leading value is
// resolvable, and it resolves against the dashboard base. Parsing base-less
// made `//evil.example/x` and `/\\evil.example/x` unparseable here (so they
// bypassed `host:evil.example`) while the classifier resolved them to
// https://evil.example/x and every text sink delivered that.
const { NOTIFY_DASHBOARD_URL } = require('./notify-fields.cjs');

const RESOLVABLE_LINK_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

const HOST_ENTRY_PREFIX = 'host:';

/**
 * Normalize a candidate or exact-entry URL for comparison.
 * Returns null when the value is not a parseable http(s) URL.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeSuppressedUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!RESOLVABLE_LINK_PATTERN.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed, NOTIFY_DASHBOARD_URL);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  // Credentials exist only to make a hostile host read as a trusted one;
  // a suppressed entry never carries them, so drop them before comparing.
  let host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) return null;
  const isDefaultPort =
    (protocol === 'http:' && parsed.port === '80') ||
    (protocol === 'https:' && parsed.port === '443');
  if (parsed.port && !isDefaultPort) host += `:${parsed.port}`;
  let path = parsed.pathname || '/';
  try {
    path = decodeURI(path);
  } catch {
    // Malformed % sequences stay encoded — still comparable, just verbatim.
  }
  return `${protocol}//${host}${path}${parsed.search}${parsed.hash}`;
}

/**
 * Normalize a bare hostname for host-entry comparison.
 * Returns null when the value is not a plausible hostname.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeSuppressedHost(raw) {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (host.length === 0 || host.length > 253) return null;
  if (host.includes('/') || host.includes(':') || host.includes('?') || host.includes('#') || host.includes('@') || host.includes('\\')) return null;
  // An IDN entry must compare against the punycode host a URL parses to.
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname.replace(/\.+$/, '');
    } catch {
      return null;
    }
  }
  // Hostname labels, not free text: letters, digits, hyphens, dots.
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

/**
 * Split a raw suppression-set snapshot into exact-URL and host entries.
 * Unknown shapes are ignored — the set is operator-written, and one bad
 * entry must not disable the whole control.
 *
 * @param {unknown} entries raw SMEMBERS snapshot (array of strings)
 * @returns {{ urls: Set<string>, hosts: Set<string> }}
 */
function parseSuppressionEntries(entries) {
  const urls = new Set();
  const hosts = new Set();
  if (!Array.isArray(entries)) return { urls, hosts };
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.toLowerCase().startsWith(HOST_ENTRY_PREFIX)) {
      const host = normalizeSuppressedHost(trimmed.slice(HOST_ENTRY_PREFIX.length));
      if (host) hosts.add(host);
      continue;
    }
    const url = normalizeSuppressedUrl(trimmed);
    if (url) urls.add(url);
  }
  return { urls, hosts };
}

/**
 * True when the candidate notification link is suppressed by the operator set.
 * Host entries match the candidate host and any subdomain of it, so blocking
 * `host:evil.example` also covers `www.evil.example`.
 *
 * @param {unknown} candidate payload link (event.payload.link / .url)
 * @param {{ urls: Set<string>, hosts: Set<string> }} parsed parsed set snapshot
 * @returns {boolean}
 */
function isLinkSuppressed(candidate, parsed) {
  const normalized = normalizeSuppressedUrl(candidate);
  if (!normalized) return false;
  const urls = parsed && parsed.urls instanceof Set ? parsed.urls : new Set();
  if (urls.has(normalized)) return true;
  const hosts = parsed && parsed.hosts instanceof Set ? parsed.hosts : new Set();
  if (hosts.size === 0) return false;
  let candidateHost;
  try {
    candidateHost = new URL(normalized).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return false;
  }
  for (const host of hosts) {
    if (candidateHost === host || candidateHost.endsWith(`.${host}`)) return true;
  }
  return false;
}

module.exports = {
  HOST_ENTRY_PREFIX,
  normalizeSuppressedUrl,
  normalizeSuppressedHost,
  parseSuppressionEntries,
  isLinkSuppressed,
};
