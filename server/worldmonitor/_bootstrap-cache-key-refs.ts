/**
 * Keep canonical references for bootstrap-adjacent Redis keys in one place.
 * Seed-only payloads are candidates for the public bootstrap registry; runtime
 * caches can stay off the public bootstrap payload and still share a single
 * reference point for health wiring and regression tests.
 */
export const SEED_ONLY_BOOTSTRAP_CACHE_KEYS = {
  techReadiness: 'economic:worldbank-techreadiness:v1',
  progressData: 'economic:worldbank-progress:v1',
  renewableEnergy: 'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  weatherAlerts: 'weather:alerts:v1',
  climateNews: 'climate:news-intelligence:v1',
  spending: 'economic:spending:v1',
  techEvents: 'research:tech-events-bootstrap:v1',
  gdeltIntel: 'intelligence:gdelt-intel:v1',
  correlationCards: 'correlation:cards-bootstrap:v1',
  groceryBasket: 'economic:grocery-basket:v1',
  bigmac: 'economic:bigmac:v1',
} as const;

/**
 * Resilience caches are intentionally kept out of the public bootstrap
 * response. Score and ranking data are produced on-demand by Pro-gated RPCs,
 * so health/tests should reference these keys without exposing them through
 * api/bootstrap.js.
 */
export const RESILIENCE_BOOTSTRAP_CACHE_KEY_REFS = {
  resilienceScoreUs: 'resilience:score:US',
  resilienceRanking: 'resilience:ranking',
} as const;
