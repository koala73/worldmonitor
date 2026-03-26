import type { PanelConfig, MapLayers } from '@/types';
import type { DataSourceId } from '@/services/data-freshness';
import { isDesktopRuntime } from '@/services/runtime';

const _desktop = isDesktopRuntime();

// ============================================
// PANELS — Geopolitical Conflict & Economic Impact
// ============================================
// Panel order matters! First panels appear at top of grid.
const FULL_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  'strategic-posture': { name: 'AI Strategic Posture', enabled: true, priority: 1 },
  cii: { name: 'Country Instability', enabled: true, priority: 1, ...(_desktop && { premium: 'enhanced' as const }) },
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1, ...(_desktop && { premium: 'enhanced' as const }) },
  intel: { name: 'Intel Feed', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1, ...(_desktop && { premium: 'enhanced' as const }) },
  cascade: { name: 'Infrastructure Cascade', enabled: true, priority: 1 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  us: { name: 'United States', enabled: true, priority: 1 },
  europe: { name: 'Europe', enabled: true, priority: 1 },
  middleeast: { name: 'Middle East', enabled: true, priority: 1 },
  africa: { name: 'Africa', enabled: true, priority: 1 },
  latam: { name: 'Latin America', enabled: true, priority: 1 },
  asia: { name: 'Asia-Pacific', enabled: true, priority: 1 },
  energy: { name: 'Energy & Resources', enabled: true, priority: 1 },
  gov: { name: 'Government', enabled: true, priority: 1 },
  thinktanks: { name: 'Think Tanks', enabled: true, priority: 1 },
  commodities: { name: 'Commodities', enabled: true, priority: 1 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  economic: { name: 'Economic Indicators', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1, ...(_desktop && { premium: 'enhanced' as const }) },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  'gulf-economies': { name: 'Gulf Economies', enabled: false, priority: 2 },
  'ucdp-events': { name: 'UCDP Conflict Events', enabled: true, priority: 2 },
  displacement: { name: 'UNHCR Displacement', enabled: true, priority: 2 },
  'population-exposure': { name: 'Population Exposure', enabled: true, priority: 2 },
  'security-advisories': { name: 'Security Advisories', enabled: true, priority: 2 },
  'oref-sirens': { name: 'Israel Sirens', enabled: true, priority: 2, ...(_desktop && { premium: 'locked' as const }) },
  'telegram-intel': { name: 'Telegram Intel', enabled: true, priority: 2, ...(_desktop && { premium: 'locked' as const }) },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// ============================================
// MAP LAYERS — Geopolitical Conflict & Economic Impact
// ============================================
const FULL_MAP_LAYERS: MapLayers = {
  iranAttacks: _desktop ? false : true,
  gpsJamming: false,
  satellites: false,

  conflicts: true,
  bases: _desktop ? false : true,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: true,
  irradiators: false,
  sanctions: true,
  weather: false,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: true,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Disabled variant layers (kept for type compatibility)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
};

const FULL_MOBILE_MAP_LAYERS: MapLayers = {
  iranAttacks: true,
  gpsJamming: false,
  satellites: false,

  conflicts: true,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: true,
  weather: false,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Disabled variant layers (kept for type compatibility)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
};

// ============================================
// EXPORTS
// ============================================
export const DEFAULT_PANELS = FULL_PANELS;

export const DEFAULT_MAP_LAYERS = FULL_MAP_LAYERS;

export const MOBILE_DEFAULT_MAP_LAYERS = FULL_MOBILE_MAP_LAYERS;

/** Maps map-layer toggle keys to their data-freshness source IDs (single source of truth). */
export const LAYER_TO_SOURCE: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
  military: ['opensky', 'wingbits'],
  ais: ['ais'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
  protests: ['acled', 'gdelt_doc'],
  ucdpEvents: ['ucdp_events'],
  displacement: ['unhcr'],
};

// ============================================
// PANEL CATEGORY MAP
// ============================================
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[]; variants?: string[] }> = {
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'live-news', 'insights', 'strategic-posture'],
  },
  intelligence: {
    labelKey: 'header.panelCatIntelligence',
    panelKeys: ['cii', 'strategic-risk', 'intel', 'gdelt-intel', 'cascade', 'telegram-intel'],
  },
  regionalNews: {
    labelKey: 'header.panelCatRegionalNews',
    panelKeys: ['politics', 'us', 'europe', 'middleeast', 'africa', 'latam', 'asia'],
  },
  marketsFinance: {
    labelKey: 'header.panelCatMarketsFinance',
    panelKeys: ['commodities', 'markets', 'economic', 'trade-policy', 'supply-chain', 'macro-signals', 'gulf-economies'],
  },
  topical: {
    labelKey: 'header.panelCatTopical',
    panelKeys: ['energy', 'gov', 'thinktanks'],
  },
  dataTracking: {
    labelKey: 'header.panelCatDataTracking',
    panelKeys: ['monitors', 'ucdp-events', 'displacement', 'population-exposure', 'security-advisories', 'oref-sirens'],
  },
};

// Monitor palette — fixed category colors persisted to localStorage (not theme-dependent)
export const MONITOR_COLORS = [
  '#44ff88',
  '#ff8844',
  '#4488ff',
  '#ff44ff',
  '#ffff44',
  '#ff4444',
  '#44ffff',
  '#88ff44',
  '#ff88ff',
  '#88ffff',
];

export const STORAGE_KEYS = {
  panels: 'worldmonitor-panels',
  monitors: 'worldmonitor-monitors',
  mapLayers: 'worldmonitor-layers',
  disabledFeeds: 'worldmonitor-disabled-feeds',
} as const;
