/**
 * Chokepoint ids an alert rule may name in its `chokepoints` scope (#9217).
 * Same ids and order as CHOKEPOINT_REGISTRY in
 * server/_shared/chokepoint-registry.ts; tests/chokepoint-disruption-alerts.test.mjs
 * holds the two equal. It lives in `shared/` because convex/ cannot import
 * server/_shared.
 */
export const CHOKEPOINT_ALERT_IDS: readonly string[] = Object.freeze([
  'suez',
  'malacca_strait',
  'hormuz_strait',
  'bab_el_mandeb',
  'panama',
  'taiwan_strait',
  'cape_of_good_hope',
  'gibraltar',
  'bosphorus',
  'korea_strait',
  'dover_strait',
  'kerch_strait',
  'lombok_strait',
]);

export const CHOKEPOINT_DISRUPTION_EVENT_TYPE = 'chokepoint_disruption' as const;
