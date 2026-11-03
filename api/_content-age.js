// Shared assessor for the seed-meta content-age trio
// (`newestItemAt` / `oldestItemAt` / `maxContentAgeMin`).
//
// Sibling of api/_content-freshness.js, and it exists for the same reason that
// module states: keep the rule in ONE place so health, seed-health, and MCP
// cannot silently invent different deadlines. Before this module, api/health.js
// classifyKey and api/mcp/freshness.ts evaluateFreshness each hand-implemented
// `contentAgeMin == null || isFutureDated || contentAgeMin > maxContentAgeMin`
// off the same trio — the #6080 divergence class that #7141 was itself fixing.
//
// Presence of a numeric `maxContentAgeMin` is the opt-in signal. Legacy seeders
// without it get `null` back and skip the content-age branch entirely.

// Fleet-wide pre-warning policy, owned by the reader (never the producer): a
// resource whose content age has consumed this fraction of its budget is
// flagged CONTENT_AGE_PREWARNING — visible, non-blocking lead time before the
// hard STALE_CONTENT breach. 0.8 of the 230-day JODI-Gas budget gives ~46
// days of lead time; the Sep 2026 incident would have surfaced on ~Aug 3
// instead of at the boundary.
export const CONTENT_AGE_PREWARNING_RATIO = 0.8;

/**
 * @param {unknown} meta   parsed seed-meta object (already envelope-unwrapped)
 * @param {number} now     epoch ms to age against
 * @returns {{
 *   newestItemAt: number|null,
 *   oldestItemAt: number|null,
 *   maxContentAgeMin: number,
 *   contentAgeMin: number|null,
 *   contentStale: boolean,
 * }|null} null when the key has not opted into the content-age contract.
 */
export function assessContentAge(meta, now) {
  if (meta == null || typeof meta !== 'object') return null;
  const maxContentAgeMin = meta.maxContentAgeMin;
  // Opt-in guard deliberately matches the historical health.js test
  // (`typeof === 'number'`) so enrollment does not change for any key.
  if (typeof maxContentAgeMin !== 'number') return null;

  // Observation timestamps use Number.isFinite, which is STRICTER than the
  // bare typeof health.js used before this extraction. It matters only for
  // NaN — unreachable through JSON.parse, which has no NaN token — where the
  // old health path computed NaN comparisons that all evaluate false and so
  // read an undatable key as FRESH. Failing closed is the intended contract
  // (an undatable payload is STALE_CONTENT), so the stricter test is the
  // correct rule for both surfaces.
  const newestItemAt = typeof meta.newestItemAt === 'number' && Number.isFinite(meta.newestItemAt)
    ? meta.newestItemAt
    : null;
  const oldestItemAt = typeof meta.oldestItemAt === 'number' && Number.isFinite(meta.oldestItemAt)
    ? meta.oldestItemAt
    : null;

  const contentAgeMin = newestItemAt == null ? null : Math.round((now - newestItemAt) / 60_000);
  // Future-dated newestItemAt (contentAgeMin < 0) is suspicious data, not
  // fresh data: an upstream publishing timestamps in the future is either
  // confusing forecasts with observations, mishandling timezones, or running
  // on a skewed clock. Treat as STALE so the signal surfaces — without this,
  // `contentAgeMin > maxContentAgeMin` is false for any negative number and
  // the staleness check silently passes. The negative `contentAgeMin` is
  // preserved on the wire so operators can see HOW far in the future the
  // timestamp was (-10 minutes is a clock-skew nit; -8760 is a year-from-now
  // corruption).
  const isFutureDated = contentAgeMin != null && contentAgeMin < 0;

  const contentStale = contentAgeMin == null || isFutureDated || contentAgeMin > maxContentAgeMin;

  // Pre-warning is reader policy, never producer data: fleet operations own
  // the lead time. Active from ceil(80% of budget) through the exact hard
  // budget (stale is strict >), and only when the assessment is otherwise
  // datable and within budget. breachAt is the first instant whose rounded
  // age strictly exceeds the budget — derived from the same Math.round the
  // age uses, so the projection and the hard boundary can never disagree.
  let preWarning = null;
  if (!contentStale && contentAgeMin != null && Number.isFinite(contentAgeMin)) {
    const warnAtContentAgeMin = Math.ceil(maxContentAgeMin * CONTENT_AGE_PREWARNING_RATIO);
    if (Number.isFinite(warnAtContentAgeMin) && warnAtContentAgeMin > 0
      && contentAgeMin >= warnAtContentAgeMin && contentAgeMin <= maxContentAgeMin) {
      const breachMs = newestItemAt + (maxContentAgeMin + 0.5) * 60_000;
      preWarning = {
        warnAtContentAgeMin,
        remainingContentAgeMin: maxContentAgeMin - contentAgeMin,
        breachAt: new Date(Math.round(breachMs)).toISOString(),
      };
    }
  }

  return {
    newestItemAt,
    oldestItemAt,
    maxContentAgeMin,
    contentAgeMin,
    contentStale,
    preWarning,
  };
}
