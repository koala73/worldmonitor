// Happy variant - happy.worldmonitor.app
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Panel configuration for happy/positive news dashboard
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'グローバル情勢', enabled: true, priority: 1 },
  'positive-feed': { name: 'グッドニュース', enabled: true, priority: 1 },
  progress: { name: '人類の進歩', enabled: true, priority: 1 },
  counters: { name: 'ライブ指標', enabled: true, priority: 1 },
  spotlight: { name: '今日のヒーロー', enabled: true, priority: 1 },
  breakthroughs: { name: 'ブレークスルー', enabled: true, priority: 1 },
  digest: { name: '今日の良いこと5選', enabled: true, priority: 1 },
  species: { name: '保全の成果', enabled: true, priority: 1 },
  renewable: { name: '再生可能エネルギー', enabled: true, priority: 1 },
};

// Map layers — all geopolitical overlays disabled; natural events only
export const DEFAULT_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  satellites: false,


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
  iranAttacks: false,
  ciiChoropleth: false,
  resilienceScore: false,
  dayNight: false,
  // Commodity variant layers (disabled in happy variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
  diseaseOutbreaks: false,
};

// Mobile defaults — same as desktop for happy variant
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  satellites: false,


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
  iranAttacks: false,
  ciiChoropleth: false,
  resilienceScore: false,
  dayNight: false,
  // Commodity variant layers (disabled in happy variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
  diseaseOutbreaks: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'happy',
  description: 'Good news and global progress dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
