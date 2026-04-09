// ── Story persistence tracking keys (E3) ─────────────────────────────────────
// Hash: firstSeen, lastSeen, mentionCount, sourceCount, currentScore, peakScore, title, link, severity, lang
export const STORY_TRACK_KEY_PREFIX = 'story:track:v1:';
// Set: unique feed names that have mentioned this story
export const STORY_SOURCES_KEY_PREFIX = 'story:sources:v1:';
// Sorted set: single member "peak" with score = highest importanceScore seen
export const STORY_PEAK_KEY_PREFIX = 'story:peak:v1:';
// Sorted set: accumulator for digest mode notifications (score = pubDate epoch ms)
export const DIGEST_ACCUMULATOR_KEY_PREFIX = 'digest:accumulator:v1:';
// TTL for all story tracking keys (48 hours)
export const STORY_TRACKING_TTL_S = 172800;

/**
 * Story tracking keys — written by list-feed-digest.ts, read by digest cron (E2).
 * All keys use 32-char SHA-256 hex prefix of the normalised title as ${titleHash}.
 *
 *   story:track:v1:${titleHash}     Hash   firstSeen/lastSeen/title/link/severity/mentionCount/currentScore/lang
 *   story:sources:v1:${titleHash}   Set    feed IDs (SADD per appearance)
 *   story:peak:v1:${titleHash}      ZSet   single member "peak", score = highest importanceScore (ZADD GT)
 *   digest:accumulator:v1:${variant}:${lang} ZSet  member=titleHash, score=lastSeen_ms (updated every appearance)
 *
 * TTL for all: 172800s (48h), refreshed each digest cycle.
 * Shadow scoring key (written by notification-relay.cjs):
 *   shadow:score-log:v1            ZSet   score=epoch_ms, member=JSON{importanceScore,severity,title,wouldNotify}
 */
export const STORY_TRACK_KEY = (titleHash: string) => `story:track:v1:${titleHash}`;
export const STORY_SOURCES_KEY = (titleHash: string) => `story:sources:v1:${titleHash}`;
export const STORY_PEAK_KEY = (titleHash: string) => `story:peak:v1:${titleHash}`;
export const DIGEST_ACCUMULATOR_KEY = (variant: string, lang = 'en') => `digest:accumulator:v1:${variant}:${lang}`;
export const DIGEST_LAST_SENT_KEY = (userId: string, variant: string) => `digest:last-sent:v1:${userId}:${variant}`;
export const SHADOW_SCORE_LOG_KEY = 'shadow:score-log:v1';
export const STORY_TTL = 604800;           // 7 days — enough for sustained multi-day stories
export const DIGEST_ACCUMULATOR_TTL = 172800; // 48h — lookback window for digest content

/**
 * Shared Redis pointer keys for simulation artifacts.
 * Defined here so TypeScript handlers and seed scripts agree on the exact string.
 * The MJS seed script keeps its own copy (cannot import TS source directly).
 */
export const SIMULATION_OUTCOME_LATEST_KEY = 'forecast:simulation-outcome:latest';
export const SIMULATION_PACKAGE_LATEST_KEY = 'forecast:simulation-package:latest';
export const REGULATORY_ACTIONS_KEY = 'regulatory:actions:v1';
export const CLIMATE_ANOMALIES_KEY = 'climate:anomalies:v2';
export const CLIMATE_AIR_QUALITY_KEY = 'climate:air-quality:v1';
export const CLIMATE_ZONE_NORMALS_KEY = 'climate:zone-normals:v1';
export const CLIMATE_CO2_MONITORING_KEY = 'climate:co2-monitoring:v1';
export const CLIMATE_OCEAN_ICE_KEY = 'climate:ocean-ice:v1';
export const CLIMATE_NEWS_KEY = 'climate:news-intelligence:v1';
export const HEALTH_AIR_QUALITY_KEY = 'health:air-quality:v1';

export const ENERGY_MIX_KEY_PREFIX = 'energy:mix:v1:';
export const ENERGY_EXPOSURE_INDEX_KEY = 'energy:exposure:v1:index';
export const GAS_STORAGE_KEY_PREFIX = 'energy:gas-storage:v1:';
export const GAS_STORAGE_COUNTRIES_KEY = 'energy:gas-storage:v1:_countries';
export const ELECTRICITY_KEY_PREFIX = 'energy:electricity:v1:';
export const ELECTRICITY_INDEX_KEY = 'energy:electricity:v1:index';
export const ENERGY_INTELLIGENCE_KEY = 'energy:intelligence:v1:feed';
export const CHOKEPOINT_FLOWS_KEY = 'energy:chokepoint-flows:v1';
export const ENERGY_SPINE_KEY_PREFIX = 'energy:spine:v1:';
export const ENERGY_SPINE_COUNTRIES_KEY = 'energy:spine:v1:_countries';
export const EMBER_ELECTRICITY_KEY_PREFIX = 'energy:ember:v1:';
export const EMBER_ELECTRICITY_ALL_KEY = 'energy:ember:v1:_all';
export const SPR_KEY = 'economic:spr:v1';
export const REFINERY_UTIL_KEY = 'economic:refinery-util:v1';

/**
 * Static cache keys for the bootstrap endpoint.
 * Only keys with NO request-varying suffixes are included.
 */
export const BOOTSTRAP_CACHE_KEYS: Record<string, string> = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  ddosAttacks:      'cf:radar:ddos:v1',
  trafficAnomalies: 'cf:radar:traffic-anomalies:v1',
  sectors:          'market:sectors:v1',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  imfMacro:         'economic:imf:macro:v2',
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v4',
  minerals:         'supply_chain:minerals:v2',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v2',
  climateDisasters: 'climate:disasters:v1',
  co2Monitoring:    'climate:co2-monitoring:v1',
  oceanIce:         'climate:ocean-ice:v1',
  climateNews:      'climate:news-intelligence:v1',
  radiationWatch:  'radiation:observations:v1',
  thermalEscalation: 'thermal:escalation:v1',
  crossSourceSignals: 'intelligence:cross-source-signals:v1',
  wildfires:        'wildfire:fires:v1',
  marketQuotes:     'market:stocks-bootstrap:v1',
  commodityQuotes:  'market:commodities-bootstrap:v1',
  cyberThreats:     'cyber:threats-bootstrap:v2',
  techReadiness:    'economic:worldbank-techreadiness:v1',
  progressData:     'economic:worldbank-progress:v1',
  renewableEnergy:  'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  theaterPosture:   'theater_posture:sebuf:stale:v1',
  riskScores:       'risk:scores:sebuf:stale:v1',
  naturalEvents:    'natural:events:v1',
  flightDelays:     'aviation:delays-bootstrap:v1',
  insights:         'news:insights:v1',
  predictions:      'prediction:markets-bootstrap:v1',
  cryptoQuotes:     'market:crypto:v1',
  gulfQuotes:       'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents:     'unrest:events:v1',
  iranEvents:       'conflict:iran-events:v1',
  ucdpEvents:       'conflict:ucdp-events:v1',
  temporalAnomalies: 'temporal:anomalies:v1',
  weatherAlerts:    'weather:alerts:v1',
  spending:         'economic:spending:v1',
  techEvents:       'research:tech-events-bootstrap:v1',
  gdeltIntel:       'intelligence:gdelt-intel:v1',
  correlationCards: 'correlation:cards-bootstrap:v1',
  securityAdvisories: 'intelligence:advisories-bootstrap:v1',
  forecasts:          'forecast:predictions:v2',
  customsRevenue:     'trade:customs-revenue:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  groceryBasket:     'economic:grocery-basket:v1',
  bigmac:            'economic:bigmac:v1',
  fuelPrices:        'economic:fuel-prices:v1',
  cryptoSectors:    'market:crypto-sectors:v1',
  defiTokens:       'market:defi-tokens:v1',
  aiTokens:         'market:ai-tokens:v1',
  otherTokens:      'market:other-tokens:v1',
  nationalDebt:     'economic:national-debt:v1',
  marketImplications: 'intelligence:market-implications:v1',
  fearGreedIndex:   'market:fear-greed:v1',
  crudeInventories: 'economic:crude-inventories:v1',
  natGasStorage:    'economic:nat-gas-storage:v1',
  ecbFxRates:       'economic:ecb-fx-rates:v1',
  euGasStorage:     'economic:eu-gas-storage:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  euFsi:            'economic:fsi-eu:v1',
  shippingStress:   'supply_chain:shipping_stress:v1',
  socialVelocity:   'intelligence:social:reddit:v1',
  pizzint:          'intelligence:pizzint:seed:v1',
  diseaseOutbreaks: 'health:disease-outbreaks:v1',
  economicStress:   'economic:stress-index:v1',
  faoFoodPriceIndex: 'economic:fao-ffpi:v1',
  electricityPrices:   'energy:electricity:v1:index',
  jodiOil:             'energy:jodi-oil:v1:_countries',
  chokepointBaselines: 'energy:chokepoint-baselines:v1',
  portwatchChokepointsRef: 'portwatch:chokepoints:ref:v1',
  portwatchPortActivity: 'supply_chain:portwatch-ports:v1:_countries',
  oilStocksAnalysis:    'energy:oil-stocks-analysis:v1',
  lngVulnerability:     'energy:lng-vulnerability:v1',
};

export const PORTWATCH_PORT_ACTIVITY_KEY_PREFIX = 'supply_chain:portwatch-ports:v1:';
export const PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY = 'supply_chain:portwatch-ports:v1:_countries';

export const BOOTSTRAP_TIERS: Record<string, 'slow' | 'fast'> = {
  bisPolicy: 'slow', bisExchange: 'slow', bisCredit: 'slow', imfMacro: 'slow',
  minerals: 'slow', giving: 'slow', sectors: 'slow',
  progressData: 'slow', renewableEnergy: 'slow',
  etfFlows: 'slow', shippingRates: 'fast', wildfires: 'slow',
  climateAnomalies: 'slow', climateDisasters: 'slow', co2Monitoring: 'slow', oceanIce: 'slow', climateNews: 'slow', sanctionsPressure: 'slow', radiationWatch: 'slow', thermalEscalation: 'slow', crossSourceSignals: 'slow', cyberThreats: 'slow', techReadiness: 'slow',
  theaterPosture: 'fast', naturalEvents: 'slow',
  cryptoQuotes: 'slow', gulfQuotes: 'slow', stablecoinMarkets: 'slow',
  unrestEvents: 'slow', ucdpEvents: 'slow', techEvents: 'slow',
  earthquakes: 'fast', outages: 'fast', serviceStatuses: 'fast', ddosAttacks: 'fast', trafficAnomalies: 'fast',
  macroSignals: 'fast', chokepoints: 'fast', riskScores: 'fast',
  marketQuotes: 'fast', commodityQuotes: 'fast', positiveGeoEvents: 'fast',
  flightDelays: 'fast', insights: 'fast', predictions: 'fast',
  iranEvents: 'fast', temporalAnomalies: 'fast', weatherAlerts: 'fast',
  spending: 'fast', gdeltIntel: 'fast', correlationCards: 'fast',
  securityAdvisories: 'slow',
  forecasts: 'fast',
  customsRevenue: 'slow',
  consumerPricesOverview: 'slow', consumerPricesCategories: 'slow',
  consumerPricesMovers: 'slow', consumerPricesSpread: 'slow',
  groceryBasket: 'slow',
  bigmac: 'slow',
  fuelPrices: 'slow',
  cryptoSectors: 'slow',
  defiTokens: 'slow',
  aiTokens: 'slow',
  otherTokens: 'slow',
  nationalDebt: 'slow',
  marketImplications: 'slow',
  fearGreedIndex: 'slow',
  crudeInventories: 'slow',
  natGasStorage: 'slow',
  ecbFxRates: 'slow',
  euGasStorage: 'slow',
  eurostatCountryData: 'slow',
  euFsi: 'slow',
  shippingStress: 'fast',
  socialVelocity: 'fast',
  pizzint: 'slow',
  diseaseOutbreaks: 'slow',
  economicStress: 'slow',
  faoFoodPriceIndex: 'slow',
  electricityPrices:   'slow',
  jodiOil:             'slow',
  chokepointBaselines: 'slow',
  portwatchChokepointsRef: 'slow',
  portwatchPortActivity: 'slow',
  oilStocksAnalysis: 'slow',
  lngVulnerability: 'slow',
};

export const PORTWATCH_CHOKEPOINTS_REF_KEY = 'portwatch:chokepoints:ref:v1';
