// Shared cache-policy predicate for endpoints whose response body varies per
// request (see api/geo.js). Lives here rather than inline in each test because
// two copies of a security predicate drift: widen one, forget the other, and the
// guard that was not widened silently starts clearing values the other rejects.
//
// A per-request body must never be STORABLE by a shared cache, and exactly two
// directives promise that: an unqualified `no-store` or an unqualified `private`.
// Everything else leaves the response shared-storable under RFC 9111 -- `public`,
// any positive `max-age` (explicit freshness is sufficient on its own; `public`
// is only needed to make otherwise-uncacheable responses cacheable), a bare
// `no-cache` (which permits storage and reuse after revalidation), an `s-maxage=0`
// paired with `stale-while-revalidate`, or no directive at all.
//
// Enumerating the DANGEROUS values is what makes such a guard rot: the first value
// nobody thought of sails through. So this inverts it and enumerates the two safe
// ones. Deliberately over-inclusive -- a false alarm costs a moment's thought, a
// false clear costs a repeat of the bug.

/** `no-store` takes no argument, so a bare token match is exact. */
const UNQUALIFIED_NO_STORE = /(^|[\s,])no-store\s*([,;]|$)/;
/**
 * `private` must be unqualified: RFC 9111's `private="Set-Cookie"` form excludes
 * only the named field and leaves the rest shared-storable.
 */
const UNQUALIFIED_PRIVATE = /(^|[\s,])private\s*([,;]|$)/;

/**
 * True when a shared cache may store and replay this response.
 *
 * @param {string | null | undefined} cacheControl A Cache-Control (or CDN-Cache-Control) value.
 * @returns {boolean}
 */
export function isSharedCacheable(cacheControl) {
  if (!cacheControl) return true; // no directive at all -> shared caches may heuristically store
  const value = String(cacheControl).toLowerCase();
  return !UNQUALIFIED_NO_STORE.test(value) && !UNQUALIFIED_PRIVATE.test(value);
}

/**
 * Every header that can set a shared-cache policy. Vercel reads
 * Vercel-CDN-Cache-Control > CDN-Cache-Control > Cache-Control; Cloudflare reads
 * Cloudflare-CDN-Cache-Control > CDN-Cache-Control > Cache-Control. A CDN-specific
 * header silently outranks a handler's `Cache-Control: no-store`.
 */
export const CDN_CACHE_HEADERS = [
  'CDN-Cache-Control',
  'Vercel-CDN-Cache-Control',
  'Cloudflare-CDN-Cache-Control',
  'Surrogate-Control',
];

/** Matches any header name that carries a shared-cache policy. */
export const CACHE_POLICY_HEADER_NAME =
  /^(cache-control|cdn-cache-control|vercel-cdn-cache-control|cloudflare-cdn-cache-control|surrogate-control)$/i;
