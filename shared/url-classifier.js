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
 * Path-prefix patterns that identify a static landing/policy/strategy
 * page rather than a dated news article. Match is case-insensitive on
 * the URL pathname and applied as a starts-with check.
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
  return STATIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix.toLowerCase()));
}
