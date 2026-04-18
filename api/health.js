import { jsonResponse } from './_json-response.js';
// Seed-envelope helper. PR 1 imports it here so PR 2 can wire envelope-aware
// reads at specific call sites without further plumbing. It's a no-op on
// legacy-shape seed-meta values (they have no `_seed` wrapper and pass through
// as `.data`), so importing it is behavior-preserving.
import { unwrapEnvelope } from './_seed-envelope.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline, getRedisCredentials } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const BOOTSTRAP_KEYS = {
  earthquakes:       'seismology:earthquakes:v1',
  outages:           'infra:outages:v1',
  sectors:           'market:sectors:v2',
  etfFlows:          'market:etf-flows:v1',
  climateAnomalies:  'climate:anomalies:v2',
  climateDisasters:  'climate:disasters:v1',
  climateAirQuality: 'climate:air-quality:v1',
  co2Monitoring:     'climate:co2-monitoring:v1',
  oceanIce:          'climate:ocean-ice:v1',
  wildfires:         'wildfire:fires:v1',
  marketQuotes:      'market:stocks-bootstrap:v1',
  commodityQuotes:   'market:commodities-bootstrap:v1',
  cyberThreats:      'cyber:threats-bootstrap:v2',
  techReadiness:     'economic:worldbank-techreadiness:v1',
  progressData:      'economic:worldbank-progress:v1',
  renewableEnergy:   'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
  riskScores:        'risk:scores:sebuf:stale:v1',
  naturalEvents:     'natural:events:v1',
  flightDelays:      'aviation:delays-bootstrap:v1',
  newsInsights:      'news:insights:v1',
  predictionMarkets: 'prediction:markets-bootstrap:v1',
  cryptoQuotes:      'market:crypto:v1',
  gulfQuotes:        'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents:      'unrest:events:v1',
  iranEvents:        'conflict:iran-events:v1',
  ucdpEvents:        'conflict:ucdp-events:v1',
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
  techEvents:        'research:tech-events-bootstrap:v1',
  gdeltIntel:        'intelligence:gdelt-intel:v1',
  correlationCards:   'correlation:cards-bootstrap:v1',
  forecasts:         'forecast:predictions:v2',
  securityAdvisories: 'intelligence:advisories-bootstrap:v1',
  customsRevenue:    'trade:customs-revenue:v1',
  comtradeFlows:     'comtrade:flows:v1',
  blsSeries:         'bls:series:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  crossSourceSignals: 'intelligence:cross-source-signals:v1',
  sanctionsEntities: 'sanctions:entities:v1',
  radiationWatch:    'radiation:observations:v1',
  consumerPricesOverview:   'consumer-prices:overview:ae',
  consumerPricesCategories: 'consumer-prices:categories:ae:30d',
  consumerPricesMovers:     'consumer-prices:movers:ae:30d',
  consumerPricesSpread:     'consumer-prices:retailer-spread:ae:essentials-ae',
  consumerPricesFreshness:  'consumer-prices:freshness:ae',
  groceryBasket:     'economic:grocery-basket:v1',
  bigmac:            'economic:bigmac:v1',
  fuelPrices:        'economic:fuel-prices:v1',
  faoFoodPriceIndex: 'economic:fao-ffpi:v1',
  nationalDebt:      'economic:national-debt:v1',
  defiTokens:        'market:defi-tokens:v1',
  aiTokens:          'market:ai-tokens:v1',
  otherTokens:       'market:other-tokens:v1',
  fredBatch:         'economic:fred:v1:FEDFUNDS:0',
  ecbEstr:           'economic:fred:v1:ESTR:0',
  ecbEuribor3m:      'economic:fred:v1:EURIBOR3M:0',
  ecbEuribor6m:      'economic:fred:v1:EURIBOR6M:0',
  ecbEuribor1y:      'economic:fred:v1:EURIBOR1Y:0',
  fearGreedIndex:    'market:fear-greed:v1',
  breadthHistory:    'market:breadth-history:v1',
  euYieldCurve:      'economic:yield-curve-eu:v1',
  earningsCalendar:  'market:earnings-calendar:v1',
  econCalendar:      'economic:econ-calendar:v1',
  cotPositioning:    'market:cot:v1',
  hyperliquidFlow:   'market:hyperliquid:flow:v1',
  crudeInventories:  'economic:crude-inventories:v1',
  natGasStorage:     'economic:nat-gas-storage:v1',
  spr:               'economic:spr:v1',
  refineryInputs:    'economic:refinery-inputs:v1',
  ecbFxRates:        'economic:ecb-fx-rates:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  eurostatHousePrices: 'economic:eurostat:house-prices:v1',
  eurostatGovDebtQ:    'economic:eurostat:gov-debt-q:v1',
  eurostatIndProd:     'economic:eurostat:industrial-production:v1',
  euGasStorage:      'economic:eu-gas-storage:v1',
  euFsi:             'economic:fsi-eu:v1',
  shippingStress:    'supply_chain:shipping_stress:v1',
  diseaseOutbreaks:  'health:disease-outbreaks:v1',
  healthAirQuality:  'health:air-quality:v1',
  socialVelocity:    'intelligence:social:reddit:v1',
  wsbTickers:        'intelligence:wsb-tickers:v1',
  vpdTrackerRealtime:   'health:vpd-tracker:realtime:v1',
  vpdTrackerHistorical: 'health:vpd-tracker:historical:v1',
  electricityPrices:    'energy:electricity:v1:index',
  gasStorageCountries: 'energy:gas-storage:v1:_countries',
  aaiiSentiment:       'market:aaii-sentiment:v1',
  cryptoSectors:       'market:crypto-sectors:v1',
  ddosAttacks:         'cf:radar:ddos:v1',
  economicStress:      'economic:stress-index:v1',
  trafficAnomalies:    'cf:radar:traffic-anomalies:v1',
};

const STANDALONE_KEYS = {
  serviceStatuses:       'infra:service-statuses:v1',
  macroSignals:          'economic:macro-signals:v1',
  bisPolicy:             'economic:bis:policy:v1',
  bisExchange:           'economic:bis:eer:v1',
  fxYoy:                 'economic:fx:yoy:v1',
  bisCredit:             'economic:bis:credit:v1',
  bisDsr:                'economic:bis:dsr:v1',
  bisPropertyResidential: 'economic:bis:property-residential:v1',
  bisPropertyCommercial:  'economic:bis:property-commercial:v1',
  imfMacro:             'economic:imf:macro:v2',
  imfGrowth:            'economic:imf:growth:v1',
  imfLabor:             'economic:imf:labor:v1',
  imfExternal:          'economic:imf:external:v1',
  climateZoneNormals:    'climate:zone-normals:v1',
  shippingRates:         'supply_chain:shipping:v2',
  chokepoints:           'supply_chain:chokepoints:v4',
  minerals:              'supply_chain:minerals:v2',
  giving:                'giving:summary:v1',
  gpsjam:                'intelligence:gpsjam:v2',
  theaterPosture:        'theater_posture:sebuf:stale:v1',
  theaterPostureLive:    'theater-posture:sebuf:v1',
  theaterPostureBackup:  'theater-posture:sebuf:backup:v1',
  riskScoresLive:        'risk:scores:sebuf:v1',
  usniFleet:             'usni-fleet:sebuf:v1',
  usniFleetStale:        'usni-fleet:sebuf:stale:v1',
  faaDelays:             'aviation:delays:faa:v1',
  intlDelays:            'aviation:delays:intl:v3',
  notamClosures:         'aviation:notam:closures:v2',
  positiveEventsLive:    'positive-events:geo:v1',
  cableHealth:           'cable-health-v1',
  cyberThreatsRpc:       'cyber:threats:v2',
  militaryBases:         'military:bases:active',
  militaryFlights:       'military:flights:v1',
  militaryFlightsStale:  'military:flights:stale:v1',
  temporalAnomalies:     'temporal:anomalies:v1',
  displacement:          `displacement:summary:v1:${new Date().getUTCFullYear()}`,
  displacementPrev:      `displacement:summary:v1:${new Date().getUTCFullYear() - 1}`,
  satellites:            'intelligence:satellites:tle:v1',
  portwatch:             'supply_chain:portwatch:v1',
  portwatchPortActivity: 'supply_chain:portwatch-ports:v1:_countries',
  corridorrisk:          'supply_chain:corridorrisk:v1',
  chokepointTransits:    'supply_chain:chokepoint_transits:v1',
  transitSummaries:      'supply_chain:transit-summaries:v1',
  thermalEscalation:     'thermal:escalation:v1',
  tariffTrendsUs:           'trade:tariffs:v1:840:all:10',
  militaryForecastInputs:   'military:forecast-inputs:stale:v1',
  gscpi:                    'economic:fred:v1:GSCPI:0',
  marketImplications:       'intelligence:market-implications:v1',
  hormuzTracker:            'supply_chain:hormuz_tracker:v1',
  simulationPackageLatest:  'forecast:simulation-package:latest',
  simulationOutcomeLatest:  'forecast:simulation-outcome:latest',
  newsThreatSummary:        'news:threat:summary:v1',
  climateNews:              'climate:news-intelligence:v1',
  pizzint:                  'intelligence:pizzint:seed:v1',
  resilienceStaticIndex:    'resilience:static:index:v1',
  resilienceStaticFao:      'resilience:static:fao',
  resilienceRanking:        'resilience:ranking:v9',
  productCatalog:           'product-catalog:v2',
  energySpineCountries:     'energy:spine:v1:_countries',
  energyExposure:           'energy:exposure:v1:index',
  energyMixAll:             'energy:mix:v1:_all',
  regulatoryActions:        'regulatory:actions:v1',
  energyIntelligence:       'energy:intelligence:feed:v1',
  ieaOilStocks:             'energy:iea-oil-stocks:v1:index',
  oilStocksAnalysis:        'energy:oil-stocks-analysis:v1',
  eiaPetroleum:             'energy:eia-petroleum:v1',
  jodiGas:                  'energy:jodi-gas:v1:_countries',
  lngVulnerability:         'energy:lng-vulnerability:v1',
  jodiOil:                  'energy:jodi-oil:v1:_countries',
  chokepointBaselines:      'energy:chokepoint-baselines:v1',
  portwatchChokepointsRef:  'portwatch:chokepoints:ref:v1',
  chokepointFlows:          'energy:chokepoint-flows:v1',
  emberElectricity:         'energy:ember:v1:_all',
  resilienceIntervals:      'resilience:intervals:v1:US',
  sprPolicies:              'energy:spr-policies:v1',
  energyCrisisPolicies:     'energy:crisis-policies:v1',
  regionalSnapshots:        'intelligence:regional-snapshots:summary:v1',
  regionalBriefs:           'intelligence:regional-briefs:summary:v1',
  recoveryFiscalSpace:      'resilience:recovery:fiscal-space:v1',
  recoveryReserveAdequacy:  'resilience:recovery:reserve-adequacy:v1',
  recoveryExternalDebt:     'resilience:recovery:external-debt:v1',
  recoveryImportHhi:        'resilience:recovery:import-hhi:v1',
  recoveryFuelStocks:       'resilience:recovery:fuel-stocks:v1',
  goldExtended:             'market:gold-extended:v1',
  goldEtfFlows:             'market:gold-etf-flows:v1',
  goldCbReserves:           'market:gold-cb-reserves:v1',
  // Relay-side loop heartbeats. ais-relay.cjs writes these on successful child
  // exit for the two execFile-spawned seeders (chokepoint-flows, climate-news).
  // A stale heartbeat means the relay loop itself is broken (child dying at
  // import, parent event-loop blocked, container in a restart loop, etc.)
  // and alarms earlier than the underlying seed-meta staleness window.
  chokepointFlowsRelayHeartbeat: 'relay:heartbeat:chokepoint-flows',
  climateNewsRelayHeartbeat:     'relay:heartbeat:climate-news',
  telegramFeed:                  'intelligence:telegram-feed:v1',
};

const SEED_META = {
  earthquakes:      { key: 'seed-meta:seismology:earthquakes',  maxStaleMin: 30 },
  wildfires:        { key: 'seed-meta:wildfire:fires',          maxStaleMin: 360 }, // FIRMS NRT resets at midnight UTC; new-day data takes 3-6h to accumulate
  outages:          { key: 'seed-meta:infra:outages',           maxStaleMin: 30 },
  climateAnomalies: { key: 'seed-meta:climate:anomalies',       maxStaleMin: 240 }, // runs as independent Railway cron (0 */2 * * *); 240 = 2x interval
  climateDisasters: { key: 'seed-meta:climate:disasters',       maxStaleMin: 720 }, // runs every 6h; 720min = 2x interval
  climateAirQuality:{ key: 'seed-meta:health:air-quality',      maxStaleMin: 180 }, // hourly cron; 180 = 3x interval — shares meta key with healthAirQuality (same seeder run)
  climateZoneNormals: { key: 'seed-meta:climate:zone-normals',  maxStaleMin: 89280 }, // monthly cron on the 1st; 62d = 2x 31-day cadence
  co2Monitoring:    { key: 'seed-meta:climate:co2-monitoring',  maxStaleMin: 4320 }, // daily cron at 06:00 UTC; 72h tolerates two missed runs
  oceanIce:         { key: 'seed-meta:climate:ocean-ice',       maxStaleMin: 2880 }, // daily cron at 08:00 UTC; 48h = 2× interval, tolerates one missed run
  climateNews:      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 }, // relay loop every 30min; 90 = 3× interval
  unrestEvents:     { key: 'seed-meta:unrest:events',           maxStaleMin: 120 }, // 45min cron; 120 = 2h grace (was 75 = 30min buffer, too tight)
  cyberThreats:     { key: 'seed-meta:cyber:threats',           maxStaleMin: 240 }, // 2h interval; 240min = 2x interval
  cryptoQuotes:     { key: 'seed-meta:market:crypto',           maxStaleMin: 30 },
  etfFlows:         { key: 'seed-meta:market:etf-flows',        maxStaleMin: 60 },
  gulfQuotes:       { key: 'seed-meta:market:gulf-quotes',      maxStaleMin: 30 },
  stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',      maxStaleMin: 60 },
  naturalEvents:    { key: 'seed-meta:natural:events',          maxStaleMin: 360 }, // 2h cron; 3x interval; was 120 (TTL was 60min — panel went dark before health alarmed)
  flightDelays:     { key: 'seed-meta:aviation:faa',            maxStaleMin: 90 }, // CACHE_TTL=7200s; matches notamClosures from same cron
  notamClosures:    { key: 'seed-meta:aviation:notam',          maxStaleMin: 240 }, // 2h interval; 240min = 2x interval
  predictionMarkets: { key: 'seed-meta:prediction:markets',     maxStaleMin: 90 },
  newsInsights:     { key: 'seed-meta:news:insights',           maxStaleMin: 30 },
  marketQuotes:     { key: 'seed-meta:market:stocks',         maxStaleMin: 30 },
  commodityQuotes:  { key: 'seed-meta:market:commodities',    maxStaleMin: 30 },
  goldExtended:     { key: 'seed-meta:market:gold-extended',  maxStaleMin: 30 },
  goldEtfFlows:     { key: 'seed-meta:market:gold-etf-flows', maxStaleMin: 2880 }, // SPDR publishes daily; 2× = 48h tolerance
  goldCbReserves:   { key: 'seed-meta:market:gold-cb-reserves', maxStaleMin: 44640 }, // IMF IFS is monthly w/ ~2-3mo lag; 31d tolerance
  // RPC/warm-ping keys — seed-meta written by relay loops or handlers
  // serviceStatuses: moved to ON_DEMAND — RPC-populated, no dedicated seed, goes stale when no users visit
  cableHealth:      { key: 'seed-meta:cable-health',              maxStaleMin: 90 }, // ais-relay warm-ping runs every 30min; 90min = 3× interval catches missed pings without false positives
  macroSignals:     { key: 'seed-meta:economic:macro-signals',    maxStaleMin: 150 }, // seed-economy cron; primary key energy-prices has same 150min threshold
  bisPolicy:        { key: 'seed-meta:economic:bis',              maxStaleMin: 10080 }, // runSeed('economic','bis',...) writes seed-meta:economic:bis
  // seed-bis-extended.mjs writes per-dataset seed-meta keys ONLY when that
  // specific dataset published fresh entries — so a single-dataset BIS outage
  // (e.g. WS_DSR 500s) goes stale in health without falsely dragging down the
  // healthy ones. 24h = 2× 12h cron.
  bisDsr:                { key: 'seed-meta:economic:bis-dsr',                  maxStaleMin: 1440 },
  bisPropertyResidential:{ key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
  bisPropertyCommercial: { key: 'seed-meta:economic:bis-property-commercial',  maxStaleMin: 1440 },
  imfMacro:         { key: 'seed-meta:economic:imf-macro',        maxStaleMin: 100800 }, // monthly seed; 100800min = 70 days = 2× interval (absorbs one missed run)
  imfGrowth:        { key: 'seed-meta:economic:imf-growth',       maxStaleMin: 100800 }, // monthly seed; 70d threshold matches imfMacro (same WEO release cadence)
  imfLabor:         { key: 'seed-meta:economic:imf-labor',        maxStaleMin: 100800 }, // monthly seed; 70d threshold matches imfMacro
  imfExternal:      { key: 'seed-meta:economic:imf-external',     maxStaleMin: 100800 }, // monthly seed; 70d threshold matches imfMacro
  shippingRates:    { key: 'seed-meta:supply_chain:shipping',     maxStaleMin: 420 },
  chokepoints:      { key: 'seed-meta:supply_chain:chokepoints',  maxStaleMin: 60, minRecordCount: 13 }, // 13 canonical chokepoints; get-chokepoint-status writes covered-count → < 13 = upstream partial (portwatch/ArcGIS dropped some)
  // minerals + giving: on-demand cachedFetchJson only, no seed-meta writer — freshness checked via TTL
  // bisExchange + bisCredit: extras written by same BIS script via writeExtraKey, no dedicated seed-meta
  fxYoy:            { key: 'seed-meta:economic:fx-yoy',           maxStaleMin: 1500 }, // daily cron; 25h tolerance + 1h drift
  gpsjam:           { key: 'seed-meta:intelligence:gpsjam',       maxStaleMin: 720 },
  positiveGeoEvents:{ key: 'seed-meta:positive-events:geo',       maxStaleMin: 60 },
  riskScores:       { key: 'seed-meta:intelligence:risk-scores',  maxStaleMin: 30 }, // CII warm-ping every 8min; 30min = ~3.5x interval,
  iranEvents:       { key: 'seed-meta:conflict:iran-events',      maxStaleMin: 20160 }, // manual seed from LiveUAMap; 20160 = 14d = 2× weekly cadence
  ucdpEvents:       { key: 'seed-meta:conflict:ucdp-events',      maxStaleMin: 420 },
  militaryFlights:  { key: 'seed-meta:military:flights',           maxStaleMin: 30 }, // cron ~10min (LIVE_TTL=600s); 30min = 3x interval,
  satellites:       { key: 'seed-meta:intelligence:satellites',    maxStaleMin: 240 }, // CelesTrak every 120min; 240min = absorbs one missed cycle
  weatherAlerts:    { key: 'seed-meta:weather:alerts',             maxStaleMin: 45 }, // relay loop every 15min; 45 = 3× interval (was 30 = 2×, too tight on relay hiccup)
  spending:         { key: 'seed-meta:economic:spending',          maxStaleMin: 120 },
  techEvents:       { key: 'seed-meta:research:tech-events',       maxStaleMin: 480 },
  gdeltIntel:       { key: 'seed-meta:intelligence:gdelt-intel',   maxStaleMin: 420 }, // 6h cron + 1h grace; CACHE_TTL is 24h so per-topic merge always has a prior snapshot
  telegramFeed:     { key: 'seed-meta:intelligence:telegram-feed:v1', maxStaleMin: 10 }, // 60s poll interval; 10min grace catches poll failures before they go stale in the panel
  forecasts:        { key: 'seed-meta:forecast:predictions',       maxStaleMin: 90 },
  sectors:          { key: 'seed-meta:market:sectors',             maxStaleMin: 30 },
  techReadiness:    { key: 'seed-meta:economic:worldbank-techreadiness:v1', maxStaleMin: 10080 },
  progressData:     { key: 'seed-meta:economic:worldbank-progress:v1',     maxStaleMin: 10080 },
  renewableEnergy:  { key: 'seed-meta:economic:worldbank-renewable:v1',    maxStaleMin: 10080 },
  intlDelays:       { key: 'seed-meta:aviation:intl',           maxStaleMin: 90 },
  // faaDelays shares seed-meta key with flightDelays — no duplicate entry needed here
  theaterPosture:   { key: 'seed-meta:theater-posture',         maxStaleMin: 60 },
  correlationCards: { key: 'seed-meta:correlation:cards',       maxStaleMin: 15 },
  portwatch:           { key: 'seed-meta:supply_chain:portwatch',            maxStaleMin: 720 },
  portwatchPortActivity: { key: 'seed-meta:supply_chain:portwatch-ports',   maxStaleMin: 2160 }, // 12h cron; 2160min = 36h = 3x interval
  corridorrisk:        { key: 'seed-meta:supply_chain:corridorrisk',         maxStaleMin: 120 },
  chokepointTransits:  { key: 'seed-meta:supply_chain:chokepoint_transits',  maxStaleMin: 30 }, // relay every 10min; 30min = 3x interval,
  transitSummaries:    { key: 'seed-meta:supply_chain:transit-summaries',    maxStaleMin: 30 }, // relay every 10min; 30min = 3x interval,
  usniFleet:           { key: 'seed-meta:military:usni-fleet',               maxStaleMin: 720 }, // relay loop every 6h; 720 = 2× interval (was 480 = 1.3×, too tight)
  securityAdvisories:  { key: 'seed-meta:intelligence:advisories',           maxStaleMin: 120 },
  customsRevenue:      { key: 'seed-meta:trade:customs-revenue',              maxStaleMin: 1440 },
  comtradeFlows:       { key: 'seed-meta:trade:comtrade-flows',               maxStaleMin: 2880 }, // 24h cron; 2880min = 48h = 2x interval
  blsSeries:           { key: 'seed-meta:economic:bls-series',                maxStaleMin: 2880 }, // daily seed; 2880min = 48h = 2x interval
  sanctionsPressure:   { key: 'seed-meta:sanctions:pressure',                 maxStaleMin: 720 },
  crossSourceSignals:  { key: 'seed-meta:intelligence:cross-source-signals',  maxStaleMin: 30 }, // 15min cron; 30min = 2x interval
  regionalSnapshots:   { key: 'seed-meta:intelligence:regional-snapshots',    maxStaleMin: 720 }, // 6h cron via seed-bundle-derived-signals; 720min = 12h = 2x interval
  regionalBriefs:      { key: 'seed-meta:intelligence:regional-briefs',      maxStaleMin: 20160 }, // weekly cron; 20160min = 14 days = 2x interval
  sanctionsEntities:   { key: 'seed-meta:sanctions:entities',                 maxStaleMin: 1440 }, // 12h cron; 1440min = 24h = 2x interval
  radiationWatch:      { key: 'seed-meta:radiation:observations',             maxStaleMin: 30 },
  groceryBasket:       { key: 'seed-meta:economic:grocery-basket',            maxStaleMin: 10080 }, // weekly seed; 10080 = 7 days
  bigmac:              { key: 'seed-meta:economic:bigmac',                    maxStaleMin: 10080 }, // weekly seed; 10080 = 7 days
  fuelPrices:          { key: 'seed-meta:economic:fuel-prices',               maxStaleMin: 10080 }, // weekly seed; 10080 = 7 days
  faoFoodPriceIndex:   { key: 'seed-meta:economic:fao-ffpi',                  maxStaleMin: 86400 }, // monthly seed; 86400 = 60 days (2x interval)
  thermalEscalation:   { key: 'seed-meta:thermal:escalation',                 maxStaleMin: 360 }, // cron every 2h; 360 = 3x interval (was 240 = 2x)
  nationalDebt:        { key: 'seed-meta:economic:national-debt',              maxStaleMin: 10080 }, // 7 days — monthly seed
  tariffTrendsUs:      { key: 'seed-meta:trade:tariffs:v1:840:all:10',        maxStaleMin: 900 },
  // publish.ts runs once daily (02:30 UTC); seed-meta TTL=52h — maxStaleMin must cover the full 24h cycle
  consumerPricesOverview:   { key: 'seed-meta:consumer-prices:overview:ae',     maxStaleMin: 1500 }, // 25h = 24h cadence + 1h grace
  consumerPricesCategories: { key: 'seed-meta:consumer-prices:categories:ae:30d',            maxStaleMin: 1500 },
  consumerPricesMovers:     { key: 'seed-meta:consumer-prices:movers:ae:30d',               maxStaleMin: 1500 },
  consumerPricesSpread:     { key: 'seed-meta:consumer-prices:retailer-spread:ae:essentials-ae', maxStaleMin: 1500 },
  consumerPricesFreshness:  { key: 'seed-meta:consumer-prices:freshness:ae',    maxStaleMin: 1500 },
  // defiTokens/aiTokens/otherTokens all share one seed run (seed-token-panels cron, every 30min)
  defiTokens:        { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  aiTokens:          { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  otherTokens:       { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  fredBatch:         { key: 'seed-meta:economic:fred:v1:FEDFUNDS:0', maxStaleMin: 1500 }, // daily cron
  ecbEstr:           { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // daily ECB publish; 4320min = 3d = TTL/interval
  ecbEuribor3m:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  ecbEuribor6m:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  ecbEuribor1y:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  gscpi:             { key: 'seed-meta:economic:gscpi',               maxStaleMin: 2880 }, // 24h interval; 2880min = 48h = 2x interval
  fearGreedIndex:    { key: 'seed-meta:market:fear-greed',            maxStaleMin: 720 }, // 6h cron; 720min = 12h = 2x interval
  breadthHistory:    { key: 'seed-meta:market:breadth-history',       maxStaleMin: 2880 }, // daily cron at 21:00 ET; 2880min = 48h = 2x interval
  hormuzTracker:     { key: 'seed-meta:supply_chain:hormuz_tracker',  maxStaleMin: 2880 }, // daily cron; 2880min = 48h = 2x interval
  earningsCalendar:  { key: 'seed-meta:market:earnings-calendar',     maxStaleMin: 1440 }, // 12h cron; 1440min = 24h = 2x interval
  econCalendar:      { key: 'seed-meta:economic:econ-calendar',       maxStaleMin: 1440 }, // 12h cron; 1440min = 24h = 2x interval
  cotPositioning:    { key: 'seed-meta:market:cot',                   maxStaleMin: 14400 }, // weekly CFTC release; 14400min = 10d = 1.4x interval (weekend + delay buffer)
  hyperliquidFlow:   { key: 'seed-meta:market:hyperliquid-flow',      maxStaleMin: 15 }, // Railway cron 5min; 15min = 3x interval
  crudeInventories:  { key: 'seed-meta:economic:crude-inventories',   maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  natGasStorage:     { key: 'seed-meta:economic:nat-gas-storage',     maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  spr:               { key: 'seed-meta:economic:spr',                 maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  refineryInputs:    { key: 'seed-meta:economic:refinery-inputs',     maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  ecbFxRates:        { key: 'seed-meta:economic:ecb-fx-rates',        maxStaleMin: 5760 }, // daily seed (weekdays + holidays); 5760min = 96h = covers Wed→Mon Easter gap
  eurostatCountryData: { key: 'seed-meta:economic:eurostat-country-data', maxStaleMin: 4320 }, // daily seed; 4320min = 3 days = 3x interval
  eurostatHousePrices: { key: 'seed-meta:economic:eurostat-house-prices', maxStaleMin: 60 * 24 * 50 }, // weekly cron, annual data; 50d threshold = 35d TTL + 15d buffer
  eurostatGovDebtQ:    { key: 'seed-meta:economic:eurostat-gov-debt-q',   maxStaleMin: 60 * 24 * 14 }, // 2d cron, quarterly data; 14d threshold matches TTL + quarterly release drift
  eurostatIndProd:     { key: 'seed-meta:economic:eurostat-industrial-production', maxStaleMin: 60 * 24 * 5 }, // daily cron, monthly data; 5d threshold matches TTL
  euGasStorage:      { key: 'seed-meta:economic:eu-gas-storage',      maxStaleMin: 2880 }, // daily seed (T+1); 2880min = 48h = 2x interval
  euYieldCurve:      { key: 'seed-meta:economic:yield-curve-eu',      maxStaleMin: 4320 }, // daily seed (weekdays only); 4320min = 72h = covers Fri→Mon gap
  euFsi:             { key: 'seed-meta:economic:fsi-eu',               maxStaleMin: 20160 }, // weekly seed (Saturday); 20160min = 14d = 2x interval
  newsThreatSummary: { key: 'seed-meta:news:threat-summary',          maxStaleMin: 60 }, // relay classify every ~20min; 60min = 3x interval
  shippingStress:    { key: 'seed-meta:supply_chain:shipping_stress',  maxStaleMin: 45 }, // relay loop every 15min; 45 = 3x interval (was 30 = 2×, too tight on relay hiccup)
  diseaseOutbreaks:  { key: 'seed-meta:health:disease-outbreaks',      maxStaleMin: 2880 }, // daily seed; 2880 = 48h = 2x interval
  healthAirQuality:  { key: 'seed-meta:health:air-quality',            maxStaleMin: 180 }, // hourly cron; 180 = 3x interval for shared health/climate seed
  socialVelocity:    { key: 'seed-meta:intelligence:social-reddit',    maxStaleMin: 180 }, // relay loop every 60min (hourly, bumped from 10min to reduce Reddit IP blocking); 180 = 3x interval
  wsbTickers:        { key: 'seed-meta:intelligence:wsb-tickers',      maxStaleMin: 180 }, // relay loop every 60min; 180 = 3x interval
  pizzint:           { key: 'seed-meta:intelligence:pizzint',          maxStaleMin: 30 }, // relay loop every 10min; 30 = 3x interval
  productCatalog:    { key: 'seed-meta:product-catalog',               maxStaleMin: 1080 }, // relay loop every 6h; 1080 = 18h = 3x interval
  vpdTrackerRealtime:   { key: 'seed-meta:health:vpd-tracker',         maxStaleMin: 2880 }, // daily seed (0 2 * * *); 2880min = 48h = 2x interval
  vpdTrackerHistorical: { key: 'seed-meta:health:vpd-tracker',         maxStaleMin: 2880 }, // shares seed-meta key with vpdTrackerRealtime (same run)
  resilienceStaticIndex: { key: 'seed-meta:resilience:static',         maxStaleMin: 576000 }, // annual October snapshot; 400d threshold matches TTL and preserves prior-year data on source outages
  resilienceStaticFao:   { key: 'seed-meta:resilience:static',         maxStaleMin: 576000 }, // same seeder + same heartbeat as resilienceStaticIndex; required so EMPTY_DATA_OK + missing data degrades to STALE_SEED instead of silent OK
  resilienceRanking:   { key: 'seed-meta:resilience:ranking',          maxStaleMin: 720 }, // RPC cache (12h TTL, refreshed every 6h by seed-resilience-scores cron via refreshRankingAggregate); 12h staleness threshold = 2 missed cron ticks
  resilienceIntervals: { key: 'seed-meta:resilience:intervals',        maxStaleMin: 20160 }, // weekly cron; 20160min = 14d = 2x interval
  energyExposure:       { key: 'seed-meta:economic:owid-energy-mix',   maxStaleMin: 50400 }, // monthly cron on 1st; 50400min = 35d = TTL matches cron cadence + 5d buffer
  energyMixAll:         { key: 'seed-meta:economic:owid-energy-mix',   maxStaleMin: 50400 }, // same seed run as energyExposure; shares seed-meta key
  regulatoryActions:    { key: 'seed-meta:regulatory:actions',          maxStaleMin: 360 }, // 2h cron; 360min = 3x interval
  energySpineCountries: { key: 'seed-meta:energy:spine',                maxStaleMin: 2880 }, // daily cron (06:00 UTC); 2880min = 48h = 2x interval
  electricityPrices:    { key: 'seed-meta:energy:electricity-prices',   maxStaleMin: 2880 }, // daily cron (14:00 UTC); 2880min = 48h = 2x interval
  gasStorageCountries:  { key: 'seed-meta:energy:gas-storage-countries', maxStaleMin: 2880 }, // daily cron at 10:30 UTC; 2880min = 48h = 2x interval
  energyIntelligence:   { key: 'seed-meta:energy:intelligence',          maxStaleMin: 720 }, // 6h cron; 720min = 2x interval
  jodiOil:              { key: 'seed-meta:energy:jodi-oil',               maxStaleMin: 60 * 24 * 40 }, // monthly cron on 25th; 40d threshold matches 35d TTL + 5d buffer
  ieaOilStocks:         { key: 'seed-meta:energy:iea-oil-stocks',        maxStaleMin: 60 * 24 * 40 }, // monthly cron on 15th; 40d threshold = TTL_SECONDS
  oilStocksAnalysis:    { key: 'seed-meta:energy:oil-stocks-analysis',   maxStaleMin: 60 * 24 * 50 }, // afterPublish of ieaOilStocks; 50d = matches seed-meta TTL (exceeds 40d data TTL)
  eiaPetroleum:         { key: 'seed-meta:energy:eia-petroleum',         maxStaleMin: 4320 }, // daily bundle cron (seed-bundle-energy-sources); 72h = 3× interval, well under 7d data TTL
  jodiGas:              { key: 'seed-meta:energy:jodi-gas',               maxStaleMin: 60 * 24 * 40 }, // monthly cron on 25th; 40d threshold matches 35d TTL + 5d buffer
  lngVulnerability:     { key: 'seed-meta:energy:jodi-gas',               maxStaleMin: 60 * 24 * 40 }, // written by jodi-gas seeder afterPublish; shares seed-meta key
  chokepointBaselines:  { key: 'seed-meta:energy:chokepoint-baselines', maxStaleMin: 60 * 24 * 400 }, // 400 days
  sprPolicies:          { key: 'seed-meta:energy:spr-policies',         maxStaleMin: 60 * 24 * 400 }, // 400 days; static registry, same cadence as chokepoint baselines
  energyCrisisPolicies: { key: 'seed-meta:energy:crisis-policies',      maxStaleMin: 60 * 24 * 400 }, // static data, ~400d TTL matches seeder
  aaiiSentiment:        { key: 'seed-meta:market:aaii-sentiment',       maxStaleMin: 20160 }, // weekly cron; 20160min = 14 days = 2x weekly cadence
  portwatchChokepointsRef: { key: 'seed-meta:portwatch:chokepoints-ref', maxStaleMin: 60 * 24 * 14 }, // seed-bundle-portwatch runs this at WEEK cadence; 14d = 2× interval
  chokepointFlows:      { key: 'seed-meta:energy:chokepoint-flows',     maxStaleMin: 720 }, // 6h cron; 720min = 2x interval
  // Relay-side heartbeat written by ais-relay.cjs on successful child exit.
  // Detects "relay loop fires but child dies at import/runtime" failures
  // (e.g. ERR_MODULE_NOT_FOUND from a missing Dockerfile COPY) 4h earlier
  // than the 720min seed-meta threshold above. TTL is 18h on the writer.
  chokepointFlowsRelayHeartbeat: { key: 'relay:heartbeat:chokepoint-flows', maxStaleMin: 480 }, // 6h loop; 8h alarm
  climateNewsRelayHeartbeat:     { key: 'relay:heartbeat:climate-news',     maxStaleMin: 60 },  // 30m loop; 60m alarm
  emberElectricity:     { key: 'seed-meta:energy:ember',                maxStaleMin: 2880 }, // daily cron (08:00 UTC); 2880min = 48h = 2x interval
  cryptoSectors:        { key: 'seed-meta:market:crypto-sectors',             maxStaleMin: 120 }, // relay loop every ~30min; 120min = 2h = 4x interval
  ddosAttacks:          { key: 'seed-meta:cf:radar:ddos',                    maxStaleMin: 60 }, // written by seed-internet-outages afterPublish; outages cron ~15min; 60 = 4x interval
  economicStress:       { key: 'seed-meta:economic:stress-index',            maxStaleMin: 180 }, // computed in seed-economy afterPublish; cron ~1h; 180min = 3x interval
  marketImplications:   { key: 'seed-meta:intelligence:market-implications', maxStaleMin: 120 }, // LLM-generated in seed-forecasts; cron ~1h; 120min = 2x interval
  trafficAnomalies:     { key: 'seed-meta:cf:radar:traffic-anomalies',       maxStaleMin: 60 }, // written by seed-internet-outages afterPublish; outages cron ~15min; 60 = 4x interval
  chokepointExposure:   { key: 'seed-meta:supply_chain:chokepoint-exposure', maxStaleMin: 2880 }, // daily cron; 2880min = 48h = 2x interval
  recoveryFiscalSpace:     { key: 'seed-meta:resilience:recovery:fiscal-space',     maxStaleMin: 86400 }, // monthly cron; 86400min = 60d = 2x interval
  recoveryReserveAdequacy: { key: 'seed-meta:resilience:recovery:reserve-adequacy', maxStaleMin: 86400 }, // monthly cron; 86400min = 60d = 2x interval
  recoveryExternalDebt:    { key: 'seed-meta:resilience:recovery:external-debt',    maxStaleMin: 86400 }, // monthly cron; 86400min = 60d = 2x interval
  recoveryImportHhi:       { key: 'seed-meta:resilience:recovery:import-hhi',       maxStaleMin: 86400 }, // monthly cron; 86400min = 60d = 2x interval
  recoveryFuelStocks:      { key: 'seed-meta:resilience:recovery:fuel-stocks',      maxStaleMin: 86400 }, // monthly cron; 86400min = 60d = 2x interval
};

// Standalone keys that are populated on-demand by RPC handlers (not seeds).
// Empty = WARN not CRIT since they only exist after first request.
const ON_DEMAND_KEYS = new Set([
  'riskScoresLive',
  'usniFleetStale', 'positiveEventsLive',
  'bisPolicy', 'bisExchange', 'bisCredit',
  // bisDsr/bisPropertyResidential/bisPropertyCommercial have dedicated SEED_META
  // entries (seed-bis-extended.mjs), so they are not on-demand.
  'macroSignals', 'shippingRates', 'chokepoints', 'minerals', 'giving',
  'cyberThreatsRpc', 'militaryBases', 'temporalAnomalies', 'displacement',
  'corridorrisk', // intermediate key; data flows through transit-summaries:v1
  'serviceStatuses', // RPC-populated; seed-meta written on fresh fetch only, goes stale between visits
  'militaryForecastInputs', // intermediate seed-to-seed pipeline key; only populated after seed-military-flights runs
  'marketImplications', // LLM-generated inside forecast cron; can fail silently on LLM errors — degrade to WARN not CRIT
  'simulationPackageLatest', // written by writeSimulationPackage after deep forecast runs; only present after first successful deep run
  'simulationOutcomeLatest', // written by writeSimulationOutcome after simulation runs; only present after first successful simulation
  'newsThreatSummary', // relay classify loop — only written when mergedByCountry has entries; absent on quiet news periods
  'resilienceRanking', // on-demand RPC cache populated after ranking requests; missing before first Pro use is expected
  'recoveryFiscalSpace', 'recoveryReserveAdequacy', 'recoveryExternalDebt',
  'recoveryImportHhi', 'recoveryFuelStocks', // recovery pillar: stub seeders not yet deployed, keys may be absent
  'displacementPrev', // covered by cascade onto current-year displacement; empty most of the year
  'fxYoy', // TRANSITIONAL (PR #3071): seed-fx-yoy Railway cron deployed manually after merge —
           // gate as on-demand so a deploy-order race or first-cron-run failure doesn't
           // fire a CRIT health alarm. Remove from this set after ~7 days of clean
           // production cron runs (verify via `seed-meta:economic:fx-yoy.fetchedAt`).
  'hyperliquidFlow', // TRANSITIONAL: seed-hyperliquid-flow runs inside seed-bundle-market-backup on
                     // Railway; gate as on-demand so initial deploy-order race or first cold-start
                     // snapshot doesn't CRIT. Remove after ~7 days of clean production cron runs.
  'chokepointFlowsRelayHeartbeat', // TRANSITIONAL (PR #3133): ais-relay.cjs writes this on the
                                   // first successful child exit after a deploy. Vercel deploys
                                   // api/health.js instantly, but Railway rebuild + 6h initial
                                   // loop interval means the key is absent for up to ~6h post-merge.
                                   // Gate as on-demand so the deploy window doesn't CRIT. Remove
                                   // after ~7 days of clean production runs (verify via
                                   // `relay:heartbeat:chokepoint-flows.fetchedAt`).
  'climateNewsRelayHeartbeat',     // TRANSITIONAL (PR #3133): same deploy-order rationale.
                                   // 30min initial loop, so window is shorter but still present.
                                   // Remove after ~7 days alongside the chokepoint-flows entry.
  'eiaPetroleum',                  // TRANSITIONAL: gold-standard migration of /api/eia/petroleum
                                   // from live Vercel fetch to Redis-reader (seed-bundle-energy-sources
                                   // daily cron). SEED_META entry above enforces 72h staleness — this
                                   // ON_DEMAND gate only softens the absent-on-deploy case (Vercel
                                   // deploys instantly; Railway EIA_API_KEY + first daily tick ~24h
                                   // behind). STALE_SEED still fires if data goes stale after first seed.
                                   // Remove from this set after ~7 days of clean cron runs so
                                   // never-provisioned Railway promotes EMPTY_ON_DEMAND → EMPTY (CRIT).
]);

// Keys where 0 records is a valid healthy state (e.g. no airports closed,
// no earnings events this week, econ calendar quiet between seasons).
// The key must still exist in Redis; only the record count can be 0.
const EMPTY_DATA_OK_KEYS = new Set([
  'notamClosures', 'faaDelays', 'gpsjam', 'positiveGeoEvents', 'weatherAlerts',
  'earningsCalendar', 'econCalendar', 'cotPositioning',
  'usniFleet', // usniFleetStale covers the fallback; relay outages → WARN not CRIT
  'newsThreatSummary', // only written when classify produces country matches; quiet news periods = 0 countries, no write
  'recoveryFiscalSpace',
  'recoveryImportHhi', 'recoveryFuelStocks', // recovery pillar seeds: stub seeders write empty payloads until real sources are wired
  'ddosAttacks', 'trafficAnomalies', // zero events during quiet periods is valid, not critical
  'resilienceStaticFao', // empty aggregate = no IPC Phase 3+ countries this year (possible in theory); the key must exist but count=0 is fine
]);

// Cascade groups: if any key in the group has data, all empty siblings are OK.
// Theater posture uses live → stale → backup fallback chain.
const CASCADE_GROUPS = {
  theaterPosture:       ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  theaterPostureLive:   ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  theaterPostureBackup: ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  militaryFlights:      ['militaryFlights', 'militaryFlightsStale'],
  militaryFlightsStale: ['militaryFlights', 'militaryFlightsStale'],
  // Displacement key embeds UTC year — on Jan 1 the new-year key may be empty
  // for hours until the seed runs. Cascade onto the previous-year snapshot.
  displacement:         ['displacement', 'displacementPrev'],
  displacementPrev:     ['displacement', 'displacementPrev'],
};


const NEG_SENTINEL = '__WM_NEG__';


function parseRedisValue(raw) {
  if (!raw || raw === NEG_SENTINEL) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Real data is always >0 bytes. The negative-cache sentinel is exactly
// NEG_SENTINEL.length bytes (10), so any strlen > 0 that is NOT exactly that
// length counts as data. The previous `> 10` heuristic misclassified
// legitimately small payloads (`{}`, `[]`, `0`) as missing.
function strlenIsData(strlen) {
  return strlen > 0 && strlen !== NEG_SENTINEL.length;
}

function readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, now) {
  if (!seedCfg) {
    return { seedAge: null, seedStale: null, seedError: false, metaReadFailed: false, metaCount: null };
  }
  // Per-command Redis errors on the GET seed-meta half of the pipeline must
  // not silently fall through to STALE_SEED — promote to REDIS_PARTIAL.
  if (keyMetaErrors.get(seedCfg.key)) {
    return { seedAge: null, seedStale: null, seedError: false, metaReadFailed: true, metaCount: null };
  }
  // Unwrap through the envelope helper. Legacy seed-meta is a bare
  // `{ fetchedAt, recordCount, sourceVersion, status? }` object with no `_seed`
  // wrapper, so `unwrapEnvelope` returns it as `.data` unchanged. PR 2 wires
  // true envelope reads at the canonical-key layer; this import establishes
  // the dependency so behavior stays byte-identical in PR 1.
  const meta = unwrapEnvelope(parseRedisValue(keyMetaValues.get(seedCfg.key))).data;
  if (meta?.status === 'error') {
    return { seedAge: null, seedStale: true, seedError: true, metaReadFailed: false, metaCount: null };
  }
  let seedAge = null;
  let seedStale = true;
  if (meta?.fetchedAt) {
    seedAge = Math.round((now - meta.fetchedAt) / 60_000);
    seedStale = seedAge > seedCfg.maxStaleMin;
  }
  const metaCount = meta?.count ?? meta?.recordCount ?? null;
  return { seedAge, seedStale, seedError: false, metaReadFailed: false, metaCount };
}

function isCascadeCovered(name, hasData, keyStrens, keyErrors) {
  const siblings = CASCADE_GROUPS[name];
  if (!siblings || hasData) return false;
  for (const sibling of siblings) {
    if (sibling === name) continue;
    const sibKey = STANDALONE_KEYS[sibling] ?? BOOTSTRAP_KEYS[sibling];
    if (!sibKey) continue;
    if (keyErrors.get(sibKey)) continue;
    if (strlenIsData(keyStrens.get(sibKey) ?? 0)) return true;
  }
  return false;
}

function classifyKey(name, redisKey, opts, ctx) {
  const { keyStrens, keyErrors, keyMetaValues, keyMetaErrors, now } = ctx;
  const seedCfg = SEED_META[name];
  const isOnDemand = !!opts.allowOnDemand && ON_DEMAND_KEYS.has(name);

  const meta = readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, now);

  // Per-command Redis errors (data STRLEN or seed-meta GET) propagate as their
  // own bucket — don't conflate with "key missing", since ops needs to know if
  // the read itself failed.
  if (keyErrors.get(redisKey) || meta.metaReadFailed) {
    const entry = { status: 'REDIS_PARTIAL', records: null };
    if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
    return entry;
  }

  const strlen = keyStrens.get(redisKey) ?? 0;
  const hasData = strlenIsData(strlen);
  const { seedAge, seedStale, seedError, metaCount } = meta;

  // When the data key is gone the meta count is meaningless; force records=0
  // so we never display the contradictory "EMPTY records=N>0" pair (item 1).
  const records = hasData ? (metaCount ?? 1) : 0;
  const cascadeCovered = isCascadeCovered(name, hasData, keyStrens, keyErrors);

  let status;
  if (seedError) status = 'SEED_ERROR';
  else if (!hasData) {
    if (cascadeCovered) status = 'OK_CASCADE';
    else if (EMPTY_DATA_OK_KEYS.has(name)) status = seedStale === true ? 'STALE_SEED' : 'OK';
    else if (isOnDemand) status = 'EMPTY_ON_DEMAND';
    else status = 'EMPTY';
  } else if (records === 0) {
    // hasData is true in this branch, so cascade can never apply (isCascadeCovered
    // short-circuits when hasData=true). Cascade only shields wholly absent keys.
    if (EMPTY_DATA_OK_KEYS.has(name)) status = seedStale === true ? 'STALE_SEED' : 'OK';
    else if (isOnDemand) status = 'EMPTY_ON_DEMAND';
    else status = 'EMPTY_DATA';
  } else if (seedStale === true) status = 'STALE_SEED';
  // Coverage threshold: producers that know their canonical shape size can
  // declare minRecordCount. When the writer reports a count below threshold
  // (e.g., 10/13 chokepoints because portwatch dropped some), this degrades
  // to COVERAGE_PARTIAL (warn) instead of reporting OK. Producer must write
  // seed-meta.recordCount using the *covered* count, not the shape size.
  else if (seedCfg?.minRecordCount != null && records < seedCfg.minRecordCount) status = 'COVERAGE_PARTIAL';
  else status = 'OK';

  const entry = { status, records };
  if (seedAge !== null) entry.seedAgeMin = seedAge;
  if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
  if (seedCfg?.minRecordCount != null) entry.minRecordCount = seedCfg.minRecordCount;
  return entry;
}

const STATUS_COUNTS = {
  OK: 'ok',
  OK_CASCADE: 'ok',
  STALE_SEED: 'warn',
  SEED_ERROR: 'warn',
  EMPTY_ON_DEMAND: 'warn',
  REDIS_PARTIAL: 'warn',
  COVERAGE_PARTIAL: 'warn',
  EMPTY: 'crit',
  EMPTY_DATA: 'crit',
};

export default async function handler(req, ctx) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'CF-Cache-Status': 'BYPASS',
    'Access-Control-Allow-Origin': '*',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const now = Date.now();

  const allDataKeys = [
    ...Object.values(BOOTSTRAP_KEYS),
    ...Object.values(STANDALONE_KEYS),
  ];
  const allMetaKeys = Object.values(SEED_META).map(s => s.key);

  // STRLEN for data keys avoids loading large blobs into memory (OOM prevention).
  // NEG_SENTINEL ('__WM_NEG__') is 10 bytes — strlenIsData() rejects exactly
  // that length while accepting any other non-zero strlen as data.
  let results;
  try {
    const commands = [
      ...allDataKeys.map(k => ['STRLEN', k]),
      ...allMetaKeys.map(k => ['GET', k]),
    ];
    if (!getRedisCredentials()) throw new Error('Redis not configured');
    results = await redisPipeline(commands, 8_000);
    if (!results) throw new Error('Redis request failed');
  } catch (err) {
    return jsonResponse({
      status: 'REDIS_DOWN',
      error: err.message,
      checkedAt: new Date(now).toISOString(),
    }, 200, headers);
  }

  // keyStrens: byte length per data key (0 = missing/empty/sentinel)
  // keyErrors: per-command Redis errors so we can surface REDIS_PARTIAL
  const keyStrens = new Map();
  const keyErrors = new Map();
  for (let i = 0; i < allDataKeys.length; i++) {
    const r = results[i];
    if (r?.error) keyErrors.set(allDataKeys[i], r.error);
    keyStrens.set(allDataKeys[i], r?.result ?? 0);
  }
  // keyMetaValues: parsed seed-meta objects (GET, small payloads)
  // keyMetaErrors: per-command errors so a single GET failure surfaces as
  // REDIS_PARTIAL instead of silently degrading to STALE_SEED.
  const keyMetaValues = new Map();
  const keyMetaErrors = new Map();
  for (let i = 0; i < allMetaKeys.length; i++) {
    const r = results[allDataKeys.length + i];
    if (r?.error) keyMetaErrors.set(allMetaKeys[i], r.error);
    keyMetaValues.set(allMetaKeys[i], r?.result ?? null);
  }

  const classifyCtx = { keyStrens, keyErrors, keyMetaValues, keyMetaErrors, now };
  const checks = {};
  const counts = { ok: 0, warn: 0, onDemandWarn: 0, crit: 0 };
  let totalChecks = 0;

  const sources = [
    [BOOTSTRAP_KEYS, { allowOnDemand: false }],
    [STANDALONE_KEYS, { allowOnDemand: true }],
  ];
  for (const [registry, opts] of sources) {
    for (const [name, redisKey] of Object.entries(registry)) {
      totalChecks++;
      const entry = classifyKey(name, redisKey, opts, classifyCtx);
      checks[name] = entry;
      const bucket = STATUS_COUNTS[entry.status] ?? 'warn';
      counts[bucket]++;
      if (entry.status === 'EMPTY_ON_DEMAND') counts.onDemandWarn++;
    }
  }

  // On-demand keys that simply haven't been requested yet should not flip
  // overall to WARNING — they're warn-level only for visibility.
  const realWarnCount = counts.warn - counts.onDemandWarn;
  const critCount = counts.crit;

  let overall;
  if (critCount === 0 && realWarnCount === 0) overall = 'HEALTHY';
  else if (critCount === 0) overall = 'WARNING';
  // Degraded threshold scales with registry size so adding keys doesn't
  // silently raise the page-out bar. ~3% of total keys (was hardcoded 3).
  else if (critCount / totalChecks <= 0.03) overall = 'DEGRADED';
  else overall = 'UNHEALTHY';

  const httpStatus = 200;

  if (overall !== 'HEALTHY' && overall !== 'WARNING') {
    const problemKeys = Object.entries(checks)
      .filter(([, c]) => c.status === 'EMPTY' || c.status === 'EMPTY_DATA' || c.status === 'STALE_SEED' || c.status === 'SEED_ERROR' || c.status === 'REDIS_PARTIAL')
      .map(([k, c]) => `${k}:${c.status}${c.seedAgeMin != null ? `(${c.seedAgeMin}min)` : ''}`);
    console.log('[health] %s crits=[%s]', overall, problemKeys.join(', '));
    // Persist last failure snapshot for post-mortem. Vercel edge isolates can
    // terminate before a fire-and-forget Promise resolves; ctx.waitUntil keeps
    // the runtime alive until the write completes.
    const persist = redisPipeline([['SET', 'health:last-failure', JSON.stringify({
      at: new Date(now).toISOString(),
      status: overall,
      critCount,
      crits: problemKeys,
    }), 'EX', 86400]]).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(persist);
  }

  const url = new URL(req.url);
  const compact = url.searchParams.get('compact') === '1';

  const body = {
    status: overall,
    summary: {
      total: totalChecks,
      ok: counts.ok,
      // `warn` excludes on-demand-empty (cosmetic warns); `onDemandWarn` is
      // surfaced separately so readers can reconcile against `overall`.
      warn: realWarnCount,
      onDemandWarn: counts.onDemandWarn,
      crit: critCount,
    },
    checkedAt: new Date(now).toISOString(),
  };

  if (!compact) {
    body.checks = checks;
  } else {
    const problems = {};
    for (const [name, check] of Object.entries(checks)) {
      if (check.status !== 'OK' && check.status !== 'OK_CASCADE') problems[name] = check;
    }
    if (Object.keys(problems).length > 0) body.problems = problems;
  }

  return new Response(JSON.stringify(body, null, compact ? 0 : 2), {
    status: httpStatus,
    headers,
  });
}
