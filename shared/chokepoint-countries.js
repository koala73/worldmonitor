/**
 * Which countries each chokepoint tracker page lists as related.
 *
 * Editorial and already public: `scripts/chokepoint-page-content.mjs` reads it
 * for the /chokepoints/* and /countries/* cross-links. It lives in `shared/`
 * so the edge country intel brief can cite the same relation without bundling
 * the page copy. Keyed by canonical chokepoint id
 * (server/_shared/chokepoint-registry.ts).
 */
export const CHOKEPOINT_COUNTRY_CODES = Object.freeze({
  suez: Object.freeze(['EG']),
  malacca_strait: Object.freeze(['MY', 'ID', 'SG']),
  hormuz_strait: Object.freeze(['IR', 'OM', 'BH', 'KW', 'QA', 'SA', 'AE']),
  bab_el_mandeb: Object.freeze(['YE', 'DJ', 'ER']),
  panama: Object.freeze(['PA']),
  taiwan_strait: Object.freeze(['TW', 'CN']),
  cape_of_good_hope: Object.freeze(['ZA']),
  gibraltar: Object.freeze(['ES', 'MA']),
  bosphorus: Object.freeze(['TR']),
  korea_strait: Object.freeze(['KR', 'JP']),
  dover_strait: Object.freeze(['GB', 'FR']),
  kerch_strait: Object.freeze(['UA', 'RU']),
  lombok_strait: Object.freeze(['ID']),
});
