/**
 * Country Instability Index score bands, as the public country pages label them.
 *
 * The country intel brief cites the band next to the score, so the brief and the
 * page must never disagree on it. `scripts/crawlable-live-tools.mjs` cannot
 * import this module: the corpus build copies that file verbatim to
 * `public/tools/live-tools.js`, where a `../shared/` import would 404 in the
 * browser. It keeps its own table instead, and
 * `tests/country-brief-evidence.test.mts` asserts both functions agree for
 * every score in 0.1 steps, so a band edit in one place reds until the other
 * matches.
 */
export const CII_SCORE_BANDS = Object.freeze([
  Object.freeze({ min: 81, label: 'Critical' }),
  Object.freeze({ min: 66, label: 'High' }),
  Object.freeze({ min: 51, label: 'Elevated' }),
  Object.freeze({ min: 31, label: 'Normal' }),
  Object.freeze({ min: 0, label: 'Low' }),
]);

/**
 * Band label for a 0-100 CII score, or null for anything that is not a finite
 * number in range (strings included: the page never coerces).
 * @param {unknown} score
 * @returns {string | null}
 */
export function instabilityBand(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 0 || score > 100) return null;
  return CII_SCORE_BANDS.find((band) => score >= band.min)?.label ?? null;
}
