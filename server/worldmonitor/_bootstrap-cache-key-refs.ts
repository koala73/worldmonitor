/**
 * Bootstrap can serve seed-only Redis payloads that do not yet have dedicated
 * RPC handlers under server/worldmonitor. Keep the canonical keys here so the
 * bootstrap registry, health checks, and tests stay aligned.
 */
export const SEED_ONLY_BOOTSTRAP_CACHE_KEYS = {
  techReadiness: 'economic:worldbank-techreadiness:v1',
  progressData: 'economic:worldbank-progress:v1',
  renewableEnergy: 'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  weatherAlerts: 'weather:alerts:v1',
  spending: 'economic:spending:v1',
  techEvents: 'research:tech-events-bootstrap:v1',
  gdeltIntel: 'intelligence:gdelt-intel:v1',
  correlationCards: 'correlation:cards-bootstrap:v1',
  groceryBasket: 'economic:grocery-basket:v1',
  bigmac: 'economic:bigmac:v1',
} as const;
