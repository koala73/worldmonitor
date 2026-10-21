// Pure host-matching predicate over the RSS proxy allowlist. Source of truth
// for the www-normalized comparison used by:
//   - api/rss-proxy.js (Edge SSRF guard, initial host + per-redirect re-check)
//   - scripts/validate-rss-feeds.mjs --ci (build-time / scheduled feed validator)
//
// Edge constraint: api/*.js cannot import from ../shared. Helpers and data
// mirrors must live under api/ as same-directory _*.js files. The allowlist
// itself is mirrored at api/_rss-allowed-domains.js — this file imports that
// mirror so the predicate has its data in scope without bouncing through the
// edge bundler.
//
// Match rule (mirrors what api/rss-proxy.js shipped before this extraction):
//   1. exact hostname match
//   2. bare hostname (www. prefix stripped)
//   3. www-prefixed hostname
//
// Any of the three is sufficient. The bare/www tolerance matters because the
// allowlist registry mixes both forms historically (some feeds canonicalize to
// www., others to the apex). A strict exact-match check would false-reject
// legitimate registry hosts that differ only by the www. prefix.

import RSS_ALLOWED_DOMAINS from './_rss-allowed-domains.js';

// The www-tolerant candidate forms for a hostname: exact, bare (leading www.
// stripped), and www-prefixed. Any host-set membership test that must treat the
// apex and www. forms as equivalent should test all three. Shared so the RSS
// proxy's relay-only routing check matches hosts the SAME way the allowlist does
// — otherwise a host allowed via its apex form (e.g. `cisa.gov`) would miss the
// exact-match relay-only set for `www.cisa.gov` and get direct-fetched from a
// Vercel edge IP the relay routing exists specifically to avoid.
export function hostMatchForms(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return [];
  const bare = hostname.replace(/^www\./, '');
  const withWww = hostname.startsWith('www.') ? hostname : `www.${hostname}`;
  return [...new Set([hostname, bare, withWww])];
}

export function isAllowedDomain(hostname) {
  return hostMatchForms(hostname).some((form) => RSS_ALLOWED_DOMAINS.includes(form));
}

export default isAllowedDomain;
