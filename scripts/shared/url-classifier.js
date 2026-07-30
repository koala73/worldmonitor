// Pure URL classifier for static institutional pages on .gov / .mil / .int
// domains. Used by:
//   - U7: brief-filter denylist guard (last-line defense before a story
//     reaches a user-facing brief).
//   - U6: scripts/audit-static-page-contamination.mjs (one-shot Redis
//     scanner that evicts story:track:v1 entries from sources that
//     pre-date the U1+U2+U3 ingest gates).
//
// Conservative by design: must match BOTH a .gov/.mil/.int host AND a
// curated path prefix. Single-condition matches (e.g., any .gov URL or
// any /About/ path) would over-trigger.
//
// See R7 in docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md.

/**
 * Hosts whose static institutional pages we treat as the contamination
 * class. Match is case-insensitive and supports the bare domain plus any
 * subdomain.
 */
const INSTITUTIONAL_HOST_SUFFIXES = ['.gov', '.mil', '.int'];

/**
 * Path patterns that identify a static landing/policy/strategy page
 * rather than a dated news article. Two pattern families:
 *
 *   - Segment buckets (entries ending with `/`): match the bare segment
 *     OR the segment as a path prefix. `/About/` matches `/about` AND
 *     `/about/section-508` but NOT `/aboutface` (segment boundary
 *     enforced). Using plain `startsWith('/about/')` would have missed
 *     the bare `/about` form on canonical landing pages — that's the
 *     P2 finding from PR #3419 review.
 *
 *   - Wildcard prefixes (entries NOT ending with `/`): match any path
 *     starting with the literal prefix. `/Section-` intentionally
 *     matches `/section-508`, `/section-504`, etc., where the value
 *     after the dash is part of the bucket name, not a sub-segment.
 *
 * Curated from the known Pentagon contamination cases that motivated
 * the plan (About/Section-508, Acquisition-Transformation-Strategy,
 * 5G Ecosystem report) plus extrapolated patterns common across .gov
 * sites. Post-deploy U6 audit will confirm coverage and inform any
 * widening in a follow-up PR.
 */
const STATIC_PATH_PREFIXES = [
  '/About/',
  '/Section-',
  '/Acquisition-Transformation-Strategy',
  '/Strategy/',
  '/Strategies/',
  '/Policy/',
  '/Policies/',
  '/Resources/',
  '/Programs/',
];

/**
 * Returns true when `path` (already lowercased) matches `prefix` as
 * either an exact segment, a segment-prefix, or a wildcard prefix per
 * the rules above.
 *
 * @param {string} path
 * @param {string} prefix
 */
function pathMatchesPrefix(path, prefix) {
  const lower = prefix.toLowerCase();
  if (lower.endsWith('/')) {
    // Segment-bucket rule: drop the trailing slash, match exactly OR
    // require an explicit segment boundary. `/aboutface` !== `/about`
    // and !startsWith(`/about/`), so over-match is avoided.
    const stem = lower.slice(0, -1);
    return path === stem || path.startsWith(`${stem}/`);
  }
  // Wildcard-prefix rule: literal startsWith. `/Section-` matches
  // `/section-508` because the dash is part of the bucket name.
  return path.startsWith(lower);
}

/**
 * Returns true if the URL is a static institutional landing page that
 * should never be treated as news. Returns false for malformed URLs,
 * non-institutional hosts, and institutional URLs whose path matches
 * the news-article pattern (e.g., /News/Releases/...).
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isInstitutionalStaticPage(url) {
  if (typeof url !== 'string' || url.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.toLowerCase();
  const hostMatch = INSTITUTIONAL_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
  if (!hostMatch) return false;

  // Lowercase pathname so 'defense.gov/ABOUT/...' (rare but observed in
  // some redirect chains) classifies the same as the canonical case.
  const path = parsed.pathname.toLowerCase();
  return STATIC_PATH_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix));
}
