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

  return {
    newestItemAt,
    oldestItemAt,
    maxContentAgeMin,
    contentAgeMin,
    contentStale: contentAgeMin == null || isFutureDated || contentAgeMin > maxContentAgeMin,
  };
}
