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
  resilienceScore:          def('resilienceScore',          '&#128200;', 'resilienceScore',          'Resilience', ['flat'], 'locked'),
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
  diseaseOutbreaks:         def('diseaseOutbreaks',         '&#129440;', 'diseaseOutbreaks',         'Disease Outbreaks'),
  // DeckGL-only layers. `renderers: ['flat']` hides them from the globe
  // picker (GlobeMap has no branch in ensureStaticDataForLayer / no entry
  // in the layer-channel map). `deckGLOnly: true` also hides them from
  // the SVG/mobile fallback's CMD+K dispatch (Map.ts has no SVG render
  // path for either marker/pin type). Restore to `['flat', 'globe']`
  // without `deckGLOnly` once both renderers gain real support.
  storageFacilities:        def('storageFacilities',        '&#127959;', 'storageFacilities',        'Storage Facilities', ['flat'], undefined, true),
  fuelShortages:            def('fuelShortages',            '&#9881;',   'fuelShortages',            'Fuel Shortages', ['flat'], undefined, true),
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
    'ais', 'tradeRoutes', 'minerals',
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
      if (!q) { el.style.display = ''; return; }
      const key = label.getAttribute('data-layer') || '';
      const text = label.textContent?.toLowerCase() || '';
      const match = text.includes(q) || key.toLowerCase().includes(q) || synonymHits.has(key);
      el.style.display = match ? '' : 'none';
    });
  });
}
