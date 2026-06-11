import type { MapLayers } from '@/types';
// boundary-ignore: isDesktopRuntime is a pure env probe with no service dependencies
import { isDesktopRuntime } from '@/services/runtime';

export type MapRenderer = 'flat' | 'globe';
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity' | 'energy';

const _desktop = isDesktopRuntime();

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  renderers: MapRenderer[];
  premium?: 'locked' | 'enhanced';
  /**
   * When true, this layer only renders under DeckGL — neither the SVG/mobile
   * fallback in Map.ts nor the WebGL GlobeMap has a code path for its data.
   * `renderers: ['flat']` is not sufficient because `'flat'` covers both
   * DeckGL-flat and SVG-flat. Consumers (layer picker, CMD+K dispatcher)
   * must additionally gate on `isDeckGLActive()` for these layers.
   */
  deckGLOnly?: boolean;
}

export type LayerExplanationCoverage = 'curated' | 'fallback';

export interface LayerExplanation {
  key: keyof MapLayers;
  coverage: LayerExplanationCoverage;
  category: string;
  purpose: string;
  source: string;
  freshness: string;
  confidence: string;
  limitations: string[];
  related: string[];
  evidence: string[];
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: MapRenderer[] = ['flat', 'globe'],
  premium?: 'locked' | 'enhanced',
  deckGLOnly?: boolean,
): LayerDefinition => ({
  key, icon, i18nSuffix, fallbackLabel, renderers,
  ...(premium && { premium }),
  ...(deckGLOnly && { deckGLOnly: true }),
});

export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  iranAttacks:              def('iranAttacks',              '&#127919;', 'iranAttacks',              'Iran Attacks', ['flat', 'globe'], _desktop ? 'locked' : undefined),
  hotspots:                 def('hotspots',                 '&#127919;', 'intelHotspots',            'Intel Hotspots'),
  conflicts:                def('conflicts',                '&#9876;',   'conflictZones',            'Conflict Zones'),

  bases:                    def('bases',                    '&#127963;', 'militaryBases',            'Military Bases'),
  nuclear:                  def('nuclear',                  '&#9762;',   'nuclearSites',             'Nuclear Sites'),
  irradiators:              def('irradiators',              '&#9888;',   'gammaIrradiators',         'Gamma Irradiators'),
  radiationWatch:           def('radiationWatch',           '&#9762;',   'radiationWatch',           'Radiation Watch'),
  spaceports:               def('spaceports',               '&#128640;', 'spaceports',               'Spaceports'),
  satellites:               def('satellites',               '&#128752;', 'satellites',               'Orbital Surveillance', ['flat', 'globe']),

  cables:                   def('cables',                   '&#128268;', 'underseaCables',           'Undersea Cables'),
  pipelines:                def('pipelines',                '&#128738;', 'pipelines',                'Pipelines'),
  datacenters:              def('datacenters',              '&#128421;', 'aiDataCenters',            'AI Data Centers'),
  military:                 def('military',                 '&#9992;',   'militaryActivity',         'Military Activity'),
  ais:                      def('ais',                      '&#128674;', 'shipTraffic',              'Ship Traffic'),
  tradeRoutes:              def('tradeRoutes',              '&#9875;',   'tradeRoutes',              'Trade Routes'),
  flights:                  def('flights',                  '&#9992;',   'flightDelays',             'Aviation'),
  protests:                 def('protests',                 '&#128226;', 'protests',                 'Protests'),
  ucdpEvents:               def('ucdpEvents',               '&#9876;',   'ucdpEvents',               'Armed Conflict Events'),
  displacement:             def('displacement',             '&#128101;', 'displacementFlows',        'Displacement Flows'),
  climate:                  def('climate',                  '&#127787;', 'climateAnomalies',         'Climate Anomalies'),
  weather:                  def('weather',                  '&#9928;',   'weatherAlerts',            'Weather Alerts'),
  outages:                  def('outages',                  '&#128225;', 'internetOutages',          'Internet Disruptions'),
  cyberThreats:             def('cyberThreats',             '&#128737;', 'cyberThreats',             'Cyber Threats'),
  natural:                  def('natural',                  '&#127755;', 'naturalEvents',            'Natural Events'),
  fires:                    def('fires',                    '&#128293;', 'fires',                    'Fires'),
  waterways:                def('waterways',                '&#9875;',   'strategicWaterways',       'Chokepoints'),
  economic:                 def('economic',                 '&#128176;', 'economicCenters',          'Economic Centers'),
  minerals:                 def('minerals',                 '&#128142;', 'criticalMinerals',         'Critical Minerals'),
  gpsJamming:               def('gpsJamming',               '&#128225;', 'gpsJamming',               'GPS Jamming', ['flat', 'globe'], _desktop ? 'locked' : undefined),
  ciiChoropleth:            def('ciiChoropleth',            '&#127758;', 'ciiChoropleth',            'CII Instability', ['flat'], _desktop ? 'enhanced' : undefined),
  // DeckGLMap owns the resilience choropleth; Map.ts/MapContainer strip it
  // on SVG/mobile fallback.
  resilienceScore:          def('resilienceScore',          '&#128200;', 'resilienceScore',          'Resilience', ['flat'], 'locked', true),
  dayNight:                 def('dayNight',                 '&#127763;', 'dayNight',                 'Day/Night', ['flat']),
  sanctions:                def('sanctions',                '&#128683;', 'sanctions',                'Sanctions', ['flat']),
  startupHubs:              def('startupHubs',              '&#128640;', 'startupHubs',              'Startup Hubs'),
  techHQs:                  def('techHQs',                  '&#127970;', 'techHQs',                  'Tech HQs'),
  accelerators:             def('accelerators',             '&#9889;',   'accelerators',             'Accelerators'),
  cloudRegions:             def('cloudRegions',             '&#9729;',   'cloudRegions',             'Cloud Regions'),
  techEvents:               def('techEvents',               '&#128197;', 'techEvents',               'Tech Events'),
  stockExchanges:           def('stockExchanges',           '&#127963;', 'stockExchanges',           'Stock Exchanges'),
  financialCenters:         def('financialCenters',         '&#128176;', 'financialCenters',         'Financial Centers'),
  centralBanks:             def('centralBanks',             '&#127974;', 'centralBanks',             'Central Banks'),
  commodityHubs:            def('commodityHubs',            '&#128230;', 'commodityHubs',            'Commodity Hubs'),
  gulfInvestments:          def('gulfInvestments',          '&#127760;', 'gulfInvestments',          'GCC Investments'),
  positiveEvents:           def('positiveEvents',           '&#127775;', 'positiveEvents',           'Positive Events'),
  kindness:                 def('kindness',                 '&#128154;', 'kindness',                 'Acts of Kindness'),
  happiness:                def('happiness',                '&#128522;', 'happiness',                'World Happiness'),
  speciesRecovery:          def('speciesRecovery',          '&#128062;', 'speciesRecovery',          'Species Recovery'),
  renewableInstallations:   def('renewableInstallations',   '&#9889;',   'renewableInstallations',   'Clean Energy'),
  miningSites:              def('miningSites',              '&#128301;', 'miningSites',              'Mining Sites'),
  processingPlants:         def('processingPlants',         '&#127981;', 'processingPlants',         'Processing Plants'),
  commodityPorts:           def('commodityPorts',           '&#9973;',   'commodityPorts',           'Commodity Ports'),
  webcams:                  def('webcams',                  '&#128247;', 'webcams',                  'Live Webcams'),
  // weatherRadar removed — radar tiles now auto-start when Weather Alerts layer is toggled on
  diseaseOutbreaks:         def('diseaseOutbreaks',         '&#129440;', 'diseaseOutbreaks',         'Disease Outbreaks', ['flat'], undefined, true),
  // DeckGL-only layers. `renderers: ['flat']` hides them from the globe
  // picker (GlobeMap has no branch in ensureStaticDataForLayer / no entry
  // in the layer-channel map). `deckGLOnly: true` also hides them from
  // the SVG/mobile fallback's CMD+K dispatch (Map.ts has no SVG render
  // path for either marker/pin type). Restore to `['flat', 'globe']`
  // without `deckGLOnly` once both renderers gain real support.
  storageFacilities:        def('storageFacilities',        '&#127959;', 'storageFacilities',        'Storage Facilities', ['flat'], undefined, true),
  fuelShortages:            def('fuelShortages',            '&#9881;',   'fuelShortages',            'Fuel Shortages', ['flat'], undefined, true),
  liveTankers:              def('liveTankers',              '&#128674;', 'liveTankers',              'Live Tanker Positions', ['flat'], undefined, true),
};

export const V1_LAYER_EXPLANATION_KEYS = [
  'conflicts',
  'ucdpEvents',
  'ciiChoropleth',
  'natural',
  'flights',
  'ais',
  'waterways',
  'tradeRoutes',
  'cyberThreats',
  'hotspots',
] as const satisfies readonly (keyof MapLayers)[];

export const LAYER_EXPLANATIONS: Partial<Record<keyof MapLayers, LayerExplanation>> = {
  conflicts: {
    key: 'conflicts',
    coverage: 'curated',
    category: 'Conflict',
    purpose: 'Shows curated conflict zones and geopolitical boundary overlays so analysts can orient live signals against known theaters.',
    source: 'WorldMonitor conflict-zone registry, UCDP/ACLED conflict context, and documented boundary metadata such as the Korean DMZ.',
    freshness: 'Base zones are curated/static. Dynamic conflict-event inputs are tracked separately through ACLED/UCDP feeds and health signals.',
    confidence: 'Good for geographic orientation; not a real-time incident confirmation by itself.',
    limitations: [
      'Static zones can lag fast tactical changes.',
      'Some conflict evidence appears in UCDP Events, CII, or related panels rather than as a conflict-zone polygon.',
    ],
    related: ['UCDP Events', 'CII panel', 'Strategic Risk', 'Country brief'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/geo.ts'],
  },
  ucdpEvents: {
    key: 'ucdpEvents',
    coverage: 'curated',
    category: 'Conflict',
    purpose: 'Plots event-level armed conflict records with country, actors, date, and fatality ranges.',
    source: 'Uppsala Conflict Data Program GED API via the conflict service and UCDP event seed.',
    freshness: 'Seeded every 6 hours when the UCDP seed is healthy.',
    confidence: 'Higher editorial consistency than raw breaking feeds, but intentionally lagging and not a live battlefield feed.',
    limitations: [
      'Annual/research-grade release cadence can miss very recent events.',
      'Fatality ranges are estimates and should be interpreted as ranges, not exact counts.',
    ],
    related: ['UCDP Events panel', 'CII conflict component', 'Country timeline'],
    evidence: ['docs/architecture.mdx', 'src/services/conflict/index.ts', 'scripts/seed-ucdp-events.mjs'],
  },
  ciiChoropleth: {
    key: 'ciiChoropleth',
    coverage: 'curated',
    category: 'Country Risk',
    purpose: 'Colors countries by the current Country Instability Index score for broad strategic-risk triage.',
    source: 'WorldMonitor CII scoring service using conflict, unrest, advisories, cyber, AIS, aviation, natural-event, and news signals.',
    freshness: 'Risk-score cache is warm-pinged every 8 minutes; seed-meta and health.riskScores expose live, stale, partial, or degraded state against a 30-minute freshness budget.',
    confidence: 'Composite model signal, not an official country rating or probability forecast.',
    limitations: [
      'Sparse or degraded source families can reduce confidence even when a country still has a score.',
      'Country-level color can hide subnational variation and should be checked against panels before citation.',
    ],
    related: ['CII panel', 'Strategic Risk panel', 'Data freshness status', 'Country brief'],
    evidence: ['docs/strategic-risk.mdx', 'docs/architecture.mdx', 'src/services/cached-risk-scores.ts'],
  },
  natural: {
    key: 'natural',
    coverage: 'curated',
    category: 'Natural Disasters',
    purpose: 'Shows earthquakes, severe disaster alerts, and active Earth-observation events for situational awareness.',
    source: 'USGS earthquakes, GDACS alerts, and NASA EONET events merged into the natural events service.',
    freshness: 'Natural events are seeded every 2 hours; USGS earthquake expectations are documented at roughly 5-minute source cadence.',
    confidence: 'Strong for detected public disaster signals; confidence varies by hazard type and upstream reporting latency.',
    limitations: [
      'Low-severity GDACS alerts are filtered out to keep the map readable.',
      'EONET wildfires are freshness-filtered, so older open events may not appear as active map points.',
    ],
    related: ['Natural Events layer popups', 'Weather Alerts', 'Country brief natural signals'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'server/worldmonitor/natural/v1/list-natural-events.ts'],
  },
  flights: {
    key: 'flights',
    coverage: 'curated',
    category: 'Aviation',
    purpose: 'Highlights airport disruption, closures, NOTAM-derived airspace issues, and live aircraft positions when tracking is available.',
    source: 'FAA ASWS, AviationStack, ICAO NOTAMs, OpenSky/Wingbits aircraft tracking, and the aviation service.',
    freshness: 'Airport disruption seeds run on a 30-minute cadence; the aviation panel also refreshes operational views on a 5-minute polling cycle.',
    confidence: 'Best for disruption triage; individual live aircraft coverage depends on ADS-B availability and configured providers.',
    limitations: [
      'AviationStack-backed simulated demo data can appear when an API key is absent.',
      'Live aircraft positions can be delayed or absent where ADS-B coverage is weak or blocked.',
    ],
    related: ['Airline Intel panel', 'Aviation command bar', 'Country brief aviation signals'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/services/aviation/index.ts', 'scripts/seed-aviation.mjs'],
  },
  ais: {
    key: 'ais',
    coverage: 'curated',
    category: 'Maritime',
    purpose: 'Shows vessel density and AIS disruption signals around strategic waters and chokepoints.',
    source: 'AISStream relay snapshots, WorldMonitor maritime service, and chokepoint disruption classifiers.',
    freshness: 'AIS relay snapshots are rebuilt every 5 seconds by default; the server may cache the base density snapshot for 5 minutes, and the layer is disabled or stale when relay credentials/connectivity are unavailable.',
    confidence: 'Useful for maritime anomaly screening, but AIS is self-reported and vessels can go dark.',
    limitations: [
      'Terrestrial AIS coverage is uneven, with weaker Middle East, Asia, and open-ocean visibility documented.',
      'Dark shipping is inferred from gaps and congestion patterns, not direct proof of intent.',
    ],
    related: ['Supply Chain panel', 'Chokepoint strip', 'Military vessels', 'Country brief AIS signals'],
    evidence: ['docs/features.mdx', 'docs/architecture.mdx', 'src/services/maritime/index.ts', 'scripts/ais-relay.cjs'],
  },
  waterways: {
    key: 'waterways',
    coverage: 'curated',
    category: 'Maritime',
    purpose: 'Marks strategic waterways and chokepoints so disruption signals can be interpreted against fixed maritime geography.',
    source: 'WorldMonitor strategic-waterways registry with supply-chain chokepoint status overlays from AIS, NGA warnings, and PortWatch-derived feeds.',
    freshness: 'Waterway locations are static; live chokepoint status is warm-pinged every 30 minutes and transit summaries refresh every 10 minutes when the relay/PortWatch path is healthy.',
    confidence: 'High for fixed geography; live disruption confidence depends on the companion AIS, NGA, and PortWatch feeds.',
    limitations: [
      'A visible chokepoint marker does not mean there is an active disruption.',
      'Area geofences and modeled routes can simplify complex traffic patterns.',
    ],
    related: ['Supply Chain panel', 'Trade Routes layer', 'Route Explorer', 'Scenario Engine'],
    evidence: ['docs/architecture.mdx', 'docs/data-sources.mdx', 'src/config/geo.ts', 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'],
  },
  tradeRoutes: {
    key: 'tradeRoutes',
    coverage: 'curated',
    category: 'Maritime',
    purpose: 'Draws major container, energy, and bulk routes through strategic chokepoints for disruption-path reasoning.',
    source: 'WorldMonitor trade-route registry plus supply-chain chokepoint status and transit summaries.',
    freshness: 'Route geometry is static. Chokepoint status is warm-pinged every 30 minutes and transit summaries refresh every 10 minutes through supply-chain caches and relay paths.',
    confidence: 'Good for route-level exposure context; not a ship-level routing feed.',
    limitations: [
      'Routes are modeled corridors and may not match a specific voyage plan.',
      'Disruption overlays depend on current chokepoint and AIS health.',
    ],
    related: ['Supply Chain panel', 'Route Explorer', 'Scenario Engine', 'Waterways layer'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/trade-routes.ts', 'src/services/supply-chain/index.ts'],
  },
  cyberThreats: {
    key: 'cyberThreats',
    coverage: 'curated',
    category: 'Cyber',
    purpose: 'Maps geo-enriched indicators of compromise such as C2 servers, malware hosts, phishing, malicious URLs, and ransomware infrastructure.',
    source: 'abuse.ch Feodo Tracker and URLhaus, C2IntelFeeds, AlienVault OTX, AbuseIPDB, ransomware.live RSS/news feed, and IP geolocation enrichment.',
    freshness: 'Cyber threat seeds run every 2 hours; displayed IOCs use a 14-day rolling window and are capped for map performance.',
    confidence: 'Good for infrastructure visibility, but attribution and IP geolocation can be noisy.',
    limitations: [
      'IP geolocation can point to hosting infrastructure rather than an operator or victim.',
      'Feed availability, API keys, and per-feed abuse reports can bias coverage.',
    ],
    related: ['Cyber Threats map popups', 'CII cyber supplemental boost', 'Data freshness status'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'scripts/seed-cyber-threats.mjs', 'server/worldmonitor/cyber/v1/list-cyber-threats.ts'],
  },
  hotspots: {
    key: 'hotspots',
    coverage: 'curated',
    category: 'News / Hotspots',
    purpose: 'Highlights monitored geopolitical hotspots and raises their level when related news and escalation signals converge.',
    source: 'WorldMonitor hotspot registry, RSS/GDELT news intelligence, hotspot escalation scoring, military activity, and CII context.',
    freshness: 'Hotspot locations are curated/static. News feeds are freshness-tracked separately; live-news RSS cache expectations are around 5 minutes, while GDELT intelligence has longer seeded/cache budgets.',
    confidence: 'Useful as a triage cue, not a citation-grade claim without opening the underlying news and country context.',
    limitations: [
      'News volume and keyword matching can overrepresent highly covered regions.',
      'Low-profile events may be missed when RSS/GDELT coverage is sparse or delayed.',
    ],
    related: ['Live News panel', 'Strategic Risk panel', 'Country brief', 'Hotspot popups'],
    evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/geo.ts', 'src/services/hotspot-escalation.ts'],
  },
};

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  full: [
    'iranAttacks', 'hotspots', 'conflicts',
    'bases', 'nuclear', 'irradiators', 'radiationWatch', 'spaceports',
    'cables', 'pipelines', 'storageFacilities', 'fuelShortages', 'datacenters', 'military',
    'ais', 'tradeRoutes', 'flights', 'protests',
    'ucdpEvents', 'displacement', 'climate', 'weather',
    'outages', 'cyberThreats', 'natural', 'fires',
    'waterways', 'economic', 'minerals', 'gpsJamming',
    'satellites', 'ciiChoropleth', 'resilienceScore', 'sanctions', 'dayNight', 'webcams',
    'diseaseOutbreaks',
  ],
  tech: [
    'startupHubs', 'techHQs', 'accelerators', 'cloudRegions',
    'datacenters', 'cables', 'outages', 'cyberThreats',
    'techEvents', 'resilienceScore', 'natural', 'fires', 'dayNight',
  ],
  finance: [
    'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs',
    'gulfInvestments', 'tradeRoutes', 'cables', 'pipelines',
    'outages', 'weather', 'economic', 'waterways',
    'resilienceScore', 'natural', 'cyberThreats', 'sanctions', 'dayNight',
  ],
  happy: [
    'positiveEvents', 'kindness', 'happiness', 'resilienceScore',
    'speciesRecovery', 'renewableInstallations',
  ],
  commodity: [
    'miningSites', 'processingPlants', 'commodityPorts', 'commodityHubs',
    'minerals', 'pipelines', 'waterways', 'tradeRoutes',
    'ais', 'economic', 'fires', 'climate',
    'resilienceScore', 'natural', 'weather', 'outages', 'sanctions', 'dayNight',
  ],
  energy: [
    // Core energy infrastructure — mirror of ENERGY_MAP_LAYERS in panels.ts
    'pipelines', 'storageFacilities', 'fuelShortages', 'waterways', 'commodityPorts', 'commodityHubs',
    'ais', 'liveTankers', 'tradeRoutes', 'minerals',
    // Energy-adjacent context
    'sanctions', 'fires', 'climate', 'weather', 'outages', 'natural',
    'resilienceScore', 'dayNight',
  ],
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function getLayersForVariant(variant: MapVariant, renderer: MapRenderer): LayerDefinition[] {
  const keys = VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full;
  return keys
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d.renderers.includes(renderer));
}

export function getAllowedLayerKeys(variant: MapVariant): Set<keyof MapLayers> {
  return new Set(VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full);
}

export function sanitizeLayersForVariant(layers: MapLayers, variant: MapVariant): MapLayers {
  const allowed = getAllowedLayerKeys(variant);
  const sanitized = { ...layers };
  for (const key of Object.keys(sanitized) as Array<keyof MapLayers>) {
    if (!allowed.has(key)) sanitized[key] = false;
  }
  return sanitized;
}

/**
 * Checks whether a layer can actually render under the given renderer +
 * DeckGL state. Used by both the layer picker UI and the CMD+K dispatcher
 * to hide / silently-skip toggles that would be a no-op.
 *
 * Rules:
 *   - The layer's declared `renderers` must include `currentRenderer`
 *     (catches globe toggles for flat-only layers).
 *   - If `deckGLOnly: true`, the SVG/mobile fallback can't render either,
 *     so DeckGL must be active (catches flat-only layers whose data
 *     shape is DeckGL-specific — see storageFacilities, fuelShortages).
 */
export function isLayerExecutable(
  layerKey: keyof MapLayers,
  currentRenderer: MapRenderer,
  isDeckGLActive: boolean,
): boolean {
  const def = LAYER_REGISTRY[layerKey];
  if (!def) return false;
  if (!def.renderers.includes(currentRenderer)) return false;
  if (def.deckGLOnly && !isDeckGLActive) return false;
  return true;
}

export const LAYER_SYNONYMS: Record<string, Array<keyof MapLayers>> = {
  aviation: ['flights'],
  flight: ['flights'],
  airplane: ['flights'],
  plane: ['flights'],
  notam: ['flights'],
  ship: ['ais', 'tradeRoutes'],
  vessel: ['ais'],
  maritime: ['ais', 'waterways', 'tradeRoutes'],
  sea: ['ais', 'waterways', 'cables'],
  ocean: ['cables', 'waterways'],
  war: ['conflicts', 'ucdpEvents', 'military'],
  battle: ['conflicts', 'ucdpEvents'],
  army: ['military', 'bases'],
  navy: ['military', 'ais'],
  missile: ['iranAttacks', 'military'],
  nuke: ['nuclear'],
  radiation: ['radiationWatch', 'nuclear', 'irradiators'],
  radnet: ['radiationWatch'],
  safecast: ['radiationWatch'],
  anomaly: ['radiationWatch', 'climate'],
  space: ['spaceports', 'satellites'],
  orbit: ['satellites'],
  internet: ['outages', 'cables', 'cyberThreats'],
  cyber: ['cyberThreats', 'outages'],
  hack: ['cyberThreats'],
  earthquake: ['natural'],
  volcano: ['natural'],
  tsunami: ['natural'],
  storm: ['weather', 'natural'],
  hurricane: ['weather', 'natural'],
  typhoon: ['weather', 'natural'],
  cyclone: ['weather', 'natural'],
  flood: ['weather', 'natural'],
  wildfire: ['fires'],
  forest: ['fires'],
  refugee: ['displacement'],
  migration: ['displacement'],
  riot: ['protests'],
  demonstration: ['protests'],
  oil: ['pipelines', 'commodityHubs'],
  gas: ['pipelines'],
  energy: ['pipelines', 'renewableInstallations'],
  solar: ['renewableInstallations'],
  wind: ['renewableInstallations'],
  green: ['renewableInstallations', 'speciesRecovery'],
  money: ['economic', 'financialCenters', 'stockExchanges'],
  bank: ['centralBanks', 'financialCenters'],
  stock: ['stockExchanges'],
  trade: ['tradeRoutes', 'waterways'],
  cloud: ['cloudRegions', 'datacenters'],
  ai: ['datacenters'],
  startup: ['startupHubs', 'accelerators'],
  tech: ['techHQs', 'techEvents', 'startupHubs', 'cloudRegions', 'datacenters'],
  gps: ['gpsJamming'],
  jamming: ['gpsJamming'],
  mineral: ['minerals', 'miningSites'],
  mining: ['miningSites'],
  port: ['commodityPorts'],
  happy: ['happiness', 'kindness', 'positiveEvents'],
  good: ['positiveEvents', 'kindness'],
  animal: ['speciesRecovery'],
  wildlife: ['speciesRecovery'],
  gulf: ['gulfInvestments'],
  gcc: ['gulfInvestments'],
  sanction: ['sanctions'],
  night: ['dayNight'],
  sun: ['dayNight'],
  webcam: ['webcams'],
  camera: ['webcams'],
  livecam: ['webcams'],
};

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}

export function hasCuratedLayerExplanation(layerKey: keyof MapLayers): boolean {
  return LAYER_EXPLANATIONS[layerKey]?.coverage === 'curated';
}

export function getLayerExplanation(layerKey: keyof MapLayers): LayerExplanation {
  const curated = LAYER_EXPLANATIONS[layerKey];
  if (curated) return curated;

  return {
    key: layerKey,
    coverage: 'fallback',
    category: 'Layer',
    purpose: 'This layer can be toggled on the map, but a curated source and confidence card has not been added yet.',
    source: 'Not curated in the v1 layer-explainability set.',
    freshness: 'No layer-level freshness contract is declared here. Check the visible panel badges, popups, or data freshness status when available.',
    confidence: 'Unknown until source-specific metadata is added.',
    limitations: [
      'The lack of a curated card does not mean the layer is unsupported.',
      'Use layer popups and related panels for source-specific context.',
    ],
    related: ['Layer guide'],
    evidence: [],
  };
}

export function bindLayerSearch(container: HTMLElement): void {
  const searchInput = container.querySelector('.layer-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const synonymHits = new Set<string>();
    if (q) {
      for (const [alias, keys] of Object.entries(LAYER_SYNONYMS)) {
        if (alias.includes(q)) keys.forEach(k => synonymHits.add(k));
      }
    }
    container.querySelectorAll('.layer-toggle').forEach(label => {
      const el = label as HTMLElement;
      if (el.hasAttribute('data-layer-hidden')) return;
      const row = el.closest('.layer-toggle-row') as HTMLElement | null;
      const displayTarget = row ?? el;
      if (!q) { displayTarget.style.display = ''; return; }
      const key = label.getAttribute('data-layer') || '';
      const text = label.textContent?.toLowerCase() || '';
      const match = text.includes(q) || key.toLowerCase().includes(q) || synonymHits.has(key);
      displayTarget.style.display = match ? '' : 'none';
    });
  });
}
