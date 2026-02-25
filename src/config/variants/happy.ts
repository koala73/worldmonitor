// Happy variant - happy.worldmonitor.app
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Panel configuration for happy/positive news dashboard
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'World Map', enabled: true, priority: 1 },
  'positive-feed': { name: 'Good News Feed', enabled: true, priority: 1 },
  progress: { name: 'Human Progress', enabled: true, priority: 1 },
  counters: { name: 'Live Counters', enabled: true, priority: 1 },
  spotlight: { name: "Today's Hero", enabled: true, priority: 1 },
  breakthroughs: { name: 'Breakthroughs', enabled: true, priority: 1 },
  digest: { name: '5 Good Things', enabled: true, priority: 1 },
  species: { name: 'Conservation Wins', enabled: true, priority: 1 },
  renewable: { name: 'Renewable Energy', enabled: true, priority: 1 },
};

// Map layers — all geopolitical overlays disabled; natural events only
export const DEFAULT_MAP_LAYERS: MapLayers = {
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: false,
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
  // Tech layers (disabled)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers (disabled)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: true,
  kindness: true,
  happiness: true,
  speciesRecovery: true,
  renewableInstallations: true,
  tradeRoutes: false,
};

// Mobile defaults — same as desktop for happy variant
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: false,
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
  // Tech layers (disabled)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers (disabled)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: true,
  kindness: true,
  happiness: true,
  speciesRecovery: true,
  renewableInstallations: true,
  tradeRoutes: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'happy',
  description: 'Good news and global progress dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
