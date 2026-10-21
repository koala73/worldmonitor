export const CANADA_ALERTS_SIBLING_KEY = 'alerts:canada:alberta-aea:v1';
export const CANADA_ALERTS_LEGACY_KEY = 'alerts:alberta-aea:v1';

export const CANADA_ALERTS_CUTOVER_FALLBACK_KEYS = Object.freeze([
  CANADA_ALERTS_SIBLING_KEY,
  CANADA_ALERTS_LEGACY_KEY,
]);

/**
 * Extra Redis keys origin and the publisher must read so a missing
 * `alerts:canada:v1` can still hydrate `canadaAlerts` during the #6659 cutover.
 * Keep in lockstep with `shared/canada-alerts-cutover.js`.
 */
export function extraCanadaAlertsCutoverReadKeys(keys, primaryKey) {
  if (!primaryKey || !keys.includes(primaryKey)) return [];
  return CANADA_ALERTS_CUTOVER_FALLBACK_KEYS.filter((key) => !keys.includes(key));
}

/** Alberta sibling first, abandoned legacy key second. `lookup` is redisKey → value. */
export function canadaAlertsCutoverFallbackValue(lookup) {
  for (const key of CANADA_ALERTS_CUTOVER_FALLBACK_KEYS) {
    const fallback = lookup.get(key);
    if (fallback !== undefined) return fallback;
  }
  return undefined;
}
