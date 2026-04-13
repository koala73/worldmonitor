// Sports variant - sports.worldmonitor.app
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Panel configuration for multi-sport news and live data
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Sports Map', enabled: true, priority: 1 },
  sports: { name: 'Sports Headlines', enabled: true, priority: 1 },
  'sports-nba-analysis': { name: 'NBA AI Analysis', enabled: true, priority: 1 },
  'sports-football-analysis': { name: 'European Football AI', enabled: true, priority: 1 },
  'sports-motorsport-analysis': { name: 'Motorsport AI', enabled: true, priority: 1 },
  'sports-tournaments': { name: 'Major Tournaments', enabled: true, priority: 1 },
  'sports-tables': { name: 'League Table', enabled: true, priority: 1 },
  'sports-nba': { name: 'NBA Standings', enabled: true, priority: 1 },
  'sports-motorsport-standings': { name: 'Motorsport Scores', enabled: true, priority: 1 },
  'sports-stats': { name: 'Match Stats', enabled: true, priority: 1 },
  'sports-live-tracker': { name: 'Live Fixture Tracker', enabled: true, priority: 1 },
  'sports-transfers': { name: 'Transfer News', enabled: true, priority: 1 },
  'sports-player-search': { name: 'Player Search', enabled: true, priority: 1 },
  soccer: { name: 'Football', enabled: true, priority: 1 },
  basketball: { name: 'Basketball', enabled: true, priority: 1 },
  baseball: { name: 'Baseball', enabled: true, priority: 2 },
  motorsport: { name: 'Motorsport', enabled: true, priority: 2 },
  tennis: { name: 'Tennis', enabled: true, priority: 2 },
  combat: { name: 'Combat Sports', enabled: true, priority: 2 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// Map layers — sports keeps the map minimal with only the day/night overlay enabled.
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
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  sportsFixtures: true,
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
  iranAttacks: false,
  ciiChoropleth: false,
  resilienceScore: false,
  dayNight: true,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
  diseaseOutbreaks: false,
};

// Mobile defaults — same as desktop for the sports variant.
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  ...DEFAULT_MAP_LAYERS,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'sports',
  description: 'Multi-sport dashboard for headlines, fixtures, tables, and live stats',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
