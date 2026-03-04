import type { MapLayers } from '@/types';

export type MapRenderer = 'flat' | 'globe';
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy';

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  renderers: MapRenderer[];
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: MapRenderer[] = ['flat', 'globe'],
): LayerDefinition => ({ key, icon, i18nSuffix, fallbackLabel, renderers });

export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  iranAttacks:              def('iranAttacks',              '&#127919;', 'iranAttacks',              'Iran Attacks'),
  hotspots:                 def('hotspots',                 '&#127919;', 'intelHotspots',            'Intel Hotspots'),
  conflicts:                def('conflicts',                '&#9876;',   'conflictZones',            'Conflict Zones'),
  geopoliticalBoundaries:   def('geopoliticalBoundaries',   '&#9878;',   'geopoliticalBoundaries',   'Geopolitical Boundaries'),
  bases:                    def('bases',                    '&#127963;', 'militaryBases',            'Military Bases'),
  nuclear:                  def('nuclear',                  '&#9762;',   'nuclearSites',             'Nuclear Sites'),
  irradiators:              def('irradiators',              '&#9888;',   'gammaIrradiators',         'Gamma Irradiators'),
  spaceports:               def('spaceports',               '&#128640;', 'spaceports',               'Spaceports'),
  cables:                   def('cables',                   '&#128268;', 'underseaCables',           'Undersea Cables'),
  pipelines:                def('pipelines',                '&#128738;', 'pipelines',                'Pipelines'),
  datacenters:              def('datacenters',              '&#128421;', 'aiDataCenters',            'AI Data Centers'),
  military:                 def('military',                 '&#9992;',   'militaryActivity',         'Military Activity'),
  ais:                      def('ais',                      '&#128674;', 'shipTraffic',              'Ship Traffic'),
  tradeRoutes:              def('tradeRoutes',              '&#9875;',   'tradeRoutes',              'Trade Routes'),
  flights:                  def('flights',                  '&#9992;',   'flightDelays',             'Flight Delays'),
  protests:                 def('protests',                 '&#128226;', 'protests',                 'Protests'),
  ucdpEvents:               def('ucdpEvents',               '&#9876;',   'ucdpEvents',               'Armed Conflict Events'),
  displacement:             def('displacement',             '&#128101;', 'displacementFlows',        'Displacement Flows'),
  climate:                  def('climate',                  '&#127787;', 'climateAnomalies',         'Climate Anomalies'),
  weather:                  def('weather',                  '&#9928;',   'weatherAlerts',            'Weather Alerts'),
  outages:                  def('outages',                  '&#128225;', 'internetOutages',          'Internet Outages'),
  cyberThreats:             def('cyberThreats',             '&#128737;', 'cyberThreats',             'Cyber Threats'),
  natural:                  def('natural',                  '&#127755;', 'naturalEvents',            'Natural Events'),
  fires:                    def('fires',                    '&#128293;', 'fires',                    'Fires'),
  waterways:                def('waterways',                '&#9875;',   'strategicWaterways',       'Strategic Waterways'),
  economic:                 def('economic',                 '&#128176;', 'economicCenters',          'Economic Centers'),
  minerals:                 def('minerals',                 '&#128142;', 'criticalMinerals',         'Critical Minerals'),
  gpsJamming:               def('gpsJamming',               '&#128225;', 'gpsJamming',               'GPS Jamming'),
  ciiChoropleth:            def('ciiChoropleth',            '&#127758;', 'ciiChoropleth',            'CII Instability'),
  dayNight:                 def('dayNight',                 '&#127763;', 'dayNight',                 'Day/Night', ['flat']),
  sanctions:                def('sanctions',                '&#128683;', 'sanctions',                'Sanctions', []),
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
};

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  full: [
    'iranAttacks', 'hotspots', 'conflicts', 'geopoliticalBoundaries',
    'bases', 'nuclear', 'irradiators', 'spaceports',
    'cables', 'pipelines', 'datacenters', 'military',
    'ais', 'tradeRoutes', 'flights', 'protests',
    'ucdpEvents', 'displacement', 'climate', 'weather',
    'outages', 'cyberThreats', 'natural', 'fires',
    'waterways', 'economic', 'minerals', 'gpsJamming',
    'ciiChoropleth', 'dayNight',
  ],
  tech: [
    'startupHubs', 'techHQs', 'accelerators', 'cloudRegions',
    'datacenters', 'cables', 'outages', 'cyberThreats',
    'techEvents', 'natural', 'fires', 'dayNight',
  ],
  finance: [
    'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs',
    'gulfInvestments', 'tradeRoutes', 'cables', 'pipelines',
    'outages', 'weather', 'economic', 'waterways',
    'natural', 'cyberThreats', 'dayNight',
  ],
  happy: [
    'positiveEvents', 'kindness', 'happiness',
    'speciesRecovery', 'renewableInstallations',
  ],
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function getLayersForVariant(variant: MapVariant, renderer: MapRenderer): LayerDefinition[] {
  const keys = VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full;
  return keys
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d.renderers.includes(renderer));
}

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}
