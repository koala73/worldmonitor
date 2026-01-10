import type { PanelConfig, MapLayers } from '@/types';

export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  middleeast: { name: 'Middle East', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 1 },
  ai: { name: 'AI/ML', enabled: true, priority: 1 },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 1 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  monitors: { name: 'My Monitors', enabled: true, priority: 1 },
  commodities: { name: 'Commodities', enabled: true, priority: 2 },
  polymarket: { name: 'Predictions', enabled: true, priority: 2 },
  gov: { name: 'Government', enabled: true, priority: 2 },
  intel: { name: 'Intel Feed', enabled: true, priority: 2 },
  crypto: { name: 'Crypto', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: true, priority: 2 },
  congress: { name: 'Congress Trades', enabled: true, priority: 2 },
  thinktanks: { name: 'Think Tanks', enabled: true, priority: 2 },
};

export const DEFAULT_MAP_LAYERS: MapLayers = {
  conflicts: true,
  bases: true,
  cables: true,
  pipelines: false,
  hotspots: true,
  protests: true,
  nuclear: true,
  irradiators: false,
  sanctions: true,
  earthquakes: true,
  weather: true,
  economic: true,
  countries: false,
  waterways: false,
  outages: true,
  datacenters: false,
};

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
} as const;
